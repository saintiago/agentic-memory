import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGraphEvents } from "../../inspector/events.js";
import { startMemoryService } from "../../service/lifecycle.js";
import type { ServiceSettings } from "../../service/settings.js";
import { RecordingRunner } from "./support/inspection.js";
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
const directories: string[] = [];

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
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("service lifecycle", () => {
  it("refuses malformed provider settings before creating or binding the journal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amem-service-config-"));
    directories.push(root);
    const dataDirectory = path.join(root, "data");
    const settings = (overrides: Partial<ServiceSettings>): ServiceSettings =>
      serviceSettings(dataDirectory, overrides);
    const attempt = (overrides: Partial<ServiceSettings>): Promise<unknown> =>
      startMemoryService({
        settings: settings(overrides),
        factories: new ControlledProviders().factories,
        queuePollIntervalMs: 10,
      });

    await expect(
      attempt({
        qdrant: {
          url: "not-a-url",
          collection: "service-tests",
          timeoutMs: 1_000,
        },
      }),
    ).rejects.toThrow(/Qdrant provider settings are not valid/);
    await expect(
      attempt({
        model: {
          endpoint: "not-a-url",
          model: "test-model",
          timeoutMs: 1_000,
          maxOutputTokens: 128,
        },
      }),
    ).rejects.toThrow(/model provider settings are not valid/);

    const credential = "sk-live-SECRET";
    const refused = await attempt({
      model: {
        endpoint: "https://model.example/chat/completions",
        model: "test-model",
        apiKey: `unusable\n${credential}`,
        timeoutMs: 1_000,
        maxOutputTokens: 128,
      },
    }).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(
      /model provider settings are not valid/,
    );
    // Provider text is never echoed: a rejected credential must not reach a diagnostic.
    expect((refused as Error).message).not.toContain(credential);

    // Nothing validated created the durable directory, so correcting the configuration binds a
    // fresh journal instead of being refused by a queue the bad endpoint already owned.
    await expect(stat(dataDirectory)).rejects.toThrow();
    const runtime = await startMemoryService({
      settings: settings({}),
      factories: new ControlledProviders().factories,
      queuePollIntervalMs: 10,
    });
    await runtime.stop();
    expect((await stat(dataDirectory)).isDirectory()).toBe(true);
  }, 30_000);

  it("refuses a second service that names the same queue", async () => {
    const harness = await openService();
    const providers = new ControlledProviders();
    const runner = new RecordingRunner();
    const events = createGraphEvents({});
    const closeEvents = vi.spyOn(events, "close");
    try {
      await expect(
        startMemoryService({
          settings: serviceSettings(harness.directory, { port: 0 }),
          factories: providers.factories,
          queuePollIntervalMs: 10,
          dashboard: {
            uiDirectory: harness.directory,
            artifactsDirectory: path.join(harness.directory, "artifacts"),
            runner,
            events,
          },
        }),
      ).rejects.toThrow(/already owns the ingestion queue/);
      expect(runner.closed).toBe(true);
      expect(closeEvents).toHaveBeenCalledOnce();
      expect(runner.projections).toEqual([]);
      // Rejecting the duplicate must leave the original owner usable.
      expect((await requestJson(harness.url("/v1/status"))).status).toBe(200);
    } finally {
      await runner.close();
      await events.close();
      closeEvents.mockRestore();
    }
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

  it("stops claiming queued work before it waits for an in-flight HTTP request", async () => {
    const providers = new ControlledProviders();
    const harness = await openService({ providers });

    // Hold one HTTP read open, so shutdown must wait for a request while the durable queue still
    // holds an active insertion and one queued observation.
    const pages = providers.store.holdPages();
    const read = requestJson(harness.url("/v1/notes"));
    await waitFor(
      () => providers.store.pageStarted >= 1,
      "the HTTP page read to arrive",
    );

    const write = providers.store.holdWrites();
    const active = await postJson(harness.url("/v1/observations"), {
      sourceKey: "active-insertion",
      content: "An insertion that holds the queue worker.",
    });
    expect(active.status).toBe(202);
    await waitFor(
      () => providers.store.putStarted >= 1,
      "the active insertion to reach its write",
    );
    const queued = await postJson(harness.url("/v1/observations"), {
      sourceKey: "queued-observation",
      content: "An observation that must stay queued by shutdown.",
    });
    expect(queued.status).toBe(202);
    const before = await requestJson(harness.url("/v1/status"));
    // Both observations are durably accepted before shutdown starts.
    expect(
      (before.body as { queue: { accepted: number } }).queue.accepted,
    ).toBe(2);

    const stopping = harness.runtime.stop();
    write.resolve();
    // The active insertion settles, but the queued observation must not be claimed while the
    // shutdown still waits for the held read.
    await waitFor(
      () => providers.store.writes.length >= 1,
      "the active insertion to finish",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(providers.store.writes).toHaveLength(1);

    pages.resolve();
    await read;
    await stopping;

    // The queued observation stayed durable in the journal and was never drained during
    // shutdown; the closed listener cannot answer for it, but no write carried its content.
    expect(providers.store.writes).toHaveLength(1);
    expect(providers.store.writes[0]?.[0]?.note.content).toBe(
      "An insertion that holds the queue worker.",
    );
  }, 30_000);
});
