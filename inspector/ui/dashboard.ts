/**
 * The inspection dashboard controller: it composes the HTTP client, the view planner, the
 * Graphology display model and the renderer, and keeps the status, results, details and
 * comparison panels in sync. Data loading, refresh, search and projection run asynchronously
 * while the existing graph stays interactive and the camera and selection survive updates.
 *
 * See docs/dashboard.md#asynchronous-data-updates and docs/dashboard.md#memory-requests.
 */
import type { DirectedGraph } from "graphology";

import type { InspectorClient } from "./client.js";
import { renderComparison, renderDetails } from "./details.js";
import type { ComparisonState, DetailsState } from "./details.js";
import { clear, element } from "./dom.js";
import { formatCount, formatDuration, formatScore } from "./format.js";
import { freshnessLegend } from "./freshness.js";
import { GraphModel, type ApplyReport } from "./graph-model.js";
import {
  browserScheduler,
  createPollLoop,
  type PollLoop,
  type PollScheduler,
} from "./poll.js";
import type { DashboardRenderer } from "./renderer.js";
import { SearchResults, type SearchRequest } from "./results.js";
import { installShell, type Shell } from "./shell.js";
import type { LinkAttributes, NodeAttributes, StyleSource } from "./style.js";
import type { ViewDiff, ViewDiffer, ViewSummary } from "./view-diff.js";

/** One applied update, kept for the status line and the responsiveness check. */
export interface ApplyMeasurement {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly batches: number;
  readonly addedNodes: number;
  readonly removedNodes: number;
  readonly updatedNodes: number;
  readonly addedLinks: number;
  readonly removedLinks: number;
}

/** The read-only state the responsiveness check and the tests inspect. */
export interface DashboardDiagnostics {
  readonly status: "loading" | "ready" | "error";
  readonly refreshing: boolean;
  readonly error: string | undefined;
  readonly differUsesWorker: boolean;
  readonly view: ViewSummary | undefined;
  readonly nodes: number;
  readonly links: number;
  readonly selectedId: string | undefined;
  readonly linkMode: "all" | "focused";
  readonly highlightedIds: readonly string[];
  readonly resultOrder: readonly string[];
  readonly unmappedIds: readonly string[];
  readonly lastApply: ApplyMeasurement | undefined;
  /** The handler latency of the latest request: submission to painted results. */
  readonly lastSearchMs: number | undefined;
  /** The handler latency of the latest selection: click to painted details panel. */
  readonly lastSelectionMs: number | undefined;
}

export interface DashboardOptions {
  readonly root: HTMLElement;
  readonly client: InspectorClient;
  readonly differ: ViewDiffer;
  readonly createRenderer: (options: {
    readonly container: HTMLElement;
    readonly graph: DirectedGraph<NodeAttributes, LinkAttributes>;
    readonly style: StyleSource;
    readonly onSelect: (nodeId: string | undefined) => void;
  }) => DashboardRenderer;
  readonly now?: () => number;
  readonly yieldFrame?: () => Promise<void>;
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly refreshingPollIntervalMs?: number;
  readonly freshnessIntervalMs?: number;
  readonly scheduler?: PollScheduler;
}

export interface Dashboard {
  dispose(): void;
  /** Poll the graph immediately, coalescing with a poll that is already running. */
  pollNow(): void;
  /** Request one inspection refresh and poll for its result. */
  requestRefresh(): Promise<void>;
  /** Request a full projection refit and poll for its result. */
  requestRebuild(): Promise<void>;
  select(nodeId: string | undefined): void;
  diagnostics(): DashboardDiagnostics;
  /** The displayed evidence of the supplied memories, for the responsiveness check. */
  display(nodeIds: readonly string[]): ReadonlyArray<{
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly label: string;
    readonly updatedAt: string | undefined;
  }>;
  cameraState(): {
    readonly x: number;
    readonly y: number;
    readonly ratio: number;
  };
  viewportPosition(
    nodeId: string,
  ): { readonly x: number; readonly y: number } | undefined;
}

type Status = "loading" | "ready" | "error";

const sanitizedMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const createDashboard = (options: DashboardOptions): Dashboard => {
  const now = options.now ?? ((): number => Date.now());
  const yieldFrame = options.yieldFrame;
  const batchSize = options.batchSize;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const refreshingPollIntervalMs = options.refreshingPollIntervalMs ?? 500;
  const freshnessIntervalMs = options.freshnessIntervalMs ?? 60_000;
  const scheduler = options.scheduler ?? browserScheduler;

  const shell: Shell = installShell(options.root);
  const results = new SearchResults();
  const model = new GraphModel({ results, now });
  /**
   * The renderer starts with the first completed view, after the graph is already populated: a
   * large import then costs one render instead of one render per mutation batch.
   */
  let renderer: DashboardRenderer | undefined;
  const startRenderer = (): DashboardRenderer => {
    if (renderer === undefined) {
      try {
        renderer = options.createRenderer({
          container: shell.graphStage,
          graph: model.graph,
          style: model,
          onSelect: (nodeId) => {
            select(nodeId);
          },
        });
      } catch (cause) {
        setNotice(
          `The graph renderer could not start: ${sanitizedMessage(cause)}`,
        );
        throw cause;
      }
    }
    return renderer;
  };

  let disposed = false;
  let status: Status = "loading";
  let refreshing = false;
  /** True while a planned view is being applied to the display in bounded batches. */
  let applying = false;
  let viewError: string | undefined;
  let view: ViewSummary | undefined;
  let lastApply: ApplyMeasurement | undefined;
  let lastSearchMs: number | undefined;
  let lastSelectionMs: number | undefined;
  let comparisonHistory: string[] = [];
  let comparison: ComparisonState = {
    leftId: undefined,
    rightId: undefined,
    pending: false,
    result: undefined,
    error: undefined,
  };
  let comparisonToken = 0;
  let detailsState: DetailsState = { kind: "empty" };
  let detailsToken = 0;
  let missingRequestRevision: number | undefined;

  const renderLegend = (): void => {
    clear(shell.legend);
    for (const entry of freshnessLegend) {
      const item = element("span", { className: "legend-item" });
      item.append(
        element("span", {
          className: "legend-swatch",
          title: entry.color,
        }),
      );
      const swatch = item.lastElementChild as HTMLElement | null;
      if (swatch !== null) {
        swatch.style.background = entry.color;
      }
      item.append(element("span", { text: entry.label }));
      shell.legend.append(item);
    }
  };

  const setNotice = (message: string | undefined): void => {
    shell.notice.textContent = message ?? "";
    shell.notice.hidden = message === undefined;
  };

  const renderStatus = (): void => {
    clear(shell.viewStatus);
    const parts: string[] = [];
    if (view === undefined) {
      parts.push(
        status === "error"
          ? "No completed view is available"
          : "Waiting for the first export and projection",
      );
    } else {
      parts.push(`View captured at ${view.capturedAt}`);
      parts.push(`${formatCount(view.nodeCount)} memories`);
      parts.push(`${formatCount(view.linkCount)} links`);
      parts.push(
        view.layout === "umap"
          ? "approximate embedding projection"
          : "non-semantic layout (too few memories to fit UMAP)",
      );
      parts.push(`projection ${view.projectionId}`);
      parts.push(`embedding space ${view.embeddingSpaceId}`);
    }
    if (refreshing || applying) {
      parts.push(refreshing ? "refreshing…" : "applying the completed view…");
    }
    if (lastApply !== undefined) {
      parts.push(
        `last update applied in ${formatDuration(lastApply.durationMs)}`,
      );
    }
    shell.viewStatus.append(
      element("p", { className: "status", text: parts.join(" · ") }),
    );
    if (viewError !== undefined) {
      shell.viewStatus.append(
        element("p", {
          className: "error",
          text: `The last inspection refresh failed: ${viewError}. The last completed view is still displayed.`,
        }),
      );
    }
  };

  const labelFor = (nodeId: string): string => {
    if (model.hasNode(nodeId)) {
      return model.graph.getNodeAttributes(nodeId).label;
    }
    return results.noteFor(nodeId)?.content ?? nodeId;
  };

  const renderResults = (): void => {
    clear(shell.resultsList);
    const state = results.state();
    clear(shell.resultsStatus);
    if (state.request === undefined) {
      shell.resultsStatus.append(
        element("p", { className: "muted", text: "No memory request yet." }),
      );
    } else if (state.pending) {
      shell.resultsStatus.append(
        element("p", {
          className: "muted",
          text: `Searching for “${state.request.query}”…`,
        }),
      );
    } else if (state.error !== undefined) {
      shell.resultsStatus.append(
        element("p", {
          className: "error",
          text: `The request failed: ${state.error}`,
        }),
      );
    } else if (state.outcome !== undefined) {
      const unmapped = model.missingIds(results.resultIds());
      const lines = [
        state.outcome.results.length === 0
          ? `No memories were returned at ${state.outcome.searchedAt}.`
          : `${formatCount(state.outcome.results.length)} results at ${state.outcome.searchedAt}.`,
      ];
      if (
        view !== undefined &&
        Date.parse(state.outcome.searchedAt) < Date.parse(view.capturedAt)
      ) {
        lines.push(
          `The map has refreshed since this request (view captured at ${view.capturedAt}).`,
        );
      }
      if (unmapped.length > 0) {
        lines.push(
          `${formatCount(unmapped.length)} returned memories are not in the current map; a paginated refresh was requested.`,
        );
      }
      shell.resultsStatus.append(
        element("p", { className: "status", text: lines.join(" ") }),
      );
    }

    for (const [index, result] of (state.outcome?.results ?? []).entries()) {
      const selected = model.selectedId === result.note.id;
      const item = element("li", {
        className: selected ? "result selected" : "result",
      });
      const button = element("button", { type: "button" });
      button.append(
        element("span", {
          className: "result-kind",
          text:
            result.via === "match"
              ? `Direct match · score ${formatScore(result.score)}`
              : "Linked addition",
        }),
      );
      button.append(
        element("span", {
          className: "result-label",
          text: `${String(index + 1)}. ${result.note.content}`,
        }),
      );
      button.append(
        element("span", { className: "result-id", text: result.note.id }),
      );
      if (!model.hasNode(result.note.id)) {
        button.append(
          element("span", {
            className: "result-missing",
            text: "not in the current map",
          }),
        );
      }
      button.addEventListener("click", () => {
        select(result.note.id);
      });
      item.append(button);
      shell.resultsList.append(item);
    }
  };

  const paintDetails = (state: DetailsState): void => {
    renderDetails(shell.details, state, {
      now: now(),
      view,
      hasNode: (nodeId) => model.hasNode(nodeId),
      onSelect: (nodeId) => {
        select(nodeId);
      },
    });
  };

  const paintComparison = (state: ComparisonState): void => {
    renderComparison(shell.comparison, state, {
      label: (nodeId) => labelFor(nodeId),
      onCompare: () => {
        void compare();
      },
    });
  };

  const renderControls = (): void => {
    shell.fitResults.disabled = results.highlightIds.size === 0;
    shell.focusSelected.disabled = model.selectedId === undefined;
    const mode = model.linkMode;
    for (const input of shell.linkModes) {
      input.checked = input.value === mode;
    }
    const caption: string[] = [];
    caption.push(
      mode === "focused" && model.selectedId !== undefined
        ? "Focused links: only links that touch the selected memory are shown."
        : "Every stored link between displayed memories is shown.",
    );
    if (results.highlightIds.size > 0) {
      caption.push(
        `${formatCount(results.highlightIds.size)} returned memories are highlighted; unrelated memories and links are dimmed.`,
      );
    }
    shell.graphCaptionFooter.textContent = caption.join(" ");
  };

  const renderAll = (): void => {
    renderStatus();
    renderResults();
    paintDetails(detailsState);
    paintComparison(comparison);
    renderControls();
  };

  const select = (nodeId: string | undefined): void => {
    if (disposed) {
      return;
    }
    const selectedAt = now();
    if (nodeId !== undefined && !model.hasNode(nodeId)) {
      return;
    }
    if (!model.select(nodeId)) {
      return;
    }
    if (nodeId !== undefined) {
      comparisonHistory = [
        nodeId,
        ...comparisonHistory.filter((id) => id !== nodeId),
      ].slice(0, 2);
      comparison = {
        leftId: comparisonHistory[1],
        rightId: comparisonHistory[0],
        pending: false,
        result: undefined,
        error: undefined,
      };
    }
    renderer?.styleChanged();
    void loadDetails();
    renderResults();
    paintComparison(comparison);
    renderControls();
    lastSelectionMs = now() - selectedAt;
  };

  const loadDetails = async (): Promise<void> => {
    detailsToken += 1;
    const token = detailsToken;
    const nodeId = model.selectedId;
    if (nodeId === undefined) {
      detailsState = { kind: "empty" };
      paintDetails(detailsState);
      return;
    }
    const label = labelFor(nodeId);
    const returned = results.state().outcome;
    const returnedNote = results.noteFor(nodeId);
    if (returnedNote !== undefined) {
      detailsState = {
        kind: "note",
        nodeId,
        label,
        note: returnedNote,
        returnedAt: returned?.searchedAt,
      };
      paintDetails(detailsState);
      return;
    }
    detailsState = { kind: "loading", nodeId, label };
    paintDetails(detailsState);
    try {
      const note = await options.client.note(nodeId);
      if (disposed || token !== detailsToken) {
        return;
      }
      detailsState =
        note === undefined
          ? {
              kind: "unavailable",
              nodeId,
              label,
              message:
                "The host no longer contains this note; the displayed view may be older than the collection.",
            }
          : { kind: "note", nodeId, label, note, returnedAt: undefined };
    } catch (cause) {
      if (disposed || token !== detailsToken) {
        return;
      }
      detailsState = {
        kind: "unavailable",
        nodeId,
        label,
        message: sanitizedMessage(cause),
      };
    }
    paintDetails(detailsState);
  };

  const compare = async (): Promise<void> => {
    const leftId = comparison.leftId;
    const rightId = comparison.rightId;
    if (leftId === undefined || rightId === undefined || leftId === rightId) {
      return;
    }
    comparisonToken += 1;
    const token = comparisonToken;
    comparison = {
      ...comparison,
      pending: true,
      result: undefined,
      error: undefined,
    };
    paintComparison(comparison);
    try {
      const result = await options.client.compare(leftId, rightId);
      if (disposed || token !== comparisonToken) {
        return;
      }
      comparison = {
        leftId,
        rightId,
        pending: false,
        result: { comparison: result, leftId, rightId },
        error: undefined,
      };
    } catch (cause) {
      if (disposed || token !== comparisonToken) {
        return;
      }
      comparison = {
        leftId,
        rightId,
        pending: false,
        result: undefined,
        error: sanitizedMessage(cause),
      };
    }
    paintComparison(comparison);
  };

  const applyDiff = async (diff: ViewDiff): Promise<void> => {
    status = diff.status;
    refreshing = diff.refreshing;
    viewError = diff.error;
    if (diff.summary !== undefined) {
      if (
        view !== undefined &&
        view.projectionId !== diff.summary.projectionId
      ) {
        setNotice(
          `The projection was refitted (${diff.summary.projectionId}); the map layout changed.`,
        );
      }
      view = diff.summary;
    }
    if (diff.summary === undefined) {
      renderStatus();
      return;
    }
    const startedAt = now();
    applying = true;
    renderStatus();
    let report: ApplyReport;
    try {
      report = await model.applyDiff(diff, {
        ...(batchSize === undefined ? {} : { batchSize }),
        ...(yieldFrame === undefined ? {} : { yieldFrame }),
      });
    } finally {
      applying = false;
    }
    if (disposed) {
      return;
    }
    if (report.batches > 0) {
      // Only a plan that changed the display is an applied update; a poll of the same view is not.
      const finishedAt = now();
      lastApply = {
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        batches: report.batches,
        addedNodes: report.addedNodes,
        removedNodes: report.removedNodes,
        updatedNodes: report.updatedNodes,
        addedLinks: report.addedLinks,
        removedLinks: report.removedLinks,
      };
    }
    const active = startRenderer();
    active.includeBounds(diff.summary.bounds);
    if (diff.initial) {
      active.fitAll();
    }
    active.styleChanged();
    if (report.selectionCleared) {
      detailsState = { kind: "empty" };
      paintDetails(detailsState);
      renderControls();
    }
    renderStatus();
    syncResultMapping();
    renderResults();
  };

  const syncResultMapping = (): void => {
    const unmapped = results.unmappedIds((nodeId) => model.hasNode(nodeId));
    if (unmapped.length === 0) {
      return;
    }
    const revision = results.revision();
    if (missingRequestRevision === revision) {
      return;
    }
    missingRequestRevision = revision;
    void options.client.refresh().catch((cause: unknown) => {
      setNotice(
        `A refresh for unmapped results could not be requested: ${sanitizedMessage(cause)}`,
      );
    });
  };

  const pollGraph = async (): Promise<void> => {
    const text = await options.client.graphText();
    if (disposed) {
      return;
    }
    const diff = await options.differ.plan(text);
    if (disposed) {
      return;
    }
    await applyDiff(diff);
  };

  const fail = (cause: unknown): void => {
    if (disposed) {
      return;
    }
    status = view === undefined ? "error" : status;
    setNotice(
      `The inspection host could not be polled: ${sanitizedMessage(cause)}. ${
        view === undefined ? "" : "The last completed view is still displayed."
      }`,
    );
    renderStatus();
  };

  const poll: PollLoop = createPollLoop({
    poll: pollGraph,
    nextDelayMs: () => (refreshing ? refreshingPollIntervalMs : pollIntervalMs),
    scheduler,
    onError: fail,
  });

  const requestRefresh = async (): Promise<void> => {
    await options.client.refresh();
    poll.triggerNow();
  };

  const requestRebuild = async (): Promise<void> => {
    await options.client.rebuildProjection();
    setNotice(
      "A full projection refit was requested; the map updates after the next complete export.",
    );
    poll.triggerNow();
  };

  const submitSearch = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const submittedAt = now();
    const query = shell.query.value.trim();
    const limit = shell.limit.value.trim();
    const linkedLimit = shell.linkedLimit.value.trim();
    const request: SearchRequest = {
      query,
      ...(limit === "" ? {} : { limit: Number(limit) }),
      ...(linkedLimit === "" ? {} : { linkedLimit: Number(linkedLimit) }),
    };
    const id = results.begin(request);
    renderResults();
    renderControls();
    renderer?.styleChanged();
    try {
      const outcome = await options.client.search(request);
      if (disposed || !results.accept(id, outcome)) {
        return;
      }
    } catch (cause) {
      if (disposed || !results.fail(id, sanitizedMessage(cause))) {
        return;
      }
    }
    renderer?.styleChanged();
    renderResults();
    renderControls();
    syncResultMapping();
    void loadDetails();
    lastSearchMs = now() - submittedAt;
  };

  const clearRequest = (): void => {
    results.clear();
    comparison = {
      leftId: comparisonHistory[1],
      rightId: comparisonHistory[0],
      pending: false,
      result: undefined,
      error: undefined,
    };
    renderer?.styleChanged();
    renderResults();
    renderControls();
    paintComparison(comparison);
    void loadDetails();
  };

  shell.refresh.addEventListener("click", () => {
    void requestRefresh().catch((cause: unknown) => {
      setNotice(
        `The refresh could not be requested: ${sanitizedMessage(cause)}`,
      );
    });
  });
  shell.rebuild.addEventListener("click", () => {
    void requestRebuild().catch((cause: unknown) => {
      setNotice(
        `The projection rebuild could not be requested: ${sanitizedMessage(cause)}`,
      );
    });
  });
  shell.fitAll.addEventListener("click", () => {
    renderer?.fitAll();
  });
  shell.fitResults.addEventListener("click", () => {
    renderer?.fitNodes(results.resultIds());
  });
  shell.focusSelected.addEventListener("click", () => {
    const selected = model.selectedId;
    if (selected !== undefined) {
      renderer?.focus(selected);
    }
  });
  for (const input of shell.linkModes) {
    input.addEventListener("change", () => {
      if (
        input.checked &&
        model.setLinkMode(input.value === "focused" ? "focused" : "all")
      ) {
        renderer?.styleChanged();
        renderControls();
      }
    });
  }
  shell.queryForm.addEventListener("submit", (event) => {
    void submitSearch(event);
  });
  shell.clearResults.addEventListener("click", () => {
    clearRequest();
  });

  const scheduleFreshness = (): void => {
    scheduler.setTimeout(() => {
      if (disposed) {
        return;
      }
      // Ages change without a new export: redraw the colors and the displayed age.
      renderer?.styleChanged();
      paintDetails(detailsState);
      scheduleFreshness();
    }, freshnessIntervalMs);
  };
  scheduleFreshness();

  renderLegend();
  renderAll();
  poll.start();

  return {
    dispose: (): void => {
      disposed = true;
      poll.stop();
      options.differ.dispose();
      renderer?.dispose();
    },
    pollNow: (): void => {
      poll.triggerNow();
    },
    requestRefresh,
    requestRebuild,
    select,
    display: (nodeIds: readonly string[]) =>
      nodeIds
        .filter((nodeId) => model.hasNode(nodeId))
        .map((nodeId) => {
          const attributes = model.graph.getNodeAttributes(nodeId);
          return {
            id: nodeId,
            x: attributes.x,
            y: attributes.y,
            label: attributes.label,
            updatedAt: attributes.updatedAt,
          };
        }),
    cameraState: () => renderer?.cameraState() ?? { x: 0.5, y: 0.5, ratio: 1 },
    viewportPosition: (nodeId) => renderer?.viewportPosition(nodeId),
    diagnostics: (): DashboardDiagnostics => ({
      status,
      refreshing,
      error: viewError,
      differUsesWorker: options.differ.usesWorker(),
      view,
      nodes: model.graph.order,
      links: model.graph.size,
      selectedId: model.selectedId,
      linkMode: model.linkMode,
      highlightedIds: [...results.highlightIds],
      resultOrder: results.resultIds(),
      unmappedIds: results.unmappedIds((nodeId) => model.hasNode(nodeId)),
      lastApply,
      lastSearchMs,
      lastSelectionMs,
    }),
  };
};
