import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProjectionArtifactStore } from "../../inspector/artifacts.js";
import { createThreadProjectionRunner } from "../../inspector/projection-runner.js";
import {
  startInspectionServer,
  type InspectionServer,
} from "../../inspector/server.js";
import { InspectionSession } from "../../inspector/session.js";
import {
  makeDirectory,
  PagedEmbeddedStore,
  record,
  removeDirectory,
  ScriptedReads,
  ScriptedSource,
  waitFor,
} from "./support/inspection.js";

/**
 * Responsiveness check of the inspection host: while the projection worker occupies its thread,
 * the HTTP server keeps answering the graph route, so interaction is never blocked by CPU-heavy
 * work. The worker substitute is deliberately CPU-bound; the projection itself is verified in
 * inspector-projection.test.ts.
 *
 * See docs/dashboard.md#asynchronous-data-updates.
 */

const hosts: Array<{
  session: InspectionSession;
  server: InspectionServer;
  directory: string;
}> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) {
    await host.server.close();
    await host.session.stop();
    await removeDirectory(host.directory);
  }
});

describe("inspection responsiveness", () => {
  it("cancels a busy projection on shutdown instead of publishing it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const directory = await makeDirectory("amem-inspector-cancel-");
    const uiDirectory = path.join(directory, "ui");
    await mkdir(uiDirectory, { recursive: true });
    await writeFile(
      path.join(uiDirectory, "index.html"),
      "<!doctype html>",
      "utf8",
    );
    const store = new PagedEmbeddedStore();
    store.seed(...Array.from({ length: 8 }, (_, index) => record(index)));
    const session = new InspectionSession({
      source: new ScriptedSource(store),
      runner: createThreadProjectionRunner({
        workerUrl: new URL(
          "./fixtures/blocking-projection.worker.mjs",
          import.meta.url,
        ),
      }),
      artifacts: createProjectionArtifactStore(
        path.join(directory, "artifacts"),
      ),
      pollIntervalMs: 0,
    });
    const server = await startInspectionServer({
      reads: new ScriptedReads(),
      session,
      uiDirectory,
      port: 0,
    });
    hosts.push({ session, server, directory });

    session.start();
    await waitFor(
      () => session.snapshot().refreshing,
      "the export and its projection",
    );

    // The worker occupies its thread for a fixed window; shutdown terminates it and never
    // publishes the projection it was computing.
    await session.stop();

    const stopped = session.snapshot();
    expect(stopped.view).toBeUndefined();
    expect(stopped.status).toBe("loading");
  }, 30_000);

  it("keeps the graph route responsive while the projection worker is busy", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const directory = await makeDirectory("amem-inspector-responsive-");
    const uiDirectory = path.join(directory, "ui");
    await mkdir(uiDirectory, { recursive: true });
    await writeFile(
      path.join(uiDirectory, "index.html"),
      "<!doctype html>",
      "utf8",
    );
    const store = new PagedEmbeddedStore();
    store.seed(...Array.from({ length: 8 }, (_, index) => record(index)));
    const session = new InspectionSession({
      source: new ScriptedSource(store),
      runner: createThreadProjectionRunner({
        workerUrl: new URL(
          "./fixtures/blocking-projection.worker.mjs",
          import.meta.url,
        ),
      }),
      artifacts: createProjectionArtifactStore(
        path.join(directory, "artifacts"),
      ),
      pollIntervalMs: 0,
    });
    const server = await startInspectionServer({
      reads: new ScriptedReads(),
      session,
      uiDirectory,
      port: 0,
    });
    hosts.push({ session, server, directory });

    session.start();
    const deadline = Date.now() + 700;
    let responsesWhileRefreshing = 0;
    let fastest = Number.POSITIVE_INFINITY;
    while (Date.now() < deadline && session.snapshot().status !== "ready") {
      const started = Date.now();
      const response = await fetch(
        `http://127.0.0.1:${String(server.port)}/api/graph`,
      );
      const body = (await response.json()) as { refreshing?: boolean };
      if (body.refreshing === true) {
        responsesWhileRefreshing += 1;
        fastest = Math.min(fastest, Date.now() - started);
      }
    }

    // A projection running on the HTTP event loop would have delayed every one of these responses.
    expect(responsesWhileRefreshing).toBeGreaterThanOrEqual(5);
    expect(fastest).toBeLessThan(300);

    await waitFor(
      () => session.snapshot().status === "ready",
      "the published view after the busy projection",
    );
    expect(session.snapshot().view?.nodes).toHaveLength(8);
  }, 30_000);
});
