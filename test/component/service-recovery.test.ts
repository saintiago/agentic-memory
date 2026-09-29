import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ControlledProviders,
  postJson,
  record,
  requestJson,
  startServiceHarness,
  uuid,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Component tests for the service's durability boundary: a lost HTTP acknowledgement, accepted
 * work that a provider outage held across a restart, and an interrupted multi-record apply that a
 * new process replays from the persisted plan before later mutations.
 *
 * See docs/service.md#migration-and-verification and
 * docs/ingestion-queue.md#crash-recovery.
 */

const directories: string[] = [];
const harnesses: ServiceHarness[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "amem-service-recovery-"),
  );
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const receiptStatus = async (
  harness: ServiceHarness,
  id: string,
): Promise<string> => {
  const response = await requestJson(harness.url(`/v1/receipts/${id}`));
  return (response.body as { status: string }).status;
};

describe("service durability", () => {
  it("resolves a lost HTTP acknowledgement by resubmitting the identical observation", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const observation = {
      sourceKey: "lost-acknowledgement",
      content: "An observation whose response was lost.",
    };
    const body = JSON.stringify(observation);

    // Send a complete request but never read the answer, as a client that lost its response does.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(harness.runtime.port, "127.0.0.1", () => {
        socket.write(
          `POST /v1/observations HTTP/1.1\r\n` +
            `host: 127.0.0.1:${String(harness.runtime.port)}\r\n` +
            `content-type: application/json\r\n` +
            `content-length: ${String(Buffer.byteLength(body))}\r\n` +
            `connection: close\r\n\r\n${body}`,
        );
        resolve();
      });
      socket.once("error", reject);
    });

    await waitFor(async () => {
      const status = await requestJson(harness.url("/v1/status"));
      return (
        (status.body as { queue: { accepted: number } }).queue.accepted === 1
      );
    }, "the lost response's observation to be durably accepted");

    const resubmitted = await postJson(harness.url("/v1/observations"), {
      ...observation,
    });
    expect(resubmitted.status).toBe(200);
    const status = await requestJson(harness.url("/v1/status"));
    expect(
      (status.body as { queue: { accepted: number } }).queue.accepted,
    ).toBe(1);
  });

  it("resumes accepted work after a restart once the provider recovers", async () => {
    const directory = await temporaryDirectory();
    const failing = new ControlledProviders();
    failing.model.failAll = new Error("the model provider is down");
    const first = await startServiceHarness({
      providers: failing,
      dataDirectory: directory,
    });
    const accepted = await postJson(first.url("/v1/observations"), {
      sourceKey: "restart-source",
      content: "An observation accepted during the outage.",
      timestamp: "2026-09-27T15:44:27.001+02:00",
    });
    expect(accepted.status).toBe(202);
    const receipt = accepted.body as { id: string };
    await waitFor(
      async () => (await receiptStatus(first, receipt.id)) === "retrying",
      "the outage to hold the accepted observation",
    );
    await first.runtime.stop();

    const recovered = new ControlledProviders();
    const second = await startServiceHarness({
      providers: recovered,
      dataDirectory: directory,
    });
    harnesses.push(second);
    await waitFor(
      async () => (await receiptStatus(second, receipt.id)) === "stored",
      "the restarted service to store the accepted observation",
    );
    const stored = await requestJson(second.url(`/v1/receipts/${receipt.id}`));
    const noteId = (stored.body as { noteId: string }).noteId;
    expect(recovered.store.stored(noteId)?.content).toBe(
      "An observation accepted during the outage.",
    );
    // The identity and observation time were fixed at acceptance and survive the restart.
    expect(recovered.store.stored(noteId)?.timestamp).toBe(
      "2026-09-27T15:44:27.001+02:00",
    );
  });

  it("replays a partially applied plan exactly on the next service start", async () => {
    const directory = await temporaryDirectory();
    const interrupted = new ControlledProviders();
    interrupted.store.seed(record(9));
    interrupted.model.evolution = {
      links: [],
      newTags: ["tag"],
      updates: [
        {
          id: uuid(9),
          context: "Evolved by the interrupted insertion.",
          keywords: ["keyword"],
          tags: ["tag"],
        },
      ],
    };
    interrupted.store.partialWriteFailures.push(
      new Error("the storage acknowledgement was lost"),
    );
    const first = await startServiceHarness({
      providers: interrupted,
      dataDirectory: directory,
    });
    const accepted = await postJson(first.url("/v1/observations"), {
      sourceKey: "partial-plan",
      content: "An observation with an interrupted apply.",
    });
    expect(accepted.status).toBe(202);
    const receipt = accepted.body as { id: string };
    await waitFor(
      async () => (await receiptStatus(first, receipt.id)) === "retrying",
      "the interrupted apply to be retried later",
    );
    // The partial write changed the neighbor but never wrote the incoming note.
    expect(interrupted.store.stored(uuid(9))?.context).toBe(
      "Evolved by the interrupted insertion.",
    );
    expect(interrupted.store.writes).toHaveLength(0);
    await first.runtime.stop();

    const recovered = new ControlledProviders();
    const second = await startServiceHarness({
      providers: recovered,
      dataDirectory: directory,
    });
    harnesses.push(second);
    await waitFor(
      async () => (await receiptStatus(second, receipt.id)) === "stored",
      "the restarted service to replay the persisted plan",
    );
    const storedReceipt = await requestJson(
      second.url(`/v1/receipts/${receipt.id}`),
    );
    const noteId = (storedReceipt.body as { noteId: string }).noteId;
    // The exact plan was applied without asking the model again.
    expect(recovered.model.requests).toHaveLength(0);
    expect(recovered.store.writes).toHaveLength(1);
    const applied = recovered.store.writes[0] ?? [];
    expect(applied.map((entry) => entry.note.id).sort()).toEqual(
      [noteId, uuid(9)].sort(),
    );
    // One batch shares one preparation time; the replay preserved it.
    expect(applied[0]?.note.updatedAt).toBe(applied[1]?.note.updatedAt);
    expect(recovered.store.stored(noteId)?.content).toBe(
      "An observation with an interrupted apply.",
    );
  });
});
