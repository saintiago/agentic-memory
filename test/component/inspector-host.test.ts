import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MemoryError,
  type Cursor,
  type EmbeddedNote,
  type EmbeddedPage,
} from "../../src/index.js";
import { createProjectionArtifactStore } from "../../inspector/artifacts.js";
import { createGraphEvents } from "../../inspector/events.js";
import { createThreadProjectionRunner } from "../../inspector/projection-runner.js";
import {
  startInspectionServer,
  type InspectionServer,
} from "../../inspector/server.js";
import { InspectionSession } from "../../inspector/session.js";
import {
  makeDirectory,
  note,
  PagedEmbeddedStore,
  record,
  RecordingRunner,
  removeDirectory,
  ScriptedReads,
  ScriptedSource,
  scriptedArtifact,
  uuid,
  vector,
  waitFor,
} from "./support/inspection.js";

/**
 * Component tests for the inspection host: the session's refresh and projection lifecycle and the
 * HTTP contract of the browser API, exercised over a real loopback server with an in-memory paged
 * export, a stub public read surface and a recording projection runner.
 *
 * See docs/dashboard.md#browser-api and docs/testing.md#choosing-scope.
 */

interface Host {
  readonly session: InspectionSession;
  readonly server: InspectionServer;
  readonly runner: RecordingRunner;
  readonly store: PagedEmbeddedStore;
  readonly reads: ScriptedReads;
  readonly baseUrl: string;
  readonly directory: string;
}

const hosts: Array<{
  session: InspectionSession;
  server: InspectionServer;
  directory: string;
}> = [];

/** A small corpus with two stored links and one target that the export does not contain. */
const seededStore = (): PagedEmbeddedStore => {
  const store = new PagedEmbeddedStore();
  store.seed(
    record(0, [uuid(1)]),
    record(1),
    record(2, [uuid(0), uuid(3)]),
    record(3),
    record(4, [uuid(9)]),
  );
  return store;
};

/** An in-memory export that can hold one page open while other work overlaps it. */
class GatedEmbeddedStore extends PagedEmbeddedStore {
  calls = 0;
  #holdAt: number | undefined;
  #held: (() => void) | undefined;
  #gate: Promise<void> | undefined;

  /** Hold the call to the given one-based page until `releasePage` is called. */
  holdPage(call: number): void {
    this.#holdAt = call;
    this.#gate = new Promise((resolve) => {
      this.#held = resolve;
    });
  }

  releasePage(): void {
    this.#held?.();
    this.#held = undefined;
  }

  override async pageEmbedded(
    limit: number,
    cursor?: Cursor,
  ): Promise<EmbeddedPage> {
    this.calls += 1;
    if (this.calls === this.#holdAt) {
      this.#holdAt = undefined;
      const gate = this.#gate;
      this.#gate = undefined;
      if (gate !== undefined) {
        await gate;
      }
    }
    return super.pageEmbedded(limit, cursor);
  }
}

/** An export that fails a controlled number of times before serving the stored records. */
class FlakyEmbeddedStore extends PagedEmbeddedStore {
  failures = 0;

  override async pageEmbedded(
    limit: number,
    cursor?: Cursor,
  ): Promise<EmbeddedPage> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("The collection is temporarily unavailable.");
    }
    return super.pageEmbedded(limit, cursor);
  }
}

