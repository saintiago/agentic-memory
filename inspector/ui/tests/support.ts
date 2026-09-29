/**
 * Controlled substitutes and small fixtures for the dashboard component tests. The dashboard,
 * its model, its planner and its panels are exercised for real; only the HTTP host and the WebGL
 * renderer are substituted, because neither a collection nor a browser belongs in a unit test.
 *
 * See docs/testing.md#choosing-scope.
 */
import type { Note } from "../../../src/note-store/index.js";
import type {
  GraphBounds,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphView,
  SearchOutcome,
} from "../../payloads.js";
import type { Comparison, InspectorClient } from "../client.js";
import type {
  EventSocket,
  GraphEventHandlers,
  GraphEventStream,
} from "../events.js";
import type { SearchRequest } from "../results.js";
import type { CameraSnapshot, DashboardRenderer } from "../renderer.js";
import type { TimerScheduler } from "../timer.js";

/** A stable UUID-shaped identity for the supplied index. */
export const nodeId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/** One note contract value with overridable fields. */
export const note = (index: number, overrides: Partial<Note> = {}): Note => ({
  id: nodeId(index),
  content: `Memory ${String(index)}`,
  timestamp: "2026-09-20T10:00:00.000Z",
  context: `Context ${String(index)}`,
  keywords: [`keyword ${String(index)}`],
  tags: ["test"],
  links: [],
  ...overrides,
});

/** One displayed memory at a deterministic projected position. */
export const graphNode = (
  index: number,
  overrides: Partial<GraphNode> = {},
): GraphNode => ({
  id: nodeId(index),
  label: `Memory ${String(index)}`,
  x: index,
  y: -index,
  ...overrides,
});

export const graphEdge = (source: number, target: number): GraphEdge => ({
  source: nodeId(source),
  target: nodeId(target),
});

export const graphBounds = (nodes: readonly GraphNode[]): GraphBounds => ({
  x: [
    Math.min(...nodes.map((node) => node.x)),
    Math.max(...nodes.map((node) => node.x)),
  ],
  y: [
    Math.min(...nodes.map((node) => node.y)),
    Math.max(...nodes.map((node) => node.y)),
  ],
});

/** One completed view over the supplied nodes and links. */
export const graphView = (options: {
  readonly nodes: readonly GraphNode[];
  readonly edges?: readonly GraphEdge[];
  readonly capturedAt?: string;
  readonly projectionId?: string;
  readonly layout?: "umap" | "non-semantic";
}): GraphView => {
  const nodes = [...options.nodes];
  return {
    capturedAt: options.capturedAt ?? "2026-09-28T12:00:00.000Z",
    embeddingSpaceId: "test-space",
    projectionId: options.projectionId ?? "test-projection",
    layout: options.layout ?? "umap",
    bounds: graphBounds(nodes),
    nodes,
    edges: [...(options.edges ?? [])],
  };
};

/** One served snapshot, ready unless the case says otherwise. */
export const graphSnapshot = (options: {
  readonly view?: GraphView;
  readonly status?: "loading" | "ready" | "error";
  readonly refreshing?: boolean;
  readonly error?: string;
}): GraphSnapshot => ({
  status: options.status ?? (options.view === undefined ? "loading" : "ready"),
  refreshing: options.refreshing ?? false,
  ...(options.error === undefined ? {} : { error: options.error }),
  ...(options.view === undefined ? {} : { view: options.view }),
});

export const snapshotText = (snapshot: GraphSnapshot): string =>
  JSON.stringify(snapshot);

/** One search response over the supplied notes. */
export const searchOutcome = (
  results: SearchOutcome["results"],
  searchedAt = "2026-09-28T12:05:00.000Z",
): SearchOutcome => ({ searchedAt, results });

/** The renderer substitute: it records every camera and style request and never draws. */
export class FakeRenderer implements DashboardRenderer {
  readonly bounds: GraphBounds[] = [];
  readonly fittedNodes: string[][] = [];
  readonly focused: string[] = [];
  fits = 0;
  styleChanges = 0;
  disposed = false;
  camera: CameraSnapshot = { x: 0.5, y: 0.5, ratio: 1 };

  styleChanged(): void {
    this.styleChanges += 1;
  }

  includeBounds(bounds: GraphBounds): void {
    this.bounds.push(bounds);
  }

  fitAll(): void {
    this.fits += 1;
  }

  fitNodes(nodeIds: readonly string[]): void {
    this.fittedNodes.push([...nodeIds]);
  }

  focus(nodeId: string): void {
    this.focused.push(nodeId);
  }

  cameraState(): CameraSnapshot {
    return { ...this.camera };
  }

