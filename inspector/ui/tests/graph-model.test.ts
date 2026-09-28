/**
 * The displayed graph model: exact stored identities and directed links at the supplied projected
 * positions, refreshes that keep other coordinates, removals only from completed views, batching
 * between frames and the payload validation the planner performs.
 *
 * See docs/dashboard.md#live-updates-with-sigma, docs/dashboard.md#acceptance-checks.
 */
import { describe, expect, it } from "vitest";

import { SearchResults } from "../results.js";
import { nodeStyle, linkStyle } from "../style.js";
import { GraphModel, type ResultsSource } from "../graph-model.js";
import {
  linkKey,
  nodeIdentity,
  indexView,
  parseGraphSnapshot,
  planViewDiff,
  type ViewDiff,
} from "../view-diff.js";
import {
  graphEdge,
  graphNode,
  graphSnapshot,
  graphView,
  nodeId,
  note,
  searchOutcome,
  snapshotText,
} from "./support.js";

const noResults: ResultsSource = {
  highlightIds: new Set(),
  retrievalKind: () => undefined,
};

const model = (now = 0): GraphModel =>
  new GraphModel({ results: noResults, now: () => now });

const apply = async (
  graph: GraphModel,
  snapshot: Parameters<typeof planViewDiff>[1],
  previous?: ReturnType<typeof indexView>,
): Promise<ViewDiff> => {
  const diff = planViewDiff(previous, snapshot);
  await graph.applyDiff(diff, { yieldFrame: () => Promise.resolve() });
  return diff;
};