const startHost = async (
  options: {
    store?: PagedEmbeddedStore;
    runner?: RecordingRunner;
    reads?: ScriptedReads;
    pollIntervalMs?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    pageLimit?: number;
    start?: boolean;
    artifactsDirectory?: string;
    now?: () => Date;
  } = {},
): Promise<Host> => {
  const directory = await makeDirectory("amem-inspector-host-");
  const uiDirectory = path.join(directory, "ui");
  await mkdir(uiDirectory, { recursive: true });
  await writeFile(
    path.join(uiDirectory, "index.html"),
    "<!doctype html><title>Inspection UI</title>",
    "utf8",
  );
  const store = options.store ?? seededStore();
  const runner = options.runner ?? new RecordingRunner();
  const reads = options.reads ?? new ScriptedReads();
  if (options.reads === undefined) {
    reads.seed(note(0), note(1), note(2), note(3), note(4));
  }
  const source = new ScriptedSource(store, reads);
  const session = new InspectionSession({
    source,
    runner,
    artifacts: createProjectionArtifactStore(
      options.artifactsDirectory ?? path.join(directory, "artifacts"),
    ),
    pollIntervalMs: options.pollIntervalMs ?? 0,
    ...(options.retryBaseMs === undefined
      ? {}
      : { retryBaseMs: options.retryBaseMs }),
    ...(options.retryMaxMs === undefined
      ? {}
      : { retryMaxMs: options.retryMaxMs }),
    ...(options.pageLimit === undefined
      ? {}
      : { pageLimit: options.pageLimit }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const server = await startInspectionServer({
    reads: source,
    session,
    uiDirectory,
    port: 0,
  });
  hosts.push({ session, server, directory });
  if (options.start !== false) {
    session.start();
  }
  return {
    session,
    server,
    runner,
    store,
    reads,
    baseUrl: `http://127.0.0.1:${String(server.port)}`,
    directory,
  };
};

const getGraph = async (
  host: Host,
): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> => {
  const response = await fetch(`${host.baseUrl}/api/graph`);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

const postJson = async (
  host: Host,
  route: string,
  body?: unknown,
): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> => {
  const response = await fetch(`${host.baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

describe("inspection host", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const host of hosts.splice(0)) {
      await host.server.close();
      await host.session.stop();
      await removeDirectory(host.directory);
    }
  });

  it("serves loading until the first complete export and projection are published", async () => {
    const host = await startHost({ start: false, pageLimit: 2 });

    expect(await getGraph(host)).toEqual({
      status: 200,
      body: { status: "loading", refreshing: false },
    });

    host.session.start();
    await host.session.settled();

    const graph = await getGraph(host);
    expect(graph.status).toBe(200);
    expect(graph.body).toMatchObject({
      status: "ready",
      refreshing: false,
      view: {
        embeddingSpaceId: "space-1",
        projectionId: "test-projection:5",
        layout: "non-semantic",
        bounds: { x: [0, 4], y: [-5, -1] },
      },
    });
    const view = graph.body["view"] as {
      capturedAt: string;
      nodes: Array<{
        id: string;
        label: string;
        x: number;
        y: number;
        updatedAt?: string;
      }>;
      edges: Array<{ source: string; target: string }>;
    };
    expect(Number.isNaN(Date.parse(view.capturedAt))).toBe(false);
    expect(view.nodes.map((node) => node.id).sort()).toEqual(
      [uuid(0), uuid(1), uuid(2), uuid(3), uuid(4)].sort(),
    );
    expect(view.nodes.find((node) => node.id === uuid(1))?.label).toBe(
      "Source material 1.",
    );
    expect(view.nodes.find((node) => node.id === uuid(1))?.updatedAt).toBe(
      "2026-09-28T09:00:00.000+02:00",
    );
    // The dangling link to uuid(9) is not invented as a positioned node.
    expect(view.edges).toEqual([
      { source: uuid(0), target: uuid(1) },
      { source: uuid(2), target: uuid(0) },
      { source: uuid(2), target: uuid(3) },
    ]);
    // The traversal continued the store's cursor and the host never wrote a memory.
    expect(host.store.exports).toEqual([
      { limit: 2 },
      { limit: 2, cursor: 2 },
      { limit: 2, cursor: 4 },
    ]);
  });

  it("retries a failed refresh on its own bounded backoff until it succeeds", async () => {
    const store = new FlakyEmbeddedStore();
    store.seed(record(0), record(1));
    store.failures = 2;
    const host = await startHost({ store, retryBaseMs: 20, retryMaxMs: 40 });

    // No manual refresh and no memory write: the session recovers the failed export itself.
    await waitFor(
      () => host.session.snapshot().status === "ready",
      "the recovered view",
    );
    expect(store.failures).toBe(0);
    const graph = await getGraph(host);
    expect(
      (graph.body.view as { nodes: unknown[] } | undefined)?.nodes,
    ).toHaveLength(2);
  });

  it("keeps a requested rebuild through a temporary export failure", async () => {
    const store = new FlakyEmbeddedStore();
    store.seed(record(0), record(1));
    const runner = new RecordingRunner();
    const host = await startHost({
      store,
      runner,
      retryBaseMs: 20,
      retryMaxMs: 40,
    });
    await host.session.settled();
    expect(runner.projections.map((request) => request.rebuild)).toEqual([
      false,
    ]);

    // The export of the requested rebuild fails once; the automatic retry must still fit fresh.
    store.failures = 1;
    host.session.rebuild();
    await waitFor(
      () => runner.projections.length === 2,
      "the retried rebuild projection",
    );
    await host.session.settled();

    expect(runner.projections.map((request) => request.rebuild)).toEqual([
      false,
      true,
    ]);
    const snapshot = host.session.snapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.view?.projectionId).toContain(":rebuild");
  });

  it("keeps a requested rebuild through a temporary projection failure", async () => {
    const runner = new RecordingRunner();
    const host = await startHost({ runner, retryBaseMs: 20, retryMaxMs: 40 });
    await host.session.settled();
    expect(runner.projections.map((request) => request.rebuild)).toEqual([
      false,
    ]);

    let failures = 0;
    runner.control({
      project: (request) => {
        failures += 1;
        return failures === 1
          ? Promise.reject(new Error("the projection exploded"))
          : Promise.resolve(scriptedArtifact(request));
      },
    });
    host.session.rebuild();
    await waitFor(
      () => runner.projections.length === 3,
      "the retried rebuild projection",
    );
    await host.session.settled();

    expect(runner.projections.map((request) => request.rebuild)).toEqual([
      false,
      true,
      true,
    ]);
    const snapshot = host.session.snapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.view?.projectionId).toContain(":rebuild");
  });

  it("serves the graph notification channel on the same listener", async () => {
    const host = await startHost();
    await host.session.settled();

    const first = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${String(host.server.port)}/api/events`,
      );
      socket.addEventListener("message", (event: MessageEvent) => {
        resolve(String(event.data));
        socket.close();
      });
      socket.addEventListener("error", () => {
        reject(new Error("The event channel refused the connection."));
      });
    });
    expect(JSON.parse(first)).toEqual({ type: "resync" });

    // A plain request cannot read the notification channel instead of an upgrade.
    const plain = await fetch(`${host.baseUrl}/api/events`);
    expect(plain.status).toBe(426);
  });

  it("answers details, searches and comparisons over the public read surface", async () => {
    const host = await startHost();
    await host.session.settled();

    const detail = await fetch(`${host.baseUrl}/api/notes/${uuid(1)}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: uuid(1),
      content: "Source material 1.",
    });

    const missing = await fetch(`${host.baseUrl}/api/notes/${uuid(60)}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "No note exists with that ID.",
    });

    const invalid = await fetch(`${host.baseUrl}/api/notes/not-a-uuid`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "The note ID is not valid.",
    });

    const wrongMethod = await fetch(`${host.baseUrl}/api/notes/${uuid(1)}`, {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");

    host.reads.results = [
      { note: note(2), via: "match", score: 0.75 },
      { note: note(3), via: "link" },
    ];
    const searched = await postJson(host, "/api/search", {
      query: "source material",
      limit: 3,
      linkedLimit: 1,
    });
    expect(searched.status).toBe(200);
    expect(searched.body).toMatchObject({
      results: [
        { note: { id: uuid(2) }, via: "match", score: 0.75 },
        { note: { id: uuid(3) }, via: "link" },
      ],
    });
    expect(Number.isNaN(Date.parse(String(searched.body["searchedAt"])))).toBe(
      false,
    );
    expect(host.reads.searches).toEqual([
      { query: "source material", options: { limit: 3, linkedLimit: 1 } },
    ]);

    expect((await postJson(host, "/api/search", { limit: 2 })).status).toBe(
      400,
    );

    host.reads.searchError = new MemoryError({
      operation: "search",
      stage: "input",
      persistence: "unchanged",
      reason: "The input is not a valid search request.",
    });
    const rejected = await postJson(host, "/api/search", {
      query: "source material",
    });
    expect(rejected.status).toBe(400);

    host.reads.searchError = new Error("the store is unavailable");
    const failed = await postJson(host, "/api/search", {
      query: "source material",
    });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "The search failed." });
    expect(failed.body).not.toHaveProperty("results");

    const compared = await postJson(host, "/api/compare", {
      leftId: uuid(0),
      rightId: uuid(1),
    });
    expect(compared.status).toBe(200);
    expect(compared.body).toEqual({
      similarity: 0.5,
      capturedAt: host.session.snapshot().view?.capturedAt,
    });
    expect(host.runner.comparisons).toEqual([
      { leftId: uuid(0), rightId: uuid(1) },
    ]);

    expect(
      (
        await postJson(host, "/api/compare", {
          leftId: uuid(0),
          rightId: uuid(60),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await postJson(host, "/api/compare", {
          leftId: "nope",
          rightId: uuid(1),
        })
      ).status,
    ).toBe(400);
  });

  it("publishes an empty collection as a ready view instead of a failure", async () => {
    const host = await startHost({ store: new PagedEmbeddedStore() });
    await host.session.settled();

    expect(await getGraph(host)).toEqual({
      status: 200,
      body: {
        status: "ready",
        refreshing: false,
        view: {
          capturedAt: expect.any(String) as unknown as string,
          embeddingSpaceId: "space-1",
          projectionId: "test-projection:0",
          layout: "non-semantic",
          bounds: { x: [-0.5, 0.5], y: [-0.5, 0.5] },
          nodes: [],
          edges: [],
        },
      },
    });
  });

  it("answers a comparison from the completed export that holds its vectors", async () => {
    const shared = [1, 0, 0, 0];
    const store = new GatedEmbeddedStore();
    store.seed(
      ...Array.from({ length: 20 }, (_, index): EmbeddedNote => ({
        note: note(index),
        vector:
          index === 0
            ? [...shared]
            : index === 1
              ? [0, 1, 0, 0]
              : vector(index),
      })),
    );
    const directory = await makeDirectory("amem-inspector-overlap-");
    let clock = Date.parse("2026-09-28T12:00:00.000Z");
    const session = new InspectionSession({
      source: new ScriptedSource(store),
      runner: createThreadProjectionRunner(),
      artifacts: createProjectionArtifactStore(directory),
      pollIntervalMs: 0,
      now: () => new Date((clock += 1_000)),
    });
    try {
      session.start();
      await session.settled();
      const before = session.snapshot();
      expect(before.status).toBe("ready");

      // Note 1 becomes equivalent to note 0 while the next export is held open. The comparison
      // must describe the completed export that holds its vectors, not the earlier view.
      store.records.set(uuid(1), { note: note(1), vector: [...shared] });
      store.holdPage(2);
      session.refresh();
      const compared = session.compare(uuid(0), uuid(1));
      store.releasePage();
      const result = await compared;

      expect(result.similarity).toBeCloseTo(1, 12);
      expect(result.capturedAt).toBe(session.snapshot().view?.capturedAt);
      expect(result.capturedAt).not.toBe(before.view?.capturedAt);
    } finally {
      await session.stop();
      await removeDirectory(directory);
    }
  }, 60_000);

  it("refuses a comparison whose note a pending refresh removed", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = await startHost();
    await host.session.settled();

    // The refresh that removes note 0 is held inside its projection while the comparison runs.
    host.runner.control({
      async project(request) {
        await gate;
        return scriptedArtifact(request);
      },
    });
    host.store.records.delete(uuid(0));
    host.session.refresh();
    const compared = host.session.compare(uuid(0), uuid(1));
    const expectation = expect(compared).rejects.toMatchObject({
      reason: "unknown-note",
    });
    release?.();
    await host.session.settled();

    await expectation;
  });

  it("coalesces refresh requests and rebuilds the projection only when asked", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new RecordingRunner({
      async project(request) {
        await gate;
        return scriptedArtifact(request);
      },
    });
    const host = await startHost({ runner });

    await waitFor(
      () => runner.projections.length === 1,
      "the initial projection",
    );
    const refresh = await postJson(host, "/api/refresh");
    const rebuild = await postJson(host, "/api/projection/rebuild");
    expect(refresh.status).toBe(202);
    expect(refresh.body).toMatchObject({ refreshing: true, status: "loading" });
    expect(rebuild.status).toBe(202);

    release?.();
    await host.session.settled();

    // Two requests during the first job coalesce into one more job, and the rebuild is kept.
    expect(runner.projections).toHaveLength(2);
    expect(runner.projections[0]?.rebuild).toBe(false);
    expect(runner.projections[1]?.rebuild).toBe(true);
  });

  it.each([false, true])(
    "runs ordinary queued refreshes without refitting after a rebuild (explicit follow-up: %s)",
    async (explicitFollowUp) => {
      const runner = new RecordingRunner();
      const host = await startHost({ runner });
      await host.session.settled();
      let release: (() => void) | undefined;
      runner.control({
        project: (request) =>
          new Promise((resolve) => {
            release = () => resolve(scriptedArtifact(request));
          }),
      });

      host.session.rebuild();
      await waitFor(() => runner.projections.length === 2, "the rebuild");
      host.session.refresh();
      if (explicitFollowUp) host.session.rebuild();
      host.session.refresh();
      release?.();
      await waitFor(() => runner.projections.length === 3, "the queued job");
      // A write/manual invalidation during the follow-up must also stay an ordinary refresh.
      host.session.refresh();
      host.session.refresh();
      release?.();
      await waitFor(() => runner.projections.length === 4, "the next refresh");
      release?.();
      await host.session.settled();

      expect(runner.projections.map((request) => request.rebuild)).toEqual([
        false,
        true,
        explicitFollowUp,
        false,
      ]);
      expect(host.session.snapshot().error).toBeUndefined();
    },
  );

  it("keeps a failed rebuild due for an ordinary queued refresh, then clears it", async () => {
    const runner = new RecordingRunner();
    const host = await startHost({ runner });
    await host.session.settled();
    let fail: (() => void) | undefined;
    runner.control({
      project: () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error("temporary projection failure"));
        }),
    });
    host.session.rebuild();
    await waitFor(() => runner.projections.length === 2, "the rebuild");
    host.session.refresh();
    runner.control({ project: async (request) => scriptedArtifact(request) });
    fail?.();
    await host.session.settled();
    host.session.refresh();
    await host.session.settled();

    expect(runner.projections.map((request) => request.rebuild)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(host.session.snapshot().error).toBeUndefined();
  });

  it("closes events and unsubscribes when the development listener cannot bind", async () => {
    const host = await startHost();
    await host.session.settled();
    const events = createGraphEvents({});
    const closeEvents = vi.spyOn(events, "close");
    const notify = vi.spyOn(events, "notify");
    try {
      await expect(
        startInspectionServer({
          reads: host.reads,
          session: host.session,
          uiDirectory: path.join(host.directory, "ui"),
          port: host.server.port,
          events,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(closeEvents).toHaveBeenCalledOnce();
      host.session.refresh();
      await host.session.settled();
      expect(notify).not.toHaveBeenCalled();
      expect((await getGraph(host)).status).toBe(200);
    } finally {
      await events.close();
    }
  });

  it("stops an in-flight export before its next page or projection", async () => {
    const store = new GatedEmbeddedStore();
    store.seed(...Array.from({ length: 5 }, (_, index) => record(index)));
    const runner = new RecordingRunner();
    const directory = await makeDirectory("amem-inspector-stop-");
    const session = new InspectionSession({
      source: new ScriptedSource(store),
      runner,
      artifacts: createProjectionArtifactStore(directory),
      pollIntervalMs: 0,
      pageLimit: 2,
    });
    try {
      store.holdPage(2);
      session.start();
      await waitFor(() => store.calls === 2, "the held second export page");

      await session.stop();

      expect(runner.closed).toBe(true);
      expect(runner.projections).toEqual([]);
      expect(store.calls).toBe(2);

      // The abandoned page never continues the traversal or publishes a view.
      store.releasePage();
      await session.settled();
      expect(store.calls).toBe(2);
      expect(runner.projections).toEqual([]);
      expect(session.snapshot()).toEqual({
        status: "loading",
        refreshing: false,
      });
    } finally {
      await session.stop();
      await removeDirectory(directory);
    }
  });

  it("releases the projection worker without waiting for stalled work", async () => {
    const store = new PagedEmbeddedStore();
    store.seed(...Array.from({ length: 5 }, (_, index) => record(index)));
    const runner = new RecordingRunner({
      project: () => new Promise<never>(() => undefined),
    });
    const directory = await makeDirectory("amem-inspector-stalled-");
    const session = new InspectionSession({
      source: new ScriptedSource(store),
      runner,
      artifacts: createProjectionArtifactStore(directory),
      pollIntervalMs: 0,
    });
    try {
      session.start();
      await waitFor(
        () => runner.projections.length === 1,
        "the stalled projection",
      );

      await session.stop();

      expect(runner.closed).toBe(true);
      expect(session.snapshot().view).toBeUndefined();
    } finally {
      await session.stop();
      await removeDirectory(directory);
    }
  });

  it("keeps the last successful view and reports sanitized failures", async () => {
    // A fixed clock keeps `capturedAt` comparable across the refreshes of this case.
    const host = await startHost({
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });
    await host.session.settled();
    const first = host.session.snapshot();
    expect(first.status).toBe("ready");

    host.runner.control({
      project: () => Promise.reject(new Error("the projection exploded")),
    });
    host.session.refresh();
    await host.session.settled();
    expect(host.session.snapshot()).toEqual({
      status: "ready",
      refreshing: false,
      error: "The last inspection projection failed.",
      view: first.view,
    });

    host.runner.control({
      project: (request) => Promise.resolve(scriptedArtifact(request)),
    });
    host.store.exportError = new Error("the export exploded");
    host.session.refresh();
    await host.session.settled();
    expect(host.session.snapshot()).toEqual({
      status: "ready",
      refreshing: false,
      error: "The last inspection export failed.",
      view: first.view,
    });

    host.store.exportError = undefined;
    host.session.refresh();
    await host.session.settled();
    expect(host.session.snapshot()).toEqual({
      status: "ready",
      refreshing: false,
      view: first.view,
    });
  });

  it("reports a failed first view as an error instead of an empty graph", async () => {
    const store = seededStore();
    store.exportError = new Error("the export exploded");
    const host = await startHost({ store, start: false });
    host.session.start();
    await host.session.settled();

    expect(await getGraph(host)).toEqual({
      status: 200,
      body: {
        status: "error",
        refreshing: false,
        error: "The last inspection export failed.",
      },
    });
    expect(
      (
        await postJson(host, "/api/compare", {
          leftId: uuid(0),
          rightId: uuid(1),
        })
      ).status,
    ).toBe(409);
  });

  it("serves the static UI and refuses paths outside its directory", async () => {
    const host = await startHost({ start: false });
    const index = await fetch(`${host.baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain("Inspection UI");

    expect((await fetch(`${host.baseUrl}/missing.js`)).status).toBe(404);

    await writeFile(path.join(host.directory, "secret.txt"), "secret", "utf8");
    // An encoded separator keeps the dot segments out of URL normalization, so the file lookup
    // itself has to refuse the path that leaves the UI directory.
    const traversal = await fetch(`${host.baseUrl}/%2e%2e%2fsecret.txt`);
    expect(traversal.status).toBe(404);
    await expect(traversal.text()).resolves.not.toContain("secret");

    const wrongMethod = await fetch(`${host.baseUrl}/`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
  });

  it("refreshes periodically once the first completed view is published", async () => {
    const host = await startHost({ pollIntervalMs: 20 });
    await host.session.settled();
    const initialProjections = host.runner.projections.length;

    await waitFor(
      () => host.runner.projections.length > initialProjections,
      "a periodic refresh",
    );
    expect(host.store.exports.length).toBeGreaterThan(1);
  });

  it("offers a stored projection to the next host only after a fresh export", async () => {
    const artifacts = await makeDirectory("amem-inspector-artifacts-");
    const sessions: InspectionSession[] = [];
    try {
      const first = await startHost({
        artifactsDirectory: artifacts,
        start: false,
      });
      sessions.push(first.session);
      first.session.start();
      await first.session.settled();
      const stored = JSON.parse(
        await readFile(path.join(artifacts, "projection.json"), "utf8"),
      ) as unknown;

      const restarted = await startHost({
        artifactsDirectory: artifacts,
        start: false,
      });
      sessions.push(restarted.session);
      // A stored projection is never presented as current before a fresh export completes.
      expect(restarted.session.snapshot()).toEqual({
        status: "loading",
        refreshing: false,
      });
      restarted.session.start();
      await waitFor(
        () => restarted.runner.projections.length === 1,
        "the restarted projection request",
      );
      expect(restarted.runner.projections[0]?.cached).toEqual(stored);
      await restarted.session.settled();
      expect(restarted.session.snapshot().status).toBe("ready");
    } finally {
      for (const session of sessions) {
        await session.settled();
      }
      await removeDirectory(artifacts);
    }
  });

  it("rejects a search body that is not valid JSON", async () => {
    const host = await startHost({ start: false });
    const response = await fetch(`${host.baseUrl}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The request body is not valid JSON.",
    });
  });
});
