import { afterEach, describe, expect, it } from "vitest";

import { referenceEmbeddingSpace } from "../../src/index.js";
import {
  ControlledProviders,
  postJson,
  requestJson,
  startServiceHarness,
  uuid,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Component tests for the service's availability reporting: the API and its durable queue start
 * before providers, submissions remain durable while reads and ingestion are unavailable, a safe
 * diagnostic replaces the provider's own text, and a successful retry restores the capabilities.
 *
 * See docs/service.md#availability-restart-and-shutdown.
 */

const harnesses: ServiceHarness[] = [];

const openService = async (
  options: Parameters<typeof startServiceHarness>[0],
): Promise<ServiceHarness> => {
  const harness = await startServiceHarness(options);
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

const statusOf = async (
  harness: ServiceHarness,
): Promise<{
  availability: {
    submission: boolean;
    retrieval: boolean;
    ingestion: boolean;
  };
  queue?: { worker: string };
  error?: string;
}> => (await requestJson(harness.url("/v1/status"))).body as never;

describe("provider startup", () => {
  it("keeps submissions durable while the encoder is loading and serves reads afterwards", async () => {
    const providers = new ControlledProviders();
    const gate = providers.holdEmbedder();
    const harness = await openService({
      providers,
      waitForProviders: false,
    });

    const waiting = await statusOf(harness);
    expect(waiting.availability).toEqual({
      submission: true,
      retrieval: false,
      ingestion: false,
    });
    // The durable worker already owns its queue while the encoder loads.
    expect(waiting.queue?.worker).toBe("running");

    const notes = await requestJson(harness.url(`/v1/notes/${uuid(1)}`));
    expect(notes.status).toBe(503);
    expect(
      (notes.body as { error: { retryable: boolean } }).error.retryable,
    ).toBe(true);
    const search = await postJson(harness.url("/v1/search"), {
      query: "anything",
    });
    expect(search.status).toBe(503);

    const accepted = await postJson(harness.url("/v1/observations"), {
      sourceKey: "loading-source",
      content: "An observation accepted before the encoder is ready.",
    });
    expect(accepted.status).toBe(202);
    const receiptId = (accepted.body as { id: string }).id;
    await waitFor(async () => {
      const receipt = await requestJson(
        harness.url(`/v1/receipts/${receiptId}`),
      );
      return (receipt.body as { status: string }).status === "retrying";
    }, "the durable worker to retry while providers are unavailable");

    gate.resolve();
    await waitFor(async () => {
      const status = await statusOf(harness);
      return status.availability.retrieval && status.availability.ingestion;
    }, "the provider stack to become ready");
    await waitFor(async () => {
      const receipt = await requestJson(
        harness.url(`/v1/receipts/${receiptId}`),
      );
      return (receipt.body as { status: string }).status === "stored";
    }, "the accepted observation to be stored after the encoder loads");
    expect(providers.store.writes).toHaveLength(1);
  });

  it("publishes a safe encoder diagnostic and recovers on the next attempt", async () => {
    const providers = new ControlledProviders();
    providers.failEmbedderOnce(
      new Error("credential sk-live-SECRET could not be used"),
    );
    const gate = providers.holdEmbedder();
    const harness = await openService({
      providers,
      waitForProviders: false,
    });

    await waitFor(
      async () => (await statusOf(harness)).error !== undefined,
      "the failed initialization to be reported",
    );
    const failed = await statusOf(harness);
    expect(failed.error).toBe("The pinned encoder could not be loaded.");
    // Provider text, including anything credential-shaped it echoes, never reaches a client.
    expect(JSON.stringify(failed)).not.toContain("sk-live-SECRET");
    expect(failed.availability.retrieval).toBe(false);

    gate.resolve();
    await waitFor(
      async () => (await statusOf(harness)).availability.retrieval,
      "the retried encoder load to succeed",
    );
    const recovered = await statusOf(harness);
    expect(recovered.error).toBeUndefined();
    expect(recovered.availability).toEqual({
      submission: true,
      retrieval: true,
      ingestion: true,
    });
    expect(providers.embedderOpens).toBe(2);
  });

  it("publishes a safe store diagnostic and recovers on the next attempt", async () => {
    const providers = new ControlledProviders();
    providers.failStoreOnce(new Error("qdrant refused the connection"));
    const gate = providers.holdStore();
    const harness = await openService({
      providers,
      waitForProviders: false,
    });

    await waitFor(
      async () => (await statusOf(harness)).error !== undefined,
      "the failed store open to be reported",
    );
    expect((await statusOf(harness)).error).toBe(
      "The note store could not be opened.",
    );

    gate.resolve();
    await waitFor(
      async () => (await statusOf(harness)).availability.retrieval,
      "the retried store open to succeed",
    );
    expect(providers.embedderOpens).toBe(1);
    expect(providers.storeOpens).toBe(2);
  });

  it("refuses an encoder that declares another embedding space", async () => {
    const providers = new ControlledProviders();
    const harness = await openService({
      providers,
      waitForProviders: false,
      factories: {
        ...providers.factories,
        openEmbedder: async () => ({
          space: { id: "another-space", dimensions: 4, distance: "Cosine" },
          embed: async () => [1, 0, 0, 0],
        }),
      },
    });

    await waitFor(
      async () => (await statusOf(harness)).error !== undefined,
      "the space mismatch to be reported",
    );
    const status = await statusOf(harness);
    expect(status.error).toBe(
      "The loaded encoder declares a different embedding space than the collection this " +
        "service owns.",
    );
    expect(status.availability.retrieval).toBe(false);
    // A mismatch is configuration, not a transient outage: the service never opens the store.
    expect(providers.storeOpens).toBe(0);
    expect(providers.embedderOpens).toBe(0);
    expect(referenceEmbeddingSpace.dimensions).toBe(1_024);
  });
});