describe("displayed graph", () => {
  it("renders the exact stored identities and directed links at the supplied positions", async () => {
    const graph = model();
    const view = graphView({
      nodes: [
        graphNode(0, { x: 0, y: 0 }),
        graphNode(1, { x: 1.5, y: -2 }),
        graphNode(2, { x: -3, y: 0.25 }),
      ],
      edges: [graphEdge(0, 1), graphEdge(2, 0)],
    });

    const diff = await apply(graph, graphSnapshot({ view }));

    expect(diff.initial).toBe(true);
    expect(graph.graph.nodes().sort()).toEqual(
      [nodeId(0), nodeId(1), nodeId(2)].sort(),
    );
    expect(graph.graph.getNodeAttributes(nodeId(1))).toEqual({
      label: "Memory 1",
      x: 1.5,
      y: -2,
    });
    expect(graph.graph.hasDirectedEdge(nodeId(0), nodeId(1))).toBe(true);
    expect(graph.graph.hasDirectedEdge(nodeId(1), nodeId(0))).toBe(false);
    expect(graph.graph.hasDirectedEdge(nodeId(2), nodeId(0))).toBe(true);
    expect(graph.counts()).toEqual({ nodes: 3, links: 2 });
  });

  it("adds links without changing the coordinates of existing memories", async () => {
    const graph = model();
    const first = graphView({
      nodes: [graphNode(0), graphNode(1), graphNode(2)],
    });
    const firstDiff = await apply(graph, graphSnapshot({ view: first }));
    const before = graph.graph.getNodeAttributes(nodeId(2));

    const second = graphView({
      nodes: [graphNode(0), graphNode(1), graphNode(2)],
      edges: [graphEdge(0, 1), graphEdge(1, 2)],
      capturedAt: "2026-09-28T12:01:00.000Z",
    });
    const secondDiff = planViewDiff(
      indexView(firstDiff.summary === undefined ? undefined : first),
      graphSnapshot({ view: second }),
    );
    await graph.applyDiff(secondDiff, { yieldFrame: () => Promise.resolve() });

    expect(secondDiff.updatedNodes).toEqual([]);
    expect(secondDiff.addedLinks).toHaveLength(2);
    expect(graph.graph.getNodeAttributes(nodeId(2))).toEqual(before);
    expect(graph.graph.size).toBe(2);
  });

  it("adds, updates and removes memories and links of one completed view", async () => {
    const graph = model();
    const first = graphView({
      nodes: [graphNode(0), graphNode(1), graphNode(2)],
      edges: [graphEdge(0, 1), graphEdge(1, 2)],
    });
    await apply(graph, graphSnapshot({ view: first }));

    const second = graphView({
      nodes: [
        graphNode(0, {
          label: "renamed",
          updatedAt: "2026-09-28T11:00:00.000Z",
        }),
        graphNode(1, { x: 42, y: 42 }),
        graphNode(3, { x: 7, y: 7 }),
      ],
      edges: [graphEdge(1, 3)],
      capturedAt: "2026-09-28T12:01:00.000Z",
    });
    const diff = await apply(
      graph,
      graphSnapshot({ view: second }),
      indexView(first),
    );

    expect(diff.updatedNodes.map((node) => node.id)).toEqual([
      nodeId(0),
      nodeId(1),
    ]);
    expect(diff.addedNodes.map((node) => node.id)).toEqual([nodeId(3)]);
    expect(diff.removedNodeIds).toEqual([nodeId(2)]);
    expect(diff.addedLinks).toEqual([graphEdge(1, 3)]);
    expect(diff.removedLinkKeys).toHaveLength(2);
    expect(graph.graph.hasNode(nodeId(2))).toBe(false);
    expect(graph.graph.getNodeAttributes(nodeId(0)).label).toBe("renamed");
    expect(graph.graph.getNodeAttributes(nodeId(1))).toMatchObject({
      x: 42,
      y: 42,
    });
    expect(
      graph.graph.getEdgeAttributes(`${nodeId(1)}\u0000${nodeId(3)}`),
    ).toEqual({
      kind: "link",
    });
    expect(graph.counts()).toEqual({ nodes: 3, links: 1 });
  });

  it("marks every memory as changed when a full refit moves the coordinates", async () => {
    const graph = model();
    const first = graphView({
      nodes: [graphNode(0), graphNode(1)],
      edges: [graphEdge(0, 1)],
    });
    await apply(graph, graphSnapshot({ view: first }));

    const refit = graphView({
      nodes: [
        graphNode(0, { x: 100, y: 100 }),
        graphNode(1, { x: 200, y: 200 }),
      ],
      edges: [graphEdge(0, 1)],
      projectionId: "test-projection:rebuild",
      capturedAt: "2026-09-28T12:02:00.000Z",
    });
    const diff = await apply(
      graph,
      graphSnapshot({ view: refit }),
      indexView(first),
    );

    expect(diff.summary?.projectionId).toBe("test-projection:rebuild");
    expect(diff.updatedNodes).toHaveLength(2);
    expect(diff.addedLinks).toEqual([]);
    expect(graph.graph.getNodeAttributes(nodeId(0))).toMatchObject({
      x: 100,
      y: 100,
    });
  });

  it("never infers a deletion from an unavailable or failed view", async () => {
    const graph = model();
    const view = graphView({ nodes: [graphNode(0), graphNode(1)] });
    await apply(graph, graphSnapshot({ view }));

    const failed = graphSnapshot({
      view,
      status: "ready",
      error: "The last inspection export failed.",
    });
    const diff = await apply(graph, failed, indexView(view));

    expect(diff.error).toBe("The last inspection export failed.");
    expect(diff.addedNodes).toEqual([]);
    expect(diff.removedNodeIds).toEqual([]);
    expect(diff.addedLinks).toEqual([]);
    expect(diff.removedLinkKeys).toEqual([]);
    expect(graph.counts()).toEqual({ nodes: 2, links: 0 });

    const loading = graphSnapshot({ status: "loading" });
    const loadingDiff = await apply(graph, loading, indexView(view));
    expect(loadingDiff.summary).toBeUndefined();
    expect(loadingDiff.status).toBe("loading");
    expect(graph.counts()).toEqual({ nodes: 2, links: 0 });
  });

  it("clears a selection whose memory disappeared from a completed view", async () => {
    const graph = model();
    const first = graphView({ nodes: [graphNode(0), graphNode(1)] });
    await apply(graph, graphSnapshot({ view: first }));
    expect(graph.select(nodeId(1))).toBe(true);

    const second = graphView({ nodes: [graphNode(0)] });
    const report = await graph.applyDiff(
      planViewDiff(indexView(first), graphSnapshot({ view: second })),
      { yieldFrame: () => Promise.resolve() },
    );

    expect(report.selectionCleared).toBe(true);
    expect(graph.selectedId).toBeUndefined();
  });

  it("applies a repeated plan without duplicating anything", async () => {
    const graph = model();
    const view = graphView({
      nodes: [graphNode(0), graphNode(1)],
      edges: [graphEdge(0, 1)],
    });
    const diff = planViewDiff(undefined, graphSnapshot({ view }));

    await graph.applyDiff(diff, { yieldFrame: () => Promise.resolve() });
    await graph.applyDiff(diff, { yieldFrame: () => Promise.resolve() });

    expect(graph.counts()).toEqual({ nodes: 2, links: 1 });
  });

  it("yields between bounded mutation batches", async () => {
    const graph = model();
    const view = graphView({
      nodes: [0, 1, 2, 3, 4, 5].map((index) => graphNode(index)),
    });
    const yields: number[] = [];
    const report = await graph.applyDiff(
      planViewDiff(undefined, graphSnapshot({ view })),
      {
        batchSize: 2,
        yieldFrame: () => {
          yields.push(graph.graph.order);
          return Promise.resolve();
        },
      },
    );

    expect(report.batches).toBe(3);
    expect(yields).toEqual([2, 4]);
  });

  it("applies a projection refit atomically across the production batch boundary", async () => {
    const count = 5_001;
    const graph = model();
    const first = graphView({
      nodes: Array.from({ length: count }, (_, index) => graphNode(index)),
    });
    await apply(graph, graphSnapshot({ view: first }));

    const refit = graphView({
      nodes: Array.from({ length: count }, (_, index) =>
        graphNode(index, { x: 100 + index, y: -100 - index }),
      ),
      projectionId: "test-projection:rebuild",
      capturedAt: "2026-09-28T12:02:00.000Z",
    });
    const observed: number[][] = [];
    const report = await graph.applyDiff(
      planViewDiff(indexView(first), graphSnapshot({ view: refit })),
      {
        // A frame between batches would render a mixture of both coordinate systems.
        atomic: true,
        yieldFrame: () => {
          observed.push(
            graph.graph
              .nodes()
              .map((id) => graph.graph.getNodeAttributes(id).x),
          );
          return Promise.resolve();
        },
      },
    );

    expect(observed).toEqual([]);
    expect(report.batches).toBe(1);
    expect(report.updatedNodes).toBe(count);
    expect(
      graph.graph
        .nodes()
        .every((id) => graph.graph.getNodeAttributes(id).x >= 100),
    ).toBe(true);
  });

  it("describes the displayed graph as the planner's baseline", async () => {
    const graph = model();
    expect(graph.viewIndex()).toBeUndefined();

    const view = graphView({
      nodes: [
        graphNode(0),
        graphNode(1, { updatedAt: "2026-09-28T11:00:00.000Z" }),
      ],
      edges: [graphEdge(1, 0)],
    });
    await apply(graph, graphSnapshot({ view }));

    const index = graph.viewIndex();
    expect(index?.nodes.get(nodeId(0))).toBe(nodeIdentity(graphNode(0)));
    expect(index?.nodes.get(nodeId(1))).toBe(
      nodeIdentity(graphNode(1, { updatedAt: "2026-09-28T11:00:00.000Z" })),
    );
    expect(index?.links).toEqual(new Set([linkKey(nodeId(1), nodeId(0))]));
    // A differ that lost its history can reconcile the same completed view against this index
    // without rebuilding or fitting it.
    const repeated = planViewDiff(
      index,
      graphSnapshot({
        view,
        error: "The last inspection projection failed.",
      }),
    );
    expect(repeated.initial).toBe(false);
    expect(repeated.addedNodes).toEqual([]);
    expect(repeated.updatedNodes).toEqual([]);
    expect(repeated.removedNodeIds).toEqual([]);
    expect(repeated.removedLinkKeys).toEqual([]);
  });

  it("does not invent a link whose endpoint is absent from the display", async () => {
    const graph = model();
    const diff: ViewDiff = {
      status: "ready",
      refreshing: false,
      error: undefined,
      summary: undefined,
      addedNodes: [graphNode(0)],
      removedNodeIds: [],
      updatedNodes: [],
      addedLinks: [graphEdge(0, 9)],
      removedLinkKeys: [],
      initial: true,
    };

    await graph.applyDiff(diff, { yieldFrame: () => Promise.resolve() });

    expect(graph.counts()).toEqual({ nodes: 1, links: 0 });
  });

  it("rejects a served payload that does not match the contract", () => {
    expect(() => parseGraphSnapshot("{")).toThrow(
      "The graph response is not valid JSON.",
    );
    expect(() =>
      parseGraphSnapshot(
        JSON.stringify({ status: "ready", refreshing: false, view: {} }),
      ),
    ).toThrow(
      "The graph response does not match the documented inspection contract.",
    );
    const invalid = graphSnapshot({
      view: graphView({ nodes: [graphNode(0, { x: Number.NaN })] }),
    });
    expect(() => parseGraphSnapshot(snapshotText(invalid))).toThrow(
      "does not match the documented inspection contract",
    );
  });
});

