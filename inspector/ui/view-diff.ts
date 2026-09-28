/**
 * The browser's view planner: validate one `GET /api/graph` payload, compare it with the last
 * accepted completed view and describe the Graphology mutations that bring the display up to
 * date. The work is pure and runs in a worker, so the main thread only applies the plan.
 *
 * See docs/dashboard.md#browser-api, docs/dashboard.md#live-updates-with-sigma and
 * docs/dashboard.md#asynchronous-data-updates.
 */
import {
  graphSnapshotSchema,
  type GraphBounds,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "../payloads.js";
import { memoryKey } from "./identity.js";

/** The stable identity of one directed link, shared with the graph model. */
export const linkKey = (source: string, target: string): string =>
  `${memoryKey(source)}\u0000${memoryKey(target)}`;

/**
 * The comparable identity of one displayed memory: the served evidence a refresh can change. The
 * display model and the planner build it the same way, so a fallback can plan against the graph
 * that is actually on screen.
 */
export const nodeIdentity = (node: {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly updatedAt?: string | undefined;
}): string =>
  JSON.stringify([node.label, node.x, node.y, node.updatedAt ?? null]);

/** The compact state one planned diff is compared against. */
export interface ViewIndex {
  readonly nodes: ReadonlyMap<string, string>;
  readonly links: ReadonlySet<string>;
}

/** The identity and extent of a completed view, without its node and link payloads. */
export interface ViewSummary {
  readonly capturedAt: string;
  readonly embeddingSpaceId: string;
  readonly projectionId: string;
  readonly layout: "umap" | "non-semantic";
  readonly bounds: GraphBounds;
  readonly nodeCount: number;
  readonly linkCount: number;
}

/** The mutations that turn the displayed graph into one served view. */
export interface ViewDiff {
  readonly status: GraphSnapshot["status"];
  readonly refreshing: boolean;
  readonly error: string | undefined;
  /** The completed view this plan describes, or `undefined` while none is ready. */
  readonly summary: ViewSummary | undefined;
  /** The full node and link payload to apply; empty for an unchanged or unavailable view. */
  readonly addedNodes: readonly GraphNode[];
  readonly removedNodeIds: readonly string[];
  readonly updatedNodes: readonly GraphNode[];
  readonly addedLinks: readonly GraphEdge[];
  readonly removedLinkKeys: readonly string[];
  /** True when the plan starts from an empty display. */
  readonly initial: boolean;
}

/** Parse and validate one served snapshot; a malformed payload never becomes an empty view. */
export const parseGraphSnapshot = (text: string): GraphSnapshot => {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The graph response is not valid JSON.");
  }
  const parsed = graphSnapshotSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      "The graph response does not match the documented inspection contract.",
    );
  }
  return parsed.data;
};

/** Index one completed view by stable identity. */
export const indexView = (view: GraphSnapshot["view"]): ViewIndex => {
  if (view === undefined) {
    throw new Error("A view index needs a completed view.");
  }
  return {
    nodes: new Map(
      view.nodes.map((node) => [memoryKey(node.id), nodeIdentity(node)]),
    ),
    links: new Set(view.edges.map((edge) => linkKey(edge.source, edge.target))),
  };
};

const summaryOf = (view: NonNullable<GraphSnapshot["view"]>): ViewSummary => ({
  capturedAt: view.capturedAt,
  embeddingSpaceId: view.embeddingSpaceId,
  projectionId: view.projectionId,
  layout: view.layout,
  bounds: view.bounds,
  nodeCount: view.nodes.length,
  linkCount: view.edges.length,
});

const emptyPlan = (snapshot: GraphSnapshot): ViewDiff => ({
  status: snapshot.status,
  refreshing: snapshot.refreshing,
  error: snapshot.error,
  summary: undefined,
  addedNodes: [],
  removedNodeIds: [],
  updatedNodes: [],
  addedLinks: [],
  removedLinkKeys: [],
  initial: false,
});

/**
 * Diff one validated snapshot against the last accepted completed view. A status without a
 * completed view plans no mutation, so an incomplete or failed poll never becomes a deletion.
 */
export const planViewDiff = (
  previous: ViewIndex | undefined,
  snapshot: GraphSnapshot,
): ViewDiff => {
  const view = snapshot.view;
  if (view === undefined) {
    return emptyPlan(snapshot);
  }
  const nodes = new Map(view.nodes.map((node) => [memoryKey(node.id), node]));
  const links = new Set(
    view.edges.map((edge) => linkKey(edge.source, edge.target)),
  );

  if (previous === undefined) {
    return {
      status: snapshot.status,
      refreshing: snapshot.refreshing,
      error: snapshot.error,
      summary: summaryOf(view),
      addedNodes: view.nodes,
      removedNodeIds: [],
      updatedNodes: [],
      addedLinks: view.edges,
      removedLinkKeys: [],
      initial: true,
    };
  }

  const addedNodes = view.nodes.filter(
    (node) => !previous.nodes.has(memoryKey(node.id)),
  );
  const updatedNodes = view.nodes.filter((node) => {
    const before = previous.nodes.get(memoryKey(node.id));
    return before !== undefined && before !== nodeIdentity(node);
  });
  const removedNodeIds = [...previous.nodes.keys()].filter(
    (id) => !nodes.has(id),
  );
  const addedLinks = view.edges.filter(
    (edge) => !previous.links.has(linkKey(edge.source, edge.target)),
  );
  const removedLinkKeys = [...previous.links].filter((key) => !links.has(key));
  return {
    status: snapshot.status,
    refreshing: snapshot.refreshing,
    error: snapshot.error,
    summary: summaryOf(view),
    addedNodes,
    removedNodeIds,
    updatedNodes,
    addedLinks,
    removedLinkKeys,
    initial: false,
  };
};

