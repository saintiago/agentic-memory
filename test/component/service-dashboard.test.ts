import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startMemoryService } from "../../service/lifecycle.js";
import type { MemoryServiceRuntime } from "../../service/lifecycle.js";
import { createThreadProjectionRunner } from "../../inspector/projection-runner.js";
import type { ProjectionRunner } from "../../inspector/projection-runner.js";
import { RecordingRunner } from "./support/inspection.js";
import {
  ControlledProviders,
  postJson,
  record,
  requestJson,
  serviceSettings,
  waitFor,
} from "./support/service.js";

/**
 * Component tests of the bundled dashboard: one process, one listener and one configuration serve
 * the unchanged `/v1` memory API, the same-origin `/api` inspection routes and the built UI, share
 * one encoder and one read surface, refresh the projected view after a completed write and close
 * their WebSocket subscriptions and projection worker on shutdown.
 *
 * See docs/service.md#bundled-dashboard and docs/dashboard.md#websocket-updates.
 */

interface Bundled {
  readonly runtime: MemoryServiceRuntime;
  readonly providers: ControlledProviders;
  readonly directory: string;
  readonly uiDirectory: string;
  readonly baseUrl: string;
  readonly port: number;
  url(path: string): string;
  close(): Promise<void>;
}

const bundled: Bundled[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const service of bundled.splice(0)) {
    await service.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const makeDirectory = (): Promise<string> =>
  mkdtemp(path.join(tmpdir(), "amem-bundled-"));

/** Write a minimal but real built dashboard into the supplied directory. */
const writeBuild = async (uiDirectory: string): Promise<void> => {
  await mkdir(uiDirectory, { recursive: true });
  await writeFile(
    path.join(uiDirectory, "index.html"),
    '<!doctype html><html><body><div id="app"></div><script src="app.js"></script></body></html>',
    "utf8",
  );
  await writeFile(
    path.join(uiDirectory, "app.js"),
    "globalThis.__amemInspector = {};\n",
    "utf8",
  );
};

const openBundled = async (
  options: {
    readonly build?: boolean;
    readonly runner?: ProjectionRunner;
    readonly providers?: ControlledProviders;
  } = {},
): Promise<Bundled> => {
  const directory = await makeDirectory();
  directories.push(directory);
  const uiDirectory = path.join(directory, "ui");
  if (options.build !== false) {
    await writeBuild(uiDirectory);
  }
  const providers = options.providers ?? new ControlledProviders();
  const settings = serviceSettings(directory, { port: 0 });
  const runtime = await startMemoryService({
    settings,
    factories: providers.factories,
    queuePollIntervalMs: 10,
    providerRetryBaseMs: 20,
    supervisionIntervalMs: 50,
    dashboard: {
      uiDirectory,
      artifactsDirectory: path.join(directory, "projections"),
      runner: options.runner ?? new RecordingRunner(),
    },
  });
  const baseUrl = `http://127.0.0.1:${String(runtime.port)}`;
  const service: Bundled = {
    runtime,
    providers,
    directory,
    uiDirectory,
    baseUrl,
    port: runtime.port,
    url: (route) => `${baseUrl}${route}`,
    close: async () => {
      await runtime.stop();
    },
  };
  bundled.push(service);
  return service;
};

/** Wait until the bundled graph route reports a completed view with the expected node count. */
const waitForView = async (
  service: Bundled,
  nodes: number,
): Promise<{ readonly status: string; readonly nodes: number }> => {
  let observed = { status: "loading", nodes: -1 };
  await waitFor(
    async () => {
      const response = await requestJson(service.url("/api/graph"));
      const body = response.body as {
        status?: string;
        view?: { nodes?: unknown[] };
      };
      observed = {
        status: body.status ?? "unknown",
        nodes: body.view?.nodes?.length ?? -1,
      };
      return observed.status === "ready" && observed.nodes === nodes;
    },
    `the graph view with ${String(nodes)} memories`,
  );
  return observed;
};

describe("bundled dashboard service", () => {
  it("serves the UI, the unchanged /v1 API and the mounted /api routes on one listener", async () => {
    const service = await openBundled();

    const root = await fetch(service.url("/"));
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain('<div id="app">');

    const asset = await fetch(service.url("/app.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    const status = await requestJson(service.url("/v1/status"));
    expect(status.status).toBe(200);
    const statusBody = status.body as {
      collection: string;
      availability: { submission: boolean; retrieval: boolean };
      embeddingSpace: { id: string };
    };
    expect(statusBody.collection).toBe("service-tests");
    expect(statusBody.availability.submission).toBe(true);

    await waitFor(async () => {
      const ready = await requestJson(service.url("/v1/status"));
      return (ready.body as { availability: { retrieval: boolean } })
        .availability.retrieval;
    }, "the shared providers to become ready");

    // The dashboard projects the service's own reads: the graph view identifies the embedding
    // space of the very service status, so no second client or encoder exists.
    await waitForView(service, 0);
    const graph = await requestJson(service.url("/api/graph"));
    expect(graph.status).toBe(200);
    const view = (graph.body as { view?: { embeddingSpaceId?: string } }).view;
    expect(view?.embeddingSpaceId).toBe(statusBody.embeddingSpace.id);

    // Unknown API routes stay API errors on both sides of the single listener.
    const unknownV1 = await requestJson(service.url("/v1/no-such-route"));
    expect(unknownV1.status).toBe(404);
    expect((unknownV1.body as { error: { code: string } }).error.code).toBe(
      "not-found",
    );
    const unknownApi = await requestJson(service.url("/api/no-such-route"));
    expect(unknownApi.status).toBe(404);
    expect(typeof (unknownApi.body as { error: string }).error).toBe("string");

    // The dashboard never answers a JSON API path with a successful HTML fallback.
    const wrongMethod = await requestJson(service.url("/api/graph"), {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(405);
    expect(typeof (wrongMethod.body as { error: string }).error).toBe("string");
    expect(service.providers.embedderOpens).toBe(1);
  }, 30_000);

  it("refreshes the projected view after a completed write without polling", async () => {
    const service = await openBundled();
    await waitFor(async () => {
      const ready = await requestJson(service.url("/v1/status"));
      return (ready.body as { availability: { retrieval: boolean } })
        .availability.retrieval;
    }, "the shared providers to become ready");

    const accepted = await postJson(service.url("/v1/observations"), {
      sourceKey: "bundled/observation-1",
      content: "The bundled service projects a stored observation.",
    });
    expect(accepted.status).toBe(202);

    // No manual refresh and no polling loop: the completed write invalidates the view itself.
    const observed = await waitForView(service, 1);
    expect(observed.nodes).toBe(1);

    // The same shared read surface answers the browser routes.
    const note = await requestJson(
      service.url(`/api/notes/${String((accepted.body as { id: string }).id)}`),
    );
    // A receipt identity is not a note identity, so the collection has no such note.
    expect(note.status).toBe(404);
    const search = await postJson(service.url("/api/search"), {
      query: "bundled",
    });
    expect(search.status).toBe(200);
    expect(Array.isArray((search.body as { results: unknown[] }).results)).toBe(
      true,
    );
    expect(service.providers.embedderOpens).toBe(1);
  }, 30_000);

  it("notifies a subscribed browser with resync and graph-changed over one listener", async () => {
    const service = await openBundled();
    await waitFor(async () => {
      const ready = await requestJson(service.url("/v1/status"));
      return (ready.body as { availability: { retrieval: boolean } })
        .availability.retrieval;
    }, "the shared providers to become ready");

    const messages: Array<{ type: string }> = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(service.port)}/api/events`,
    );
    socket.addEventListener("message", (event: MessageEvent) => {
      messages.push(JSON.parse(String(event.data)) as { type: string });
    });
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => {
        resolve();
      });
    });
    await waitFor(
      // The resync of the fresh connection; a refresh notification may follow immediately.
      () => messages.some((message) => message.type === "resync"),
      "the connection resync",
    );

    const accepted = await postJson(service.url("/v1/observations"), {
      sourceKey: "bundled/observation-2",
      content: "A write that a subscribed browser must hear about.",
    });
    expect(accepted.status).toBe(202);
    await waitFor(
      () => messages.some((message) => message.type === "graph-changed"),
      "the graph-changed notification",
    );

    // Shutdown owns the subscription: the browser is disconnected instead of left hanging.
    await service.runtime.stop();
    await closed;
    expect(service.runtime.service.stopping).toBe(true);
  }, 30_000);

  it("returns an explicit dashboard-unavailable response when the build is missing", async () => {
    const service = await openBundled({ build: false });

    const root = await requestJson(service.url("/"));
    expect(root.status).toBe(503);
    expect((root.body as { error: string }).error).toContain(
      "dashboard build is not available",
    );

    const status = await requestJson(service.url("/v1/status"));
    expect(status.status).toBe(200);
    const graph = await requestJson(service.url("/api/graph"));
    expect(graph.status).toBe(200);
    expect(["loading", "error", "ready"]).toContain(
      (graph.body as { status: string }).status,
    );
  }, 30_000);

  it("starts with unavailable providers and recovers the graph on its own backoff", async () => {
    const providers = new ControlledProviders();
    const encoderGate = providers.holdEmbedder();
    const service = await openBundled({ providers });

    // The listener answers while the provider stack is unavailable: submission stays durable.
    const status = await requestJson(service.url("/v1/status"));
    expect(status.status).toBe(200);
    const availability = (
      status.body as {
        availability: { submission: boolean; retrieval: boolean };
      }
    ).availability;
    expect(availability.submission).toBe(true);
    expect(availability.retrieval).toBe(false);
    expect((await fetch(service.url("/"))).status).toBe(200);

    // A failed export is an explicit error next to no view, never an empty collection.
    await waitFor(async () => {
      const graph = await requestJson(service.url("/api/graph"));
      const body = graph.body as { status?: string; error?: string };
      return body.status === "error" && body.error !== undefined;
    }, "the explicit graph failure");

    // Recovery needs no manual refresh: the session retries its failed refresh by itself.
    encoderGate.resolve();
    await waitForView(service, 0);
    expect(service.providers.embedderOpens).toBe(1);
  }, 30_000);

  it("keeps the memory API answering while the projection worker is busy and stops cleanly", async () => {
    const service = await openBundled({
      runner: createThreadProjectionRunner({
        workerUrl: new URL(
          "./fixtures/blocking-projection.worker.mjs",
          import.meta.url,
        ),
      }),
    });
    service.providers.store.seed(
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((index) => record(index)),
    );
    await waitFor(async () => {
      const ready = await requestJson(service.url("/v1/status"));
      return (ready.body as { availability: { retrieval: boolean } })
        .availability.retrieval;
    }, "the shared providers to become ready");

    // The seeded collection is exported through the service's own inspection capability.
    const requested = await fetch(service.url("/api/refresh"), {
      method: "POST",
    });
    expect(requested.status).toBe(202);
    await waitForView(service, 8);

    // The next projection occupies its worker; the API of the same listener stays responsive.
    const refresh = await fetch(service.url("/api/refresh"), {
      method: "POST",
    });
    expect(refresh.status).toBe(202);
    const started = Date.now();
    const status = await requestJson(service.url("/v1/status"));
    expect(status.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(500);

    // Shutdown settles while the busy projection worker is cancelled.
    await service.runtime.stop();
    await expect(fetch(service.url("/v1/status"))).rejects.toThrow();
  }, 30_000);

  it("refuses an untrusted websocket handshake before the upgrade", async () => {
    const service = await openBundled();
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(service.port, "127.0.0.1", () => {
        socket.write(
          "GET /api/events HTTP/1.1\r\n" +
            "Host: rebound.example:4748\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on("error", reject);
      socket.setTimeout(5_000, () => {
        socket.destroy();
        reject(new Error("The handshake was not refused in time."));
      });
    });
    expect(response).toContain("400 Bad Request");
    expect(response).toContain("host");
  }, 30_000);
});