describe("case-insensitive memory identity", () => {
  it("reconciles spelling changes, directed links, selection and fallback indexes", async () => {
    const a = "abcdef01-0000-4000-8000-000000000001";
    const b = "abcdef01-0000-4000-8000-000000000002";
    const graph = model();
    const first = graphSnapshot({
      view: graphView({
        nodes: [graphNode(0, { id: a.toUpperCase() }), graphNode(1, { id: b })],
        edges: [{ source: a, target: b.toUpperCase() }],
      }),
    });
    await apply(graph, first);
    expect(graph.counts()).toEqual({ nodes: 2, links: 1 });
    expect(graph.hasNode(a.toUpperCase())).toBe(true);
    expect(graph.missingIds([a, b.toUpperCase()])).toEqual([]);
    graph.select(a.toUpperCase());
    expect(graph.selectedId).toBe(a);
    expect(graph.isNearSelection(b.toUpperCase())).toBe(true);

    const next = graphSnapshot({
      view: graphView({
        nodes: [
          graphNode(0, { id: a, label: "Updated" }),
          graphNode(1, { id: b.toUpperCase() }),
        ],
        edges: [{ source: a.toUpperCase(), target: b }],
      }),
    });
    // Both the worker's index and the displayed fallback index use the same identities.
    const diff = planViewDiff(indexView(first.view), next);
    expect(planViewDiff(graph.viewIndex(), next)).toEqual(diff);
    expect(diff.addedNodes).toEqual([]);
    expect(diff.removedNodeIds).toEqual([]);
    expect(diff.updatedNodes).toHaveLength(1);
    expect(diff.addedLinks).toEqual([]);
    expect(diff.removedLinkKeys).toEqual([]);
    await graph.applyDiff(diff);
    expect(graph.selectedId).toBe(a);
    expect(graph.graph.getNodeAttributes(a).label).toBe("Updated");
    const removed = graphSnapshot({
      view: graphView({ nodes: [graphNode(1, { id: b })] }),
    });
    await apply(graph, removed, graph.viewIndex());
    expect(graph.counts()).toEqual({ nodes: 1, links: 0 });
    expect(graph.selectedId).toBeUndefined();
  });

  it("highlights mixed-case results and links while preserving returned evidence", async () => {
    const a = "abcdef01-0000-4000-8000-000000000001";
    const b = "abcdef01-0000-4000-8000-000000000002";
    const results = new SearchResults();
    const outcome = searchOutcome([
      {
        note: note(0, { id: a.toUpperCase(), links: [b.toUpperCase()] }),
        via: "match",
        score: 0.7,
      },
      { note: note(1, { id: b }), via: "link" },
    ]);
    results.accept(results.begin({ query: "mixed case" }), outcome);
    const graph = new GraphModel({ results });
    await apply(
      graph,
      graphSnapshot({
        view: graphView({
          nodes: [
            graphNode(0, { id: a }),
            graphNode(1, { id: b.toUpperCase() }),
          ],
          edges: [{ source: a, target: b }],
        }),
      }),
    );
    expect(results.unmappedIds((id) => graph.hasNode(id))).toEqual([]);
    expect(results.state().outcome).toEqual(outcome);
    expect(results.noteFor(a)).toBe(outcome.results[0]?.note);
    expect(results.noteFor(a.toUpperCase())).toBe(outcome.results[0]?.note);
    expect(results.resultIds()).toEqual([a.toUpperCase(), b]);
    expect(nodeStyle(graph, a, graph.graph.getNodeAttributes(a))).toMatchObject(
      { highlighted: true, label: "Direct match — Memory 0" },
    );
    expect(
      nodeStyle(graph, b.toUpperCase(), graph.graph.getNodeAttributes(b)),
    ).toMatchObject({ highlighted: true, label: "Linked addition — Memory 1" });
    expect(
      linkStyle(graph, { source: a.toUpperCase(), target: b }),
    ).toMatchObject({ zIndex: 1, hidden: false });
    graph.select(b.toUpperCase());
    graph.setLinkMode("focused");
    expect(
      linkStyle(graph, { source: a, target: b.toUpperCase() }),
    ).toMatchObject({ zIndex: 2, hidden: false });
  });
});