/** One request to the parsing worker. */
export interface ViewPlanRequest {
  readonly id: number;
  readonly text: string;
}

/** One worker answer: the planned mutations or the reason the payload was rejected. */
export type ViewPlanResponse =
  | { readonly id: number; readonly diff: ViewDiff }
  | { readonly id: number; readonly error: string };

/** Parse, validate and diff the served graph payload off the main thread. */
export interface ViewDiffer {
  plan(text: string): Promise<ViewDiff>;
  /**
   * Adopt the displayed view as the planning baseline. A worker keeps its own history; the inline
   * planner needs the handoff to reconcile the display after a worker failure instead of planning
   * against an empty baseline.
   */
  adopt(index: ViewIndex | undefined): void;
  /** Whether the current plans run in a worker; the responsiveness check records it. */
  usesWorker(): boolean;
  dispose(): void;
}

/**
 * A differ that keeps the last accepted view and computes plans on the calling thread. It backs
 * tests and browsers without worker support with the same planning rules as the worker.
 */
export const createInlineViewDiffer = (): ViewDiffer => {
  let previous: ViewIndex | undefined;
  return {
    plan: (text: string): Promise<ViewDiff> => {
      try {
        const snapshot = parseGraphSnapshot(text);
        const diff = planViewDiff(previous, snapshot);
        if (snapshot.view !== undefined) {
          previous = indexView(snapshot.view);
        }
        return Promise.resolve(diff);
      } catch (cause) {
        return Promise.reject(cause);
      }
    },
    adopt: (index: ViewIndex | undefined): void => {
      previous = index;
    },
    usesWorker: (): boolean => false,
    dispose: (): void => {
      previous = undefined;
    },
  };
};

/**
 * A served payload the planner had to reject. The worker itself stays healthy, so the caller keeps
 * using it instead of replacing it with the inline planner.
 */
export class ViewPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewPlanError";
  }
}

/** The planning operations of one differ with its history; the worker owns that history. */
interface Planner {
  plan(text: string): Promise<ViewDiff>;
  dispose(): void;
}

const createWorkerViewDiffer = (worker: Worker): Planner => {
  let nextId = 1;
  let disposed = false;
  const pending = new Map<
    number,
    { resolve: (diff: ViewDiff) => void; reject: (cause: Error) => void }
  >();
  const fail = (cause: Error): void => {
    disposed = true;
    for (const entry of pending.values()) {
      entry.reject(cause);
    }
    pending.clear();
  };
  worker.addEventListener(
    "message",
    (event: MessageEvent<ViewPlanResponse>) => {
      const response = event.data;
      const entry = pending.get(response.id);
      if (entry === undefined) {
        return;
      }
      pending.delete(response.id);
      if ("diff" in response) {
        entry.resolve(response.diff);
      } else {
        entry.reject(new ViewPlanError(response.error));
      }
    },
  );
  worker.addEventListener("error", () => {
    fail(new Error("The graph parsing worker failed."));
  });
  worker.addEventListener("messageerror", () => {
    fail(new Error("The graph parsing worker could not be read."));
  });
  return {
    plan: (text: string): Promise<ViewDiff> =>
      new Promise<ViewDiff>((resolve, reject) => {
        if (disposed) {
          reject(new Error("The graph parsing worker is disposed."));
          return;
        }
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, text } satisfies ViewPlanRequest);
      }),
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const entry of pending.values()) {
        entry.reject(new Error("The graph parsing worker is disposed."));
      }
      pending.clear();
      worker.terminate();
    },
  };
};

/**
 * Plan served payloads in a worker when the browser supports one. A worker that cannot start or
 * fails while parsing falls back to inline planning; the fallback plans against the displayed view
 * the dashboard adopted, so a replacement plan still reconciles removals and never fits the camera
 * of an existing view.
 */
export const createViewDiffer = (): ViewDiffer => {
  const inline = createInlineViewDiffer();
  let worker: Worker | undefined;
  let active: Planner | undefined;
  if (typeof Worker !== "undefined") {
    try {
      // The build emits the worker next to this bundle; the indirection keeps the bundler from
      // folding the reference while the browser still resolves it against the module URL.
      const workerFile = "view-worker.js";
      worker = new Worker(new URL(workerFile, import.meta.url), {
        type: "module",
      });
      active = createWorkerViewDiffer(worker);
    } catch {
      worker = undefined;
      active = undefined;
    }
  }
  const fallBackToInline = (cause: unknown): Planner => {
    console.warn(
      "[inspector] graph parsing worker unavailable, diffing inline:",
      cause,
    );
    active?.dispose();
    worker?.terminate();
    worker = undefined;
    active = undefined;
    return inline;
  };
  return {
    plan: (text: string): Promise<ViewDiff> => {
      const differ = active;
      if (differ === undefined) {
        return inline.plan(text);
      }
      return differ.plan(text).catch((cause: unknown) => {
        // A rejected payload is not a broken worker: the same payload fails inline, and the
        // worker keeps its history for the next poll.
        if (cause instanceof ViewPlanError) {
          throw cause;
        }
        return fallBackToInline(cause).plan(text);
      });
    },
    adopt: (index: ViewIndex | undefined): void => {
      inline.adopt(index);
    },
    /** Whether requests currently run in a worker; the responsiveness check records it. */
    usesWorker: (): boolean => active !== undefined,
    dispose: (): void => {
      active?.dispose();
      worker?.terminate();
      worker = undefined;
      active = undefined;
      inline.dispose();
    },
  };
};
