import { afterEach, describe, expect, it } from "vitest";

import { openWorkerEmbedder } from "../../service/encoder-host.js";
import {
  ControlledProviders,
  postJson,
  requestJson,
  startServiceHarness,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Responsiveness check of the memory service: while the shared encoder occupies its worker
 * thread, the HTTP API keeps answering requests, so a blocking encoder load or inference never
 * stalls submissions, receipt reads or status reports. The worker substitute is deliberately
 * CPU-bound; the pinned encoder itself is verified by the embeddings checks.
 *
 * See docs/service.md#async-work-and-resource-sharing.
 */

const harnesses: ServiceHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

describe("service responsiveness", () => {
  it("keeps HTTP requests responsive while the blocking encoder works", async () => {
    const providers = new ControlledProviders();
    const harness = await startServiceHarness({
      providers,
      factories: {
        ...providers.factories,
        openEmbedder: (options) =>
          openWorkerEmbedder({
            ...options,
            workerUrl: new URL(
              "./fixtures/blocking-encoder.worker.ts",
              import.meta.url,
            ),
          }),
      },
    });
    harnesses.push(harness);

    const accepted = await postJson(harness.url("/v1/observations"), {
      sourceKey: "blocking-encoder",
      content: "An observation whose embedding occupies the encoder thread.",
    });
    expect(accepted.status).toBe(202);
    const receiptId = (accepted.body as { id: string }).id;

    // A second observation is acknowledged durably while the encoder thread is still busy with
    // the first; submission must never wait for inference.
    const submittedAt = Date.now();
    const second = await postJson(harness.url("/v1/observations"), {
      sourceKey: "blocking-encoder-second",
      content: "A second observation submitted during the same inference.",
    });
    const submissionMs = Date.now() - submittedAt;
    expect(second.status).toBe(202);

    // The durable worker claims the observation immediately and embeds while this loop runs. An
    // encoder on the HTTP event loop would have delayed every one of these requests by the whole
    // busy window; the loop instead observes a healthy API until the embedding completes.
    const deadline = Date.now() + 3_000;
    let responses = 0;
    let fastest = Number.POSITIVE_INFINITY;
    let sawPending = false;
    for (;;) {
      const started = Date.now();
      const status = await requestJson(harness.url("/v1/status"));
      expect(status.status).toBe(200);
      fastest = Math.min(fastest, Date.now() - started);
      responses += 1;

      const receipt = await requestJson(
        harness.url(`/v1/receipts/${receiptId}`),
      );
      const state = (receipt.body as { status: string }).status;
      if (state !== "stored") {
        sawPending = true;
      }
      if (state === "stored" || Date.now() > deadline) {
        break;
      }
    }

    expect(sawPending).toBe(true);
    expect(responses).toBeGreaterThanOrEqual(20);
    expect(fastest).toBeLessThan(300);
    expect(submissionMs).toBeLessThan(300);
    // Both accepted observations are drained by the single writer afterwards.
    const deadlineForWrites = Date.now() + 10_000;
    while (
      providers.store.writes.length < 2 &&
      Date.now() < deadlineForWrites
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(providers.store.writes).toHaveLength(2);
  }, 30_000);
});
