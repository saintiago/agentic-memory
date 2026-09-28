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

/** The stable identity of one directed link, shared with the graph model. */
export const linkKey = (source: string, target: string): string =>
  `${source}\u0000${target}`;

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
      view.nodes.map((node) => [
        node.id,
        JSON.stringify([node.label, node.x, node.y, node.updatedAt ?? null]),
      ]),
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
  const nodes = new Map(view.nodes.map((node) => [node.id, node]));
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

  const addedNodes = view.nodes.filter((node) => !previous.nodes.has(node.id));
  const updatedNodes = view.nodes.filter((node) => {
    const before = previous.nodes.get(node.id);
    return (
      before !== undefined &&
      before !==
        JSON.stringify([node.label, node.x, node.y, node.updatedAt ?? null])
    );
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
    usesWorker: (): boolean => false,
    dispose: (): void => {
      previous = undefined;
    },
  };
};

const createWorkerViewDiffer = (worker: Worker): ViewDiffer => {
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
        entry.reject(new Error(response.error));
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
    usesWorker: (): boolean => true,
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
 * fails while parsing falls back to inline planning; applying a plan is idempotent, so the
 * fallback can only repeat work, never corrupt the display.
 */
export const createViewDiffer = (): ViewDiffer => {
  const inline = createInlineViewDiffer();
  let worker: Worker | undefined;
  let active: ViewDiffer | undefined;
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
  const fallBackToInline = (cause: unknown): ViewDiffer => {
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
      return differ
        .plan(text)
        .catch((cause: unknown) => fallBackToInline(cause).plan(text));
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