  viewportPosition(): { readonly x: number; readonly y: number } {
    return { x: 0, y: 0 };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** The HTTP host substitute: every route has a replaceable handler and a call record. */
export class StubClient implements InspectorClient {
  graphHandler: () => Promise<string> = () =>
    Promise.resolve(
      snapshotText(graphSnapshot({ view: graphView({ nodes: [] }) })),
    );
  noteHandler: (nodeId: string) => Promise<Note | undefined> = () =>
    Promise.resolve(undefined);
  searchHandler: (request: SearchRequest) => Promise<SearchOutcome> = () =>
    Promise.resolve(searchOutcome([]));
  comparisonHandler: (leftId: string, rightId: string) => Promise<Comparison> =
    () =>
      Promise.resolve({
        similarity: 0.5,
        capturedAt: "2026-09-28T12:00:00.000Z",
      });
  refreshHandler: () => Promise<void> = () => Promise.resolve();
  rebuildHandler: () => Promise<void> = () => Promise.resolve();
  readonly calls = {
    graph: 0,
    note: [] as string[],
    search: [] as SearchRequest[],
    compare: [] as Array<{ leftId: string; rightId: string }>,
    refresh: 0,
    rebuild: 0,
  };

  graphText(): Promise<string> {
    this.calls.graph += 1;
    return this.graphHandler();
  }

  note(nodeId: string): Promise<Note | undefined> {
    this.calls.note.push(nodeId);
    return this.noteHandler(nodeId);
  }

  search(request: SearchRequest): Promise<SearchOutcome> {
    this.calls.search.push(request);
    return this.searchHandler(request);
  }

  refresh(): Promise<void> {
    this.calls.refresh += 1;
    return this.refreshHandler();
  }

  rebuildProjection(): Promise<void> {
    this.calls.rebuild += 1;
    return this.rebuildHandler();
  }

  compare(leftId: string, rightId: string): Promise<Comparison> {
    this.calls.compare.push({ leftId, rightId });
    return this.comparisonHandler(leftId, rightId);
  }
}

/**
 * The event-channel substitute: the dashboard subscribes here and the case delivers connection
 * state and notifications. Like the live channel, `start()` resyncs by default.
 */
export class ScriptedEvents {
  handlers: GraphEventHandlers | undefined;
  started = 0;
  stopped = 0;
  /** Whether starting the stream delivers the resync of a fresh connection. */
  autoResync = true;
  readonly stream: GraphEventStream = {
    start: () => {
      this.started += 1;
      if (this.autoResync) {
        this.resync();
      }
    },
    stop: () => {
      this.stopped += 1;
    },
  };

  /** The factory the dashboard subscribes with. */
  readonly subscribe = (handlers: GraphEventHandlers): GraphEventStream => {
    this.handlers = handlers;
    return this.stream;
  };

  /** Deliver the resync of a fresh connection. */
  resync(): void {
    this.handlers?.onResync();
  }

  /** Deliver a graph-changed notification. */
  changed(): void {
    this.handlers?.onResync();
  }

  connected(): void {
    this.handlers?.onStatus?.("connected");
  }

  reconnecting(): void {
    this.handlers?.onStatus?.("reconnecting");
  }
}

/** A timer scheduler the case advances explicitly, for bounded-backoff assertions. */
export class ManualScheduler implements TimerScheduler {
  #next = 1;
  #now = 0;
  readonly timers = new Map<number, { at: number; handler: () => void }>();

  setTimeout(handler: () => void, delayMs: number): number {
    const handle = this.#next;
    this.#next += 1;
    this.timers.set(handle, { at: this.#now + delayMs, handler });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  /** The delay of the earliest pending timer, or undefined when none waits. */
  get nextDelayMs(): number | undefined {
    let earliest: number | undefined;
    for (const timer of this.timers.values()) {
      const delay = timer.at - this.#now;
      if (earliest === undefined || delay < earliest) {
        earliest = delay;
      }
    }
    return earliest;
  }

  /** Advance the clock and run every timer that becomes due, including newly scheduled ones. */
  advance(ms: number): void {
    this.#now += ms;
    for (;;) {
      let due:
        | { handle: number; timer: { at: number; handler: () => void } }
        | undefined;
      for (const [handle, timer] of this.timers) {
        if (
          timer.at <= this.#now &&
          (due === undefined || timer.at < due.timer.at)
        ) {
          due = { handle, timer };
        }
      }
      if (due === undefined) {
        return;
      }
      this.timers.delete(due.handle);
      due.timer.handler();
    }
  }
}

/** A WebSocket substitute the event-stream test drives frame by frame. */
export class FakeSocket implements EventSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  /** Simulate the handshake completing. */
  open(): void {
    this.onopen?.();
  }

  /** Simulate one received JSON text message. */
  message(body: unknown): void {
    this.onmessage?.({ data: JSON.stringify(body) });
  }

  /** Simulate a raw (possibly malformed) text message. */
  raw(text: string): void {
    this.onmessage?.({ data: text });
  }

  /** Simulate the connection dropping. */
  drop(): void {
    this.onclose?.();
  }
}

/** Await a condition another asynchronous operation satisfies. */
export const waitFor = async (
  condition: () => boolean,
  description = "the condition",
): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
};
