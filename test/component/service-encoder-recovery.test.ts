import { afterEach, describe, expect, it } from "vitest";

import { createMemoryServiceClient } from "../../service/client.js";
import { openWorkerEmbedder } from "../../service/encoder-host.js";
import {
  ControlledProviders,
  deferred,
  startServiceHarness,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

const workerUrl = new URL(
  "./fixtures/failing-encoder.worker.ts",
  import.meta.url,
);
const harnesses: ServiceHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

describe("encoder lifetime supervision", () => {
  it("replaces a post-readiness crash, retries a failed replacement and drains retained observations", async () => {
    const providers = new ControlledProviders();
    const retry = deferred<void>();
    let opens = 0;
    let live = 0;
    let peak = 0;
    const openedAt: number[] = [];
    const harness = await startServiceHarness({
      providers,
      providerRetryBaseMs: 50,
      factories: {
        ...providers.factories,
        openEmbedder: async (options) => {
          opens += 1;
          openedAt.push(Date.now());
          if (opens === 2) {
            await retry.promise;
            throw new Error("replacement load failed");
          }
          const embedder = await openWorkerEmbedder({
            ...options,
            workerUrl,
            allowDownloads: opens > 1,
          });
          live += 1;
          peak = Math.max(peak, live);
          return embedder;
        },
        closeEmbedder: async (embedder) => {
          await (
            embedder as Awaited<ReturnType<typeof openWorkerEmbedder>>
          ).close();
          live -= 1;
        },
      },
    });
    harnesses.push(harness);
    const client = createMemoryServiceClient({ url: harness.baseUrl });
    try {
      const first = await client.submit({
        sourceKey: "crash",
        content: "Triggers the first encoder's exit.",
      });
      await waitFor(
        () => opens === 2,
        "encoder replacement after ingestion crashes the thread",
      );
      expect((await client.status()).availability).toEqual({
        submission: true,
        retrieval: false,
        ingestion: false,
      });
      await expect(client.search("during recovery")).rejects.toMatchObject({
        status: 503,
        retryable: true,
      });
      const second = await client.submit({
        sourceKey: "during-replacement",
        content: "Accepted while the encoder is down.",
      });
      retry.resolve();
      await waitFor(
        async () =>
          (await client.receipt(second.receipt.id))?.status === "stored",
        "both retained observations to drain",
      );
      expect((await client.receipt(first.receipt.id))?.status).toBe("stored");
      expect((await client.search("recovered")).results).toHaveLength(2);
      expect((await client.status()).availability).toEqual({
        submission: true,
        retrieval: true,
        ingestion: true,
      });
      expect(opens).toBe(3);
      expect((openedAt[2] ?? 0) - (openedAt[1] ?? 0)).toBeGreaterThanOrEqual(
        95,
      );
      expect(peak).toBe(1);
      expect(providers.storeOpens).toBe(1);
      expect(providers.store.writes).toHaveLength(2);
      // An ordinary inference rejection must not destroy a healthy thread.
      await expect(client.search("reject-inference")).rejects.toMatchObject({
        status: 503,
      });
      await client.search("another successful search");
      expect(opens).toBe(3);
    } finally {
      retry.resolve();
      await harness.runtime.stop();
    }
    expect(live).toBe(0);
    expect(opens).toBe(3);
  }, 30_000);

  it("recovers an idle exit even while the store is still opening", async () => {
    const providers = new ControlledProviders();
    const store = providers.holdStore();
    let opens = 0;
    const exited = deferred<void>();
    const harness = await startServiceHarness({
      providers,
      waitForProviders: false,
      factories: {
        ...providers.factories,
        openEmbedder: async (options) => {
          opens += 1;
          const embedder = await openWorkerEmbedder({
            ...options,
            workerUrl,
            cacheDir: opens === 1 ? "exit-idle" : options.cacheDir,
            allowDownloads: true,
          });
          if (opens === 1) {
            void embedder.failed.then(() => exited.resolve());
          }
          return embedder;
        },
      },
    });
    harnesses.push(harness);
    const client = createMemoryServiceClient({ url: harness.baseUrl });
    try {
      await exited.promise;
      expect((await client.status()).availability.retrieval).toBe(false);
      store.resolve();
      await waitFor(
        async () => (await client.status()).availability.retrieval,
        "idle encoder replacement",
      );
      await client.search("recovered without a triggering failure request");
      expect(opens).toBe(2);
    } finally {
      store.resolve();
    }
  });
});
