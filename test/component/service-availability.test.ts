import { afterEach, describe, expect, it } from "vitest";

import { referenceEmbeddingSpace } from "../../src/index.js";
import { openWorkerEmbedder } from "../../service/encoder-host.js";
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

  it("loads the pinned encoder through its own worker and reports a missing cache safely", async () => {
    const providers = new ControlledProviders();
    const harness = await openService({
      providers,
      waitForProviders: false,
      factories: {
        ...providers.factories,
        // The default host path: the real worker entry loads the pinned encoder in its thread.
        openEmbedder: (options) => openWorkerEmbedder(options),
      },
    });

    // The test cache is empty and downloads are disabled, so the pinned load fails inside the
    // worker; the service publishes its fixed diagnostic while the detail stays on stderr.
    await waitFor(
      async () => (await statusOf(harness)).error !== undefined,
      "the worker's encoder load failure to be reported",
    );
    const status = await statusOf(harness);
    expect(status.error).toBe("The pinned encoder could not be loaded.");
    expect(status.availability).toEqual({
      submission: true,
      retrieval: false,
      ingestion: false,
    });
  }, 30_000);
});

describe("operational availability", () => {
  it("reports a failing retrieval capability and clears it when a read succeeds", async () => {
    const providers = new ControlledProviders();
    const harness = await openService({ providers });

    providers.store.nearestError = new Error("qdrant refused the search");
    const failed = await postJson(harness.url("/v1/search"), {
      query: "a query",
    });
    expect(failed.status).toBe(503);
    const down = await statusOf(harness);
    expect(down.availability.retrieval).toBe(false);
    expect(down.availability.ingestion).toBe(true);
    expect(down.error).toBe("The memory retrieval capability is failing.");

    // The next read that the provider serves restores the capability and clears the diagnostic.
    providers.store.nearestError = undefined;
    const served = await postJson(harness.url("/v1/search"), {
      query: "a query",
    });
    expect(served.status).toBe(200);
    const recovered = await statusOf(harness);
    expect(recovered.availability.retrieval).toBe(true);
    expect(recovered.error).toBeUndefined();
  });

  it("reports a failing ingestion capability while the model provider is down", async () => {
    const providers = new ControlledProviders();
    const harness = await openService({ providers });

    providers.model.failAll = new Error("the model provider is down");
    const accepted = await postJson(harness.url("/v1/observations"), {
      sourceKey: "model-outage",
      content: "An observation accepted while the model is down.",
    });
    expect(accepted.status).toBe(202);
    await waitFor(async () => {
      const status = await statusOf(harness);
      return !status.availability.ingestion && status.availability.retrieval;
    }, "the model outage to be reported while reads stay available");
    expect((await statusOf(harness)).error).toBe(
      "The memory ingestion capability is failing.",
    );

    providers.model.failAll = undefined;
    await waitFor(async () => {
      const status = await statusOf(harness);
      return status.availability.ingestion;
    }, "the next served insertion to restore ingestion");
    expect((await statusOf(harness)).error).toBeUndefined();
  }, 30_000);

  it("does not report invalid input as a capability outage", async () => {
    const providers = new ControlledProviders();
    const harness = await openService({ providers });

    const invalid = await postJson(harness.url("/v1/search"), {
      query: "   ",
    });
    expect(invalid.status).toBe(400);
    const status = await statusOf(harness);
    expect(status.availability).toEqual({
      submission: true,
      retrieval: true,
      ingestion: true,
    });
    expect(status.error).toBeUndefined();
  });
});
