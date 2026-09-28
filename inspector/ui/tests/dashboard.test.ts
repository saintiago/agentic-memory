/**
 * The dashboard controller in a real DOM with the real Graphology model, view planner and panels:
 * first view and status, request highlighting and result order, selection evidence, refreshes
 * that keep the camera and selection, retained state on failure, the explicit comparison and the
 * disposal of the poll loop and renderer. Only the HTTP host and the WebGL renderer are
 * substituted.
 *
 * See docs/dashboard.md#acceptance-checks and docs/testing.md#choosing-scope.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { createDashboard, type Dashboard } from "../dashboard.js";
import {
  createInlineViewDiffer,
  planViewDiff,
  type ViewDiffer,
  type ViewIndex,
} from "../view-diff.js";
import {
  FakeRenderer,
  StubClient,
  graphEdge,
  graphNode,
  graphSnapshot,
  graphView,
  nodeId,
  note,
  searchOutcome,
  snapshotText,
  waitFor,
} from "./support.js";

interface Harness {
  readonly dashboard: Dashboard;
  readonly client: StubClient;
  readonly renderer: FakeRenderer;
  readonly root: HTMLElement;
}

const harnesses: Harness[] = [];

const start = (
  options: {
    readonly client?: StubClient;
    readonly batchSize?: number;
    readonly yieldFrame?: () => Promise<void>;
    readonly differ?: ViewDiffer;
  } = {},
): Harness => {
  const client = options.client ?? new StubClient();
  const renderer = new FakeRenderer();
  const root = document.createElement("div");
  document.body.append(root);
  const dashboard = createDashboard({
    root,
    client,
    differ: options.differ ?? createInlineViewDiffer(),
    createRenderer: () => renderer,
    scheduler: {
      // The browser scheduler hands back numbers; Node's timer type is opaque here.
      setTimeout: (handler, delayMs) =>
        globalThis.setTimeout(handler, delayMs) as unknown as number,
      clearTimeout: (handle) => {
        globalThis.clearTimeout(handle);
      },
    },
    pollIntervalMs: 30_000,
    refreshingPollIntervalMs: 5,
    freshnessIntervalMs: 30_000,
    ...(options.batchSize === undefined
      ? {}
      : { batchSize: options.batchSize }),
    ...(options.yieldFrame === undefined
      ? {}
      : { yieldFrame: options.yieldFrame }),
  });
  const harness = { dashboard, client, renderer, root };
  harnesses.push(harness);
  return harness;
};

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.dashboard.dispose();
    harness.root.remove();
  }
});

const element = <T extends Element>(root: HTMLElement, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (found === null) {
    throw new Error(`The dashboard shell has no ${selector}.`);
  }
  return found;
};

const text = (root: HTMLElement, selector: string): string =>
  element(root, selector).textContent ?? "";

const submitSearch = (root: HTMLElement, query: string): void => {
  element<HTMLInputElement>(root, "#query").value = query;
  element<HTMLFormElement>(root, "#query-form").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
};

describe("dashboard", () => {
  it("loads the first completed view, fits once and describes the projection", async () => {
    const { dashboard, client, renderer, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({
              nodes: [graphNode(0), graphNode(1), graphNode(2)],
              edges: [graphEdge(0, 1)],
            }),
          }),
        ),
      );

    await waitFor(() => dashboard.diagnostics().nodes === 3, "the first view");

    expect(renderer.fits).toBe(1);
    expect(renderer.bounds).toHaveLength(1);
    const status = text(root, "#view-status");
    expect(status).toContain("2026-09-28T12:00:00.000Z");
    expect(status).toContain("3 memories");
    expect(status).toContain("1 links");
    expect(status).toContain("approximate embedding projection");
    expect(status).toContain("projection test-projection");
    expect(status).toContain("embedding space test-space");
    expect(
      root.querySelectorAll("#freshness-legend .legend-item"),
    ).toHaveLength(6);
    expect(text(root, "#details")).toContain("Select a memory");
    expect(dashboard.diagnostics().status).toBe("ready");
  });

  it("labels a non-semantic fallback layout", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({
              nodes: [graphNode(0), graphNode(1)],
              layout: "non-semantic",
            }),
          }),
        ),
      );

    await waitFor(() => dashboard.diagnostics().nodes === 2, "the small view");

    expect(text(root, "#view-status")).toContain(
      "non-semantic layout (too few memories to fit UMAP)",
    );
  });

  it("reports progress while a completed view is applied in batches", async () => {
    const gates: Array<() => void> = [];
    const { dashboard, client, root } = start({
      batchSize: 1,
      yieldFrame: () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
    });
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({ nodes: [graphNode(0), graphNode(1)] }),
          }),
        ),
      );

    await waitFor(
      () => text(root, "#view-status").includes("applying the completed view"),
      "the in-progress status",
    );
    expect(text(root, "#view-status")).toContain("2 memories");
    expect(dashboard.diagnostics().nodes).toBeLessThan(2);

    while (gates.length > 0) {
      gates.shift()?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
    await waitFor(
      () => dashboard.diagnostics().nodes === 2,
      "the applied view",
    );
    expect(text(root, "#view-status")).not.toContain(
      "applying the completed view",
    );
  });

  it("displays and highlights exactly the returned IDs, order, kinds and direct scores", async () => {
    const { dashboard, client, renderer, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({
              nodes: [graphNode(0), graphNode(1)],
              edges: [graphEdge(0, 1)],
            }),
          }),
        ),
      );
    client.searchHandler = () =>
      Promise.resolve(
        searchOutcome([
          { note: note(1), via: "match", score: 0.8123 },
          { note: note(0), via: "link" },
        ]),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    submitSearch(root, "memory");
    await waitFor(
      () => dashboard.diagnostics().resultOrder.length === 2,
      "the search response",
    );

    const diagnostics = dashboard.diagnostics();
    expect(diagnostics.resultOrder).toEqual([nodeId(1), nodeId(0)]);
    expect([...diagnostics.highlightedIds].sort()).toEqual(
      [nodeId(0), nodeId(1)].sort(),
    );
    const rows = root.querySelectorAll("#results-list .result");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Direct match · score 0.8123");
    expect(rows[1]?.textContent).toContain("Linked addition");
    expect(rows[1]?.textContent).not.toContain("score");
    expect(text(root, "#results-status")).toContain(
      "2 results at 2026-09-28T12:05:00.000Z",
    );
    expect(renderer.styleChanges).toBeGreaterThan(0);
    expect(element<HTMLButtonElement>(root, "#fit-results").disabled).toBe(
      false,
    );
  });

  it("keeps a zero-result search a successful empty result", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    client.searchHandler = () => Promise.resolve(searchOutcome([]));
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    submitSearch(root, "nothing");
    await waitFor(
      () => text(root, "#results-status").includes("No memories were returned"),
      "the empty result",
    );

    expect(dashboard.diagnostics().highlightedIds).toEqual([]);
    expect(root.querySelectorAll("#results-list .result")).toHaveLength(0);
    expect(element<HTMLButtonElement>(root, "#fit-results").disabled).toBe(
      true,
    );
  });

  it("keeps a failed request an error and never an empty result", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    client.searchHandler = () =>
      Promise.reject(new Error("The search failed."));
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    submitSearch(root, "broken");
    await waitFor(
      () => text(root, "#results-status").includes("The request failed"),
      "the failed request",
    );

    expect(text(root, "#results-status")).toContain("The search failed.");
    expect(dashboard.diagnostics().highlightedIds).toEqual([]);
  });

  it("requests one refresh for returned memories the map does not contain yet", async () => {
    const { dashboard, client, root } = start();
    const first = graphView({ nodes: [graphNode(0), graphNode(1)] });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view: first })));
    client.searchHandler = () =>
      Promise.resolve(
        searchOutcome([
          { note: note(1), via: "match", score: 0.9 },
          { note: note(5), via: "link" },
        ]),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    submitSearch(root, "memory");
    await waitFor(() => client.calls.refresh === 1, "the requested refresh");
    expect(dashboard.diagnostics().unmappedIds).toEqual([nodeId(5)]);
    expect(text(root, "#results-status")).toContain(
      "1 returned memories are not in the current map",
    );
    expect(text(root, "#results-list")).toContain("not in the current map");

    // A later completed view that still lacks the memory must not request another refresh.
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({
              nodes: [graphNode(0), graphNode(1)],
              capturedAt: "2026-09-28T12:10:00.000Z",
            }),
          }),
        ),
      );
    const polls = client.calls.graph;
    dashboard.pollNow();
    await waitFor(() => client.calls.graph > polls, "the next poll");
    expect(client.calls.refresh).toBe(1);
  });

  it("keeps the selection and the camera across a refresh and applies new positions", async () => {
    const { dashboard, client, renderer, root } = start();
    const first = graphView({ nodes: [graphNode(0), graphNode(1)] });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view: first })));
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    dashboard.select(nodeId(1));
    renderer.camera = { x: 0.2, y: 0.3, ratio: 2.5 };

    const second = graphView({
      nodes: [
        graphNode(0, { x: 50, y: 50 }),
        graphNode(1, { x: 20, y: -10 }),
        graphNode(2, { x: -30, y: 40 }),
      ],
      edges: [graphEdge(1, 2)],
      capturedAt: "2026-09-28T12:20:00.000Z",
    });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view: second })));
    const polls = client.calls.graph;
    dashboard.pollNow();
    await waitFor(() => dashboard.diagnostics().nodes === 3, "the refresh");
    expect(client.calls.graph).toBeGreaterThan(polls);

    const diagnostics = dashboard.diagnostics();
    expect(diagnostics.selectedId).toBe(nodeId(1));
    expect(renderer.cameraState()).toEqual({ x: 0.2, y: 0.3, ratio: 2.5 });
    expect(renderer.fits).toBe(1);
    expect(renderer.focused).toEqual([]);
    expect(dashboard.display([nodeId(0), nodeId(1), nodeId(2)])).toEqual([
      { id: nodeId(0), x: 50, y: 50, label: "Memory 0", updatedAt: undefined },
      { id: nodeId(1), x: 20, y: -10, label: "Memory 1", updatedAt: undefined },
      { id: nodeId(2), x: -30, y: 40, label: "Memory 2", updatedAt: undefined },
    ]);
    expect(text(root, "#details")).toContain("Memory 1");
  });

  it("keeps the last completed view when a poll fails", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({
              nodes: [graphNode(0), graphNode(1)],
              edges: [graphEdge(0, 1)],
            }),
          }),
        ),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    client.graphHandler = () =>
      Promise.reject(new Error("connect ECONNREFUSED"));
    dashboard.pollNow();
    await waitFor(
      () => text(root, "#notice").includes("could not be polled"),
      "the poll failure",
    );

    expect(text(root, "#notice")).toContain("ECONNREFUSED");
    expect(dashboard.diagnostics().nodes).toBe(2);
    expect(dashboard.diagnostics().links).toBe(1);
    expect(text(root, "#view-status")).toContain("2 memories");
  });

  it("shows a host refresh failure next to the retained view", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({ nodes: [graphNode(0), graphNode(1)] }),
            error: "The last inspection projection failed.",
          }),
        ),
      );

    await waitFor(
      () =>
        text(root, "#view-status").includes("last inspection refresh failed"),
      "the retained view with its error",
    );

    expect(text(root, "#view-status")).toContain(
      "The last inspection projection failed.",
    );
    expect(text(root, "#view-status")).toContain("still displayed");
    expect(dashboard.diagnostics().nodes).toBe(2);
    expect(dashboard.diagnostics().error).toBe(
      "The last inspection projection failed.",
    );
  });

  it("selects a returned memory and uses the returned payload as its evidence", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(1)] }) }),
        ),
      );
    client.searchHandler = () =>
      Promise.resolve(
        searchOutcome([
          {
            note: note(1, { content: "Returned evidence text" }),
            via: "match",
            score: 0.7,
          },
        ]),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    submitSearch(root, "evidence");
    await waitFor(
      () => dashboard.diagnostics().resultOrder.length === 1,
      "the result",
    );
    element<HTMLButtonElement>(root, "#results-list .result button").click();
    await waitFor(
      () => text(root, "#details").includes("Returned evidence text"),
      "the details",
    );

    expect(client.calls.note).toEqual([]);
    expect(text(root, "#details")).toContain(
      "returned by the memory request at 2026-09-28T12:05:00.000Z",
    );
    expect(text(root, "#details")).toContain(
      "unknown — this memory has no persisted update time",
    );
  });

  it("reads the current note when the request did not return the memory", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(2)] }) }),
        ),
      );
    client.noteHandler = (nodeIdValue) =>
      Promise.resolve(
        nodeIdValue === nodeId(2)
          ? note(2, {
              content: "Host read text",
              links: [nodeId(9)],
              updatedAt: "2026-09-28T09:00:00.000Z",
            })
          : undefined,
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    dashboard.select(nodeId(2));
    await waitFor(
      () => text(root, "#details").includes("Host read text"),
      "the details read",
    );

    expect(client.calls.note).toEqual([nodeId(2)]);
    const details = text(root, "#details");
    expect(details).toContain("2026-09-28T09:00:00.000Z");
    expect(details).toContain("View captured at");
    expect(details).toContain(
      `outgoing → ${nodeId(9)} (target not in the current view)`,
    );
    expect(details).toContain("read from the host");
  });

  it("ignores a detail read that a later selection superseded", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({ nodes: [graphNode(0), graphNode(1)] }),
          }),
        ),
      );
    let releaseFirst: (() => void) | undefined;
    client.noteHandler = (nodeIdValue) => {
      if (nodeIdValue === nodeId(0)) {
        return new Promise((resolve) => {
          releaseFirst = () => {
            resolve(note(0, { content: "Stale first note" }));
          };
        });
      }
      return Promise.resolve(note(1, { content: "Current second note" }));
    };
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    dashboard.select(nodeId(0));
    dashboard.select(nodeId(1));
    await waitFor(
      () => text(root, "#details").includes("Current second note"),
      "the second note",
    );
    releaseFirst?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    expect(text(root, "#details")).toContain("Current second note");
    expect(text(root, "#details")).not.toContain("Stale first note");
  });

  it("keeps only the newest request when two searches overlap", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({ nodes: [graphNode(0), graphNode(1)] }),
          }),
        ),
      );
    let releaseFirst: (() => void) | undefined;
    client.searchHandler = (request) => {
      if (request.query === "first") {
        return new Promise((resolve) => {
          releaseFirst = () => {
            resolve(
              searchOutcome([{ note: note(0), via: "match", score: 0.9 }]),
            );
          };
        });
      }
      return Promise.resolve(
        searchOutcome([{ note: note(1), via: "match", score: 0.4 }]),
      );
    };
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    submitSearch(root, "first");
    submitSearch(root, "second");
    await waitFor(
      () => dashboard.diagnostics().resultOrder.length === 1,
      "the newest result",
    );
    releaseFirst?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    expect(dashboard.diagnostics().resultOrder).toEqual([nodeId(1)]);
  });

  it("clears a request and restores the normal map", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    client.searchHandler = () =>
      Promise.resolve(
        searchOutcome([{ note: note(0), via: "match", score: 0.5 }]),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    submitSearch(root, "memory");
    await waitFor(
      () => dashboard.diagnostics().highlightedIds.length === 1,
      "the result",
    );
    element<HTMLButtonElement>(root, "#clear-results").click();

    expect(dashboard.diagnostics().highlightedIds).toEqual([]);
    expect(dashboard.diagnostics().resultOrder).toEqual([]);
    expect(text(root, "#results-status")).toContain("No memory request yet.");
  });

  it("switches the link mode and requests a full refit only explicitly", async () => {
    const { dashboard, client, renderer, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    expect(client.calls.rebuild).toBe(0);
    const styles = renderer.styleChanges;
    const focused = element<HTMLInputElement>(
      root,
      'input[name="link-mode"][value="focused"]',
    );
    focused.checked = true;
    focused.dispatchEvent(new Event("change", { bubbles: true }));
    expect(dashboard.diagnostics().linkMode).toBe("focused");
    expect(renderer.styleChanges).toBeGreaterThan(styles);

    element<HTMLButtonElement>(root, "#rebuild").click();
    await waitFor(() => client.calls.rebuild === 1, "the explicit refit");
    expect(text(root, "#notice")).toContain(
      "full projection refit was requested",
    );
  });

  it("compares the two most recently selected memories and labels the measure", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({ nodes: [graphNode(0), graphNode(1)] }),
          }),
        ),
      );
    client.noteHandler = (nodeIdValue) =>
      Promise.resolve(note(Number(nodeIdValue.slice(-1))));
    client.comparisonHandler = () =>
      Promise.resolve({
        similarity: 0.8123456,
        capturedAt: "2026-09-28T12:00:00.000Z",
      });
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    dashboard.select(nodeId(0));
    dashboard.select(nodeId(1));
    await waitFor(
      () => !element<HTMLButtonElement>(root, "#compare").disabled,
      "the comparison pair",
    );
    element<HTMLButtonElement>(root, "#compare").click();
    await waitFor(
      () => text(root, "#comparison").includes("0.8123"),
      "the comparison result",
    );

    expect(client.calls.compare).toEqual([
      { leftId: nodeId(0), rightId: nodeId(1) },
    ]);
    expect(text(root, "#comparison")).toContain(
      "Cosine similarity of stored vectors",
    );
    expect(text(root, "#comparison")).toContain("2026-09-28T12:00:00.000Z");
    expect(text(root, "#comparison")).toContain("not the screen distance");
  });

  it("keeps a failed comparison an error", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({ nodes: [graphNode(0), graphNode(1)] }),
          }),
        ),
      );
    client.comparisonHandler = () =>
      Promise.reject(
        new Error(
          "Both notes must be present in the latest completed graph view.",
        ),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    dashboard.select(nodeId(0));
    dashboard.select(nodeId(1));
    await waitFor(
      () => !element<HTMLButtonElement>(root, "#compare").disabled,
      "the comparison pair",
    );
    element<HTMLButtonElement>(root, "#compare").click();
    await waitFor(
      () => text(root, "#comparison").includes("must be present"),
      "the comparison failure",
    );

    expect(text(root, "#comparison")).toContain("must be present");
  });

  it("renders displayed source text inertly", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    client.noteHandler = () =>
      Promise.resolve(
        note(0, {
          content: '<img src="x" onerror="window.hacked = true">',
          metadata: { note: "<script>alert(1)</script>" },
        }),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    dashboard.select(nodeId(0));
    await waitFor(
      () => text(root, "#details").includes("Provenance and metadata"),
      "the details",
    );

    expect(root.querySelector("#details img")).toBeNull();
    expect(root.querySelector("#details script")).toBeNull();
    expect(text(root, "#details")).toContain(
      '<img src="x" onerror="window.hacked = true">',
    );
    expect(text(root, "#details")).toContain("<script>alert(1)</script>");
  });

  it("stops polling and releases the renderer and planner on disposal", async () => {
    const { dashboard, client, renderer }: Harness = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    dashboard.dispose();
    const polls = client.calls.graph;
    dashboard.pollNow();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(renderer.disposed).toBe(true);
    expect(client.calls.graph).toBe(polls);
  });

  it("ignores a selection of a memory the display does not contain", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    dashboard.select(nodeId(7));

    expect(dashboard.diagnostics().selectedId).toBeUndefined();
    expect(client.calls.note).toEqual([]);
    expect(text(root, "#details")).toContain("Select a memory");
  });

  it("clears a polling failure notice once a poll succeeds again", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.reject(new Error("connect ECONNREFUSED"));
    await waitFor(
      () => text(root, "#notice").includes("could not be polled"),
      "the poll failure",
    );
    expect(dashboard.diagnostics().status).toBe("error");

    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({
              nodes: [graphNode(0), graphNode(1), graphNode(2), graphNode(3)],
            }),
          }),
        ),
      );
    dashboard.pollNow();
    await waitFor(
      () => dashboard.diagnostics().nodes === 4,
      "the recovered view",
    );

    expect(text(root, "#notice")).toBe("");
    expect(dashboard.diagnostics().status).toBe("ready");

    // A notice another action wrote is not the poll loop's to clear.
    element<HTMLButtonElement>(root, "#rebuild").click();
    await waitFor(
      () =>
        text(root, "#notice").includes("full projection refit was requested"),
      "the refit notice",
    );
    const polls = client.calls.graph;
    dashboard.pollNow();
    await waitFor(() => client.calls.graph > polls, "the next poll");
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(text(root, "#notice")).toContain(
      "full projection refit was requested",
    );
  });

  it("hands the displayed view to the planner after applying it", async () => {
    const adopted: Array<ViewIndex | undefined> = [];
    const inline = createInlineViewDiffer();
    const differ: ViewDiffer = {
      plan: (payload) => inline.plan(payload),
      adopt: (index) => {
        adopted.push(index);
        inline.adopt(index);
      },
      usesWorker: () => false,
      dispose: () => {
        inline.dispose();
      },
    };
    const { dashboard, client } = start({ differ });
    const view = graphView({
      nodes: [graphNode(0), graphNode(1)],
      edges: [graphEdge(0, 1)],
    });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view })));

    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    const baseline = adopted.at(-1);
    expect(baseline?.nodes.size).toBe(2);
    expect(baseline?.links.size).toBe(1);
    // Planning the same completed view against the handed-over baseline is a no-op, so a fallback
    // that lost its own history reconciles the display instead of rebuilding it as an initial view.
    const repeated = planViewDiff(
      baseline,
      graphSnapshot({
        view: graphView({
          nodes: [graphNode(0), graphNode(1)],
          edges: [graphEdge(0, 1)],
          capturedAt: "2026-09-28T12:20:00.000Z",
        }),
      }),
    );
    expect(repeated.initial).toBe(false);
    expect(repeated.addedNodes).toEqual([]);
    expect(repeated.updatedNodes).toEqual([]);
    expect(repeated.removedNodeIds).toEqual([]);
  });

  it("re-reads the selected memory after a completed view changes it", async () => {
    const { dashboard, client, root } = start();
    const first = graphView({ nodes: [graphNode(2)] });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view: first })));
    let updatedAt = "2026-09-28T09:00:00.000Z";
    client.noteHandler = () =>
      Promise.resolve(
        note(2, {
          content: "Host read text",
          context: "Current host context",
          updatedAt,
        }),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    dashboard.select(nodeId(2));
    await waitFor(
      () => text(root, "#details").includes("2026-09-28T09:00:00.000Z"),
      "the first read",
    );

    updatedAt = "2026-09-28T11:30:00.000Z";
    const second = graphView({
      nodes: [graphNode(2, { updatedAt })],
      capturedAt: "2026-09-28T12:30:00.000Z",
    });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view: second })));
    dashboard.pollNow();
    await waitFor(
      () => text(root, "#details").includes("2026-09-28T11:30:00.000Z"),
      "the re-read evidence",
    );

    expect(client.calls.note).toEqual([nodeId(2), nodeId(2)]);
    expect(dashboard.diagnostics().selectedId).toBe(nodeId(2));
    expect(text(root, "#details")).toContain("View captured at");
    expect(text(root, "#details")).toContain("2026-09-28T12:30:00.000Z");
  });

  it("re-reads the selected memory when the same memory is selected again", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(2)] }) }),
        ),
      );
    client.noteHandler = () =>
      Promise.resolve(note(2, { content: "Host read text" }));
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    dashboard.select(nodeId(2));
    await waitFor(
      () => text(root, "#details").includes("Host read text"),
      "the first read",
    );
    dashboard.select(nodeId(2));
    await waitFor(() => client.calls.note.length === 2, "the repeated read");
  });

  it("discards a detail read for a selection a completed view removed", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({ nodes: [graphNode(0), graphNode(1)] }),
          }),
        ),
      );
    let release: (() => void) | undefined;
    client.noteHandler = () =>
      new Promise((resolve) => {
        release = () => {
          resolve(note(0, { content: "Late evidence" }));
        };
      });
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    dashboard.select(nodeId(0));
    await waitFor(
      () => text(root, "#details").includes("Reading the current note"),
      "the pending read",
    );

    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({
              nodes: [graphNode(1)],
              capturedAt: "2026-09-28T12:40:00.000Z",
            }),
          }),
        ),
      );
    dashboard.pollNow();
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the removal");

    release?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(dashboard.diagnostics().selectedId).toBeUndefined();
    expect(text(root, "#details")).toContain("Select a memory");
    expect(text(root, "#details")).not.toContain("Late evidence");
  });

  it("opens the returned evidence of a result the map does not contain", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    client.searchHandler = () =>
      Promise.resolve(
        searchOutcome([
          {
            note: note(5, {
              content: "Unmapped evidence",
              context: "Returned context",
              tags: ["provenance"],
              links: [nodeId(9)],
            }),
            via: "link",
          },
        ]),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    submitSearch(root, "evidence");
    await waitFor(
      () => dashboard.diagnostics().resultOrder.length === 1,
      "the result",
    );
    element<HTMLButtonElement>(root, "#results-list .result button").click();
    await waitFor(
      () => text(root, "#details").includes("Unmapped evidence"),
      "the returned evidence",
    );

    const details = text(root, "#details");
    expect(dashboard.diagnostics().selectedId).toBe(nodeId(5));
    expect(client.calls.note).toEqual([]);
    expect(details).toContain("Returned context");
    expect(details).toContain("provenance");
    expect(details).toContain(
      `outgoing → ${nodeId(9)} (target not in the current view)`,
    );
    expect(details).toContain(
      "returned by the memory request at 2026-09-28T12:05:00.000Z",
    );
    // The memory has no position, so the actions that need one stay unavailable.
    expect(element<HTMLButtonElement>(root, "#focus-selected").disabled).toBe(
      true,
    );
    // Only one memory is selected, so there is no pair to compare yet.
    expect(element<HTMLButtonElement>(root, "#compare").disabled).toBe(true);
    expect(dashboard.diagnostics().nodes).toBe(1);
  });

  it("keeps the comparison of two unmapped results unavailable", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    client.searchHandler = () =>
      Promise.resolve(
        searchOutcome([
          { note: note(5, { content: "First unmapped" }), via: "link" },
          { note: note(6, { content: "Second unmapped" }), via: "link" },
        ]),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    submitSearch(root, "unmapped");
    await waitFor(
      () => dashboard.diagnostics().resultOrder.length === 2,
      "the results",
    );
    const buttons = root.querySelectorAll<HTMLButtonElement>(
      "#results-list .result button",
    );
    buttons[0]?.click();
    buttons[1]?.click();
    await waitFor(
      () => text(root, "#details").includes("Second unmapped"),
      "the second result",
    );

    expect(element<HTMLButtonElement>(root, "#compare").disabled).toBe(true);
    expect(text(root, "#comparison")).toContain(
      "both memories must be in the current map",
    );
    expect(client.calls.compare).toEqual([]);
  });

  it("ignores a comparison answer the latest selection made obsolete", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({
              nodes: [graphNode(0), graphNode(1), graphNode(2)],
            }),
          }),
        ),
      );
    let release: ((similarity: number) => void) | undefined;
    client.comparisonHandler = () =>
      new Promise((resolve) => {
        release = (similarity) => {
          resolve({
            similarity,
            capturedAt: "2026-09-28T12:00:00.000Z",
          });
        };
      });
    await waitFor(() => dashboard.diagnostics().nodes === 3, "the first view");

    dashboard.select(nodeId(0));
    dashboard.select(nodeId(1));
    await waitFor(
      () => !element<HTMLButtonElement>(root, "#compare").disabled,
      "the comparison pair",
    );
    element<HTMLButtonElement>(root, "#compare").click();
    await waitFor(() => client.calls.compare.length === 1, "the comparison");

    // A third selection replaces the pair while the answer is still in flight.
    dashboard.select(nodeId(2));
    release?.(0.987654);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(text(root, "#comparison")).not.toContain("0.9877");
    expect(text(root, "#comparison")).toContain(`(${nodeId(2)})`);
  });

  it("ignores a failed comparison answer the latest selection made obsolete", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({
              nodes: [graphNode(0), graphNode(1), graphNode(2)],
            }),
          }),
        ),
      );
    let fail: ((cause: Error) => void) | undefined;
    client.comparisonHandler = () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      });
    await waitFor(() => dashboard.diagnostics().nodes === 3, "the first view");

    dashboard.select(nodeId(0));
    dashboard.select(nodeId(1));
    await waitFor(
      () => !element<HTMLButtonElement>(root, "#compare").disabled,
      "the comparison pair",
    );
    element<HTMLButtonElement>(root, "#compare").click();
    await waitFor(() => client.calls.compare.length === 1, "the comparison");

    dashboard.select(nodeId(2));
    fail?.(new Error("The obsolete comparison failed."));
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(text(root, "#comparison")).not.toContain("obsolete comparison");
    expect(text(root, "#comparison")).toContain(`(${nodeId(2)})`);
  });

  it("applies a projection refit atomically and publishes it afterwards", async () => {
    const yields: number[] = [];
    const { dashboard, client, renderer, root } = start({
      batchSize: 2,
      yieldFrame: () => {
        yields.push(1);
        return Promise.resolve();
      },
    });
    const first = graphView({
      nodes: [0, 1, 2, 3].map((index) => graphNode(index)),
    });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view: first })));
    await waitFor(() => dashboard.diagnostics().nodes === 4, "the first view");

    const refit = graphView({
      nodes: [0, 1, 2, 3].map((index) =>
        graphNode(index, { x: 100 + index, y: -100 - index }),
      ),
      projectionId: "test-projection:rebuild",
      capturedAt: "2026-09-28T12:42:00.000Z",
    });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view: refit })));
    yields.length = 0;
    dashboard.pollNow();
    await waitFor(
      () =>
        dashboard.diagnostics().view?.projectionId ===
        "test-projection:rebuild",
      "the refit",
    );

    // No frame yield can observe a mixture of the two coordinate systems.
    expect(yields).toEqual([]);
    expect(renderer.fits).toBe(1);
    expect(text(root, "#notice")).toContain("projection was refitted");
    expect(
      dashboard.display([nodeId(0)]).map((node) => [node.x, node.y]),
    ).toEqual([[100, -100]]);
  });

  it("publishes a view applied in batches only once the display holds it", async () => {
    const gates: Array<() => void> = [];
    const { dashboard, client, root } = start({
      batchSize: 1,
      yieldFrame: () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
    });
    const first = graphView({ nodes: [graphNode(0)] });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view: first })));
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    const second = graphView({
      nodes: [graphNode(0), graphNode(1), graphNode(2)],
      capturedAt: "2026-09-28T12:50:00.000Z",
    });
    client.graphHandler = () =>
      Promise.resolve(snapshotText(graphSnapshot({ view: second })));
    dashboard.pollNow();
    await waitFor(() => gates.length > 0, "the pending batch");

    expect(dashboard.diagnostics().view?.capturedAt).toBe(
      "2026-09-28T12:00:00.000Z",
    );
    expect(text(root, "#view-status")).toContain("2026-09-28T12:00:00.000Z");
    expect(text(root, "#view-status")).toContain(
      "3 memories and 0 links in the completed view being applied",
    );

    while (gates.length > 0) {
      gates.shift()?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
    await waitFor(
      () => dashboard.diagnostics().nodes === 3,
      "the applied view",
    );

    expect(dashboard.diagnostics().view?.capturedAt).toBe(
      "2026-09-28T12:50:00.000Z",
    );
  });

  it("clears a selection that only existed through the cleared request", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({ view: graphView({ nodes: [graphNode(0)] }) }),
        ),
      );
    client.searchHandler = () =>
      Promise.resolve(
        searchOutcome([
          { note: note(5, { content: "Unmapped evidence" }), via: "link" },
        ]),
      );
    await waitFor(() => dashboard.diagnostics().nodes === 1, "the first view");

    submitSearch(root, "unmapped");
    await waitFor(
      () => dashboard.diagnostics().resultOrder.length === 1,
      "the result",
    );
    element<HTMLButtonElement>(root, "#results-list .result button").click();
    await waitFor(
      () => text(root, "#details").includes("Unmapped evidence"),
      "the returned evidence",
    );

    element<HTMLButtonElement>(root, "#clear-results").click();

    expect(dashboard.diagnostics().selectedId).toBeUndefined();
    expect(text(root, "#details")).toContain("Select a memory");
  });

  it("ignores a comparison answer that clearing the request superseded", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({ nodes: [graphNode(0), graphNode(1)] }),
          }),
        ),
      );
    let release: ((similarity: number) => void) | undefined;
    client.comparisonHandler = () =>
      new Promise((resolve) => {
        release = (similarity) => {
          resolve({
            similarity,
            capturedAt: "2026-09-28T12:00:00.000Z",
          });
        };
      });
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    dashboard.select(nodeId(0));
    dashboard.select(nodeId(1));
    await waitFor(
      () => !element<HTMLButtonElement>(root, "#compare").disabled,
      "the comparison pair",
    );
    element<HTMLButtonElement>(root, "#compare").click();
    await waitFor(() => client.calls.compare.length === 1, "the comparison");

    element<HTMLButtonElement>(root, "#clear-results").click();
    release?.(0.987654);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(text(root, "#comparison")).not.toContain("0.9877");
  });

  it("ignores a failed comparison answer that clearing the request superseded", async () => {
    const { dashboard, client, root } = start();
    client.graphHandler = () =>
      Promise.resolve(
        snapshotText(
          graphSnapshot({
            view: graphView({ nodes: [graphNode(0), graphNode(1)] }),
          }),
        ),
      );
    let fail: ((cause: Error) => void) | undefined;
    client.comparisonHandler = () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      });
    await waitFor(() => dashboard.diagnostics().nodes === 2, "the first view");

    dashboard.select(nodeId(0));
    dashboard.select(nodeId(1));
    await waitFor(
      () => !element<HTMLButtonElement>(root, "#compare").disabled,
      "the comparison pair",
    );
    element<HTMLButtonElement>(root, "#compare").click();
    await waitFor(() => client.calls.compare.length === 1, "the comparison");

    element<HTMLButtonElement>(root, "#clear-results").click();
    fail?.(new Error("The obsolete comparison failed."));
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(text(root, "#comparison")).not.toContain("obsolete comparison");
  });
});
