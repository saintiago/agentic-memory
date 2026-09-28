import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHostModelTransport,
  type HostModelTransportOptions,
} from "../../examples/host-model-transport.js";
import {
  AgenticMemory,
  openIngestionQueue,
  type IngestionQueue,
  type QueueReceipt,
} from "../../src/index.js";
import {
  ControlledEmbedder,
  RecordingStore,
  flush,
} from "./support/memory-harness.js";

/**
 * Component test for the failure classification the queue applies to the host-supplied model
 * transport: a rejected credential blocks the queue with an actionable diagnostic, unusable output
 * fails the receipt permanently, and a temporary provider outage is retried. The queue must react
 * to the transport's machine-readable category rather than to provider text, which can echo the
 * configured credential.
 *
 * See docs/ingestion-queue.md#writer-lifecycle-and-retries and
 * docs/language-model.md#transport-behavior.
 */

/** A credential-shaped marker that no public diagnostic may repeat. */
const CREDENTIAL_MARKER = "sk-live-CREDENTIAL-MARKER-0123456789";

type FetchStub = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
) => Promise<Response>;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const completion = (content: string): Response =>
  jsonResponse({
    choices: [{ finish_reason: "stop", message: { content } }],
  });

const constructionAttributes = '{"context":"c","keywords":["k"],"tags":["t"]}';

interface Harness {
  readonly queue: IngestionQueue;
  readonly store: RecordingStore;
  readonly directory: string;
}

const temporaryDirectories: string[] = [];
const openQueues: IngestionQueue[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const queue of openQueues.splice(0)) {
    await queue.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const createHarness = async (fetch: FetchStub): Promise<Harness> => {
  const store = new RecordingStore();
  const embedder = new ControlledEmbedder();
  const memory = new AgenticMemory(
    store,
    embedder,
    createHostModelTransport({
      endpoint: "https://provider.example/v1/chat/completions",
      model: "provider-model",
      apiKey: CREDENTIAL_MARKER,
      timeoutMs: 10_000,
      maxOutputTokens: 512,
      fetch,
    } satisfies HostModelTransportOptions),
  );
  const directory = await mkdtemp(path.join(tmpdir(), "amem-queue-model-"));
  temporaryDirectories.push(directory);
  const queue = await openIngestionQueue({
    directory,
    binding: {
      endpoint: "http://127.0.0.1:6333",
      collection: "memories",
      embeddingSpace: { ...embedder.space },
    },
    memory,
    pollIntervalMs: 10,
  });
  openQueues.push(queue);
  return { queue, store, directory };
};

const settle = async (
  condition: () => boolean | Promise<boolean>,
  description: string,
  limitMs = 10_000,
): Promise<void> => {
  for (let elapsed = 0; elapsed <= limitMs; elapsed += 10) {
    if (await condition()) {
      return;
    }
    await vi.advanceTimersByTimeAsync(10);
    await flush();
  }
  throw new Error(`Timed out waiting for ${description}.`);
};

const receiptOf = async (
  queue: IngestionQueue,
  id: string,
): Promise<QueueReceipt> => {
  const receipt = await queue.receipt(id);
  if (receipt === undefined) {
    throw new Error(`The queue has no receipt ${id}.`);
  }
  return receipt;
};

/** The retry backoff runs on a controlled clock; no test sleeps on a real provider outage. */
beforeEach(() => {
  vi.useFakeTimers();
});

describe("model transport failure classification", () => {
  it("blocks on a rejected credential and drains once the host corrects it", async () => {
    let status = 401;
    const harness = await createHarness(async () =>
      status === 200
        ? completion(constructionAttributes)
        : jsonResponse(
            { error: { message: `Unauthorized ${CREDENTIAL_MARKER}` } },
            status,
          ),
    );
    await harness.queue.start();
    const accepted = await harness.queue.submit({
      sourceKey: "credential",
      content: "The observation.",
    });

    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "blocked",
      "the rejected credential to block the queue",
    );
    const blocked = await receiptOf(harness.queue, accepted.id);
    expect(blocked.nextRetryAt).toBeDefined();
    expect(blocked.lastError).toContain("credential");
    expect(blocked.lastError).toContain("must be corrected");
    // Untrusted provider text, including the credential it echoed, never reaches the queue.
    expect(blocked.lastError).not.toContain(CREDENTIAL_MARKER);
    expect(harness.store.writes).toEqual([]);

    status = 200;
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the corrected credential to let the queue drain",
    );
    expect(harness.store.writes).toHaveLength(1);
  });

  it("fails a receipt permanently when the provider answers with unusable output", async () => {
    const harness = await createHarness(async () =>
      completion("not JSON at all"),
    );
    await harness.queue.start();
    const accepted = await harness.queue.submit({
      sourceKey: "unusable",
      content: "The observation.",
    });

    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "failed",
      "the unusable output to fail the receipt",
    );
    const failed = await receiptOf(harness.queue, accepted.id);
    expect(failed.nextRetryAt).toBeUndefined();
    expect(failed.lastError).toContain("cannot use");
    expect(failed.attemptCount).toBe(1);

    // A permanent failure neither holds the backlog nor repeats the provider call.
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await receiptOf(harness.queue, accepted.id)).attemptCount).toBe(1);
    expect(harness.store.writes).toEqual([]);
  });

  it("fails a receipt whose provider answer has the wrong shape", async () => {
    const harness = await createHarness(async () =>
      completion('{"context":"Only a context."}'),
    );
    await harness.queue.start();
    const accepted = await harness.queue.submit({
      sourceKey: "wrong-shape",
      content: "The observation.",
    });

    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "failed",
      "the wrong-shaped answer to fail the receipt",
    );
    const failed = await receiptOf(harness.queue, accepted.id);
    expect(failed.nextRetryAt).toBeUndefined();
    expect(failed.lastError).toBe(
      "The construction response does not satisfy the documented contract.",
    );
    expect(harness.store.writes).toEqual([]);
  });

  it("retries a temporary provider outage with bounded backoff", async () => {
    let status = 503;
    const harness = await createHarness(async () =>
      status === 200
        ? completion(constructionAttributes)
        : jsonResponse(
            { error: { message: "temporarily unavailable" } },
            status,
          ),
    );
    await harness.queue.start();
    const accepted = await harness.queue.submit({
      sourceKey: "outage",
      content: "The observation.",
    });

    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "retrying",
      "the outage to be retried",
    );
    const retrying = await receiptOf(harness.queue, accepted.id);
    expect(retrying.nextRetryAt).toBeDefined();
    expect(retrying.lastError).toContain("temporary model provider failure");
    expect(harness.store.writes).toEqual([]);

    status = 200;
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the outage to end",
    );
    expect(harness.store.writes).toHaveLength(1);
  });
});
