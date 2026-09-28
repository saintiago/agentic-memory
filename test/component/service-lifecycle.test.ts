import { afterEach, describe, expect, it } from "vitest";

import { startMemoryService } from "../../service/lifecycle.js";
import {
  ControlledProviders,
  postJson,
  requestJson,
  serviceSettings,
  startServiceHarness,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Component tests for the supervised lifecycle: one writer per queue, a restarted ingestion
 * worker, admission that stops before shutdown, and a graceful stop that settles the active
 * operation before the journal closes.
 *
 * See docs/service.md#availability-restart-and-shutdown.
 */

const harnesses: ServiceHarness[] = [];

const openService = async (
  options: Parameters<typeof startServiceHarness>[0] = {},
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

describe("service lifecycle", () => {
  it("refuses a second service that names the same queue", async () => {
    const harness = await openService();
    const providers = new ControlledProviders();
    await expect(
      startMemoryService({
        settings: {
          ...serviceSettings(harness.directory, { port: 0 }),
        },
        factories: providers.factories,
        queuePollIntervalMs: 10,
      }),
    ).rejects.toThrow(/already owns the ingestion queue/);
  });

  it("restarts a stopped ingestion worker without a new handoff", async () => {
    const harness = await openService({ supervisionIntervalMs: 20 });
    await harness.runtime.queue.stop();
    await waitFor(async () => {
      const status = await requestJson(harness.url("/v1/status"));
      return (
        (status.body as { queue: { worker: string } }).queue.worker ===
        "stopped"
      );
    }, "the worker to stop");

    await waitFor(async () => {
      const status = await requestJson(harness.url("/v1/status"));
      return (
        (status.body as { queue: { worker: string } }).queue.worker ===
        "running"
      );
    }, "the supervisor to restart the worker");

    const accepted = await postJson(harness.url("/v1/observations"), {
      sourceKey: "after-restart",
      content: "An observation after the worker restarted.",
    });
    expect(accepted.status).toBe(202);
    await waitFor(async () => {
      const receipt = await requestJson(
        harness.url(
          `/v1/receipts/${String((accepted.body as { id: string }).id)}`,
        ),
      );
      return (receipt.body as { status: string }).status === "stored";
    }, "the restarted worker to store the observation");
  });

  it("stops admitting requests and settles the active operation on shutdown", async () => {
    const providers = new ControlledProviders();
    const harness = await openService({ providers });
    const write = providers.store.holdWrites();
    const accepted = await postJson(harness.url("/v1/observations"), {
      sourceKey: "in-flight",
      content: "An observation whose write is in flight.",
    });
    expect(accepted.status).toBe(202);
    await waitFor(
      () => providers.store.putStarted >= 1,
      "the worker to start the note write",
    );

    harness.runtime.service.beginShutdown();
    const refused = await postJson(harness.url("/v1/observations"), {
      sourceKey: "after-shutdown",
      content: "A late observation.",
    });
    expect(refused.status).toBe(503);
    expect(
      (refused.body as { error: { retryable: boolean } }).error.retryable,
    ).toBe(true);

    const stopping = harness.runtime.stop();
    write.resolve();
    await stopping;

    // The active operation finished before the journal closed, without a forced exit.
    expect(providers.store.writes).toHaveLength(1);
    const stored = providers.store.writes[0]?.[0];
    expect(stored?.note.content).toBe(
      "An observation whose write is in flight.",
    );
  });
});
