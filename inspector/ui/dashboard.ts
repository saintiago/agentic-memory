/**
 * The inspection dashboard controller: it composes the HTTP client, the view planner, the
 * Graphology display model and the renderer, and keeps the status, results, details and
 * comparison panels in sync. Data loading, refresh, search and projection run asynchronously
 * while the existing graph stays interactive and the camera and selection survive updates.
 *
 * See docs/dashboard.md#asynchronous-data-updates and docs/dashboard.md#memory-requests.
 */
import type { DirectedGraph } from "graphology";

import { memoryKey } from "./identity.js";
import type { InspectorClient } from "./client.js";
import { renderComparison, renderDetails } from "./details.js";
import type { ComparisonState, DetailsState } from "./details.js";
import { clear, element } from "./dom.js";
import { formatCount, formatDuration, formatScore } from "./format.js";
import { freshnessLegend } from "./freshness.js";
import { GraphModel, type ApplyReport } from "./graph-model.js";
import { type GraphEventHandlers, type GraphEventStream } from "./events.js";
import type { DashboardRenderer } from "./renderer.js";
import { SearchResults, type SearchRequest } from "./results.js";
import { installShell, type Shell } from "./shell.js";
import type { LinkAttributes, NodeAttributes, StyleSource } from "./style.js";
import { browserScheduler, type TimerScheduler } from "./timer.js";
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
  /** The selected memory, which may be a returned result the map does not contain yet. */
  readonly selectedId: string | undefined;
  readonly linkMode: "all" | "focused";
  readonly highlightedIds: readonly string[];
  readonly resultOrder: readonly string[];
  readonly unmappedIds: readonly string[];
  readonly lastApply: ApplyMeasurement | undefined;
  /** The handler latency of the latest request: submission to the updated results panel. */
  readonly lastSearchMs: number | undefined;
  /**
   * The handler latency of the latest selection: click to the updated details panel, which the
   * browser paints in the next frame.
   */
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
  /** The same-origin `/api/events` subscription; the dashboard owns its start and stop. */
  readonly events: (handlers: GraphEventHandlers) => GraphEventStream;
  /** The first delay before a failed graph fetch is retried; the default is 1 second. */
  readonly retryBaseMs?: number;
  /** The longest delay between graph fetch retries; the default is 30 seconds. */
  readonly retryMaxMs?: number;
  readonly freshnessIntervalMs?: number;
  readonly scheduler?: TimerScheduler;
}

export interface Dashboard {
  dispose(): void;
  /** Fetch the latest served graph now, coalescing with a fetch that is already running. */
  pollNow(): void;
  /** Request one inspection refresh and fetch its result. */
  requestRefresh(): Promise<void>;
  /** Request a full projection refit and fetch its result. */
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
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const retryMaxMs = options.retryMaxMs ?? 30_000;
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
  /** The summary of the completed view the display currently shows. */
  let view: ViewSummary | undefined;
  /** The summary being applied right now; it becomes `view` only once the display holds it. */
  let applyingView: ViewSummary | undefined;
  let hasAppliedView = false;
  /**
   * The selected memory. It can be a returned memory the map does not contain yet, so it is not
   * always the display model's positioned selection.
   */
  let selectionId: string | undefined;
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
  /** The notice text a failed graph fetch wrote; a later success clears exactly this one. */
  let syncingNotice: string | undefined;
  /** The live notification channel state, independent from graph loading and refresh state. */
  let connection: "connecting" | "connected" | "reconnecting" = "connecting";
  /** One graph fetch at a time; a notification during a fetch is remembered and rerun after. */
  let syncing = false;
  let syncQueued = false;
  let retryTimer: number | undefined;
  let retryAttempt = 0;

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

  const renderConnection = (): void => {
    shell.connectionStatus.dataset.state =
      connection === "connected"
        ? "online"
        : connection === "reconnecting"
          ? "offline"
          : "connecting";
    shell.connectionLabel.textContent =
      connection === "connected"
        ? "Online"
        : connection === "reconnecting"
          ? "Offline · reconnecting"
          : "Connecting";
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
    if (applyingView !== undefined) {
      parts.push(
        `${formatCount(applyingView.nodeCount)} memories and ${formatCount(applyingView.linkCount)} links in the completed view being applied`,
      );
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
      return model.graph.getNodeAttributes(memoryKey(nodeId)).label;
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
      const selected = selectionId === memoryKey(result.note.id);
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
      hasPosition: (nodeId) => model.hasNode(nodeId),
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
    renderConnection();
    renderStatus();
    renderResults();
    paintDetails(detailsState);
    paintComparison(comparison);
    renderControls();
  };

  /**
   * Whether the selection still has evidence: a positioned memory of the display, or a returned
   * memory that keeps its request payload as its evidence.
   */
  const selectionKnown = (nodeId: string): boolean =>
    model.hasNode(nodeId) || results.noteFor(nodeId) !== undefined;

  /** Drop a comparison result or an in-flight answer whose pair is no longer the current one. */
  const resetComparison = (): void => {
    comparisonToken += 1;
    comparison = {
      leftId: comparisonHistory[1],
      rightId: comparisonHistory[0],
      pending: false,
      result: undefined,
      error: undefined,
    };
  };

  const select = (nodeId: string | undefined): void => {
    if (disposed) {
      return;
    }
    const selectedAt = now();
    const resolved =
      nodeId !== undefined && selectionKnown(nodeId)
        ? memoryKey(nodeId)
        : undefined;
    if (resolved === undefined && selectionId === undefined) {
      return;
    }
    selectionId = resolved;
    // The map can mark a selection only where the memory is positioned; a returned memory the
    // view does not contain yet is selected through its returned payload instead of a new node.
    model.select(
      resolved !== undefined && model.hasNode(resolved) ? resolved : undefined,
    );
    if (resolved !== undefined) {
      const history = [
        resolved,
        ...comparisonHistory.filter((id) => id !== resolved),
      ].slice(0, 2);
      if (
        history[0] !== comparisonHistory[0] ||
        history[1] !== comparisonHistory[1]
      ) {
        comparisonHistory = history;
        resetComparison();
      }
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
    const nodeId = selectionId;
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

  /** Whether a comparison answer still describes the pair the panel currently shows. */
  const comparisonStillCurrent = (
    token: number,
    leftId: string,
    rightId: string,
  ): boolean =>
    !disposed &&
    token === comparisonToken &&
    comparison.leftId === leftId &&
    comparison.rightId === rightId;

  const compare = async (): Promise<void> => {
    const leftId = comparison.leftId;
    const rightId = comparison.rightId;
    if (
      leftId === undefined ||
      rightId === undefined ||
      leftId === rightId ||
      // The host compares vectors of its completed view; a memory the map does not hold cannot
      // be compared, so the action stays unavailable instead of failing on the round trip.
      !model.hasNode(leftId) ||
      !model.hasNode(rightId)
    ) {
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
      if (!comparisonStillCurrent(token, leftId, rightId)) {
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
      if (!comparisonStillCurrent(token, leftId, rightId)) {
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

  /**
   * Bring the selection and the details panel in line with a completed view. A returned memory
   * keeps its returned payload as evidence; a memory read from the host is read again once the
   * display moves, so the panel never keeps evidence the current note does not have.
   */
  const reconcileSelection = (
    diff: ViewDiff,
    displayed: ViewSummary | undefined,
  ): void => {
    const selected = selectionId;
    if (selected === undefined) {
      paintDetails(detailsState);
      return;
    }
    if (!selectionKnown(selected)) {
      // The memory left both the map and the request evidence. Bumping the details token through
      // loadDetails() also discards a read that is still in flight for it.
      selectionId = undefined;
      model.select(undefined);
      resetComparison();
      void loadDetails();
      return;
    }
    model.select(model.hasNode(selected) ? selected : undefined);
    if (detailsState.kind === "note" && detailsState.returnedAt !== undefined) {
      paintDetails(detailsState);
      return;
    }
    const viewMoved = displayed?.capturedAt !== view?.capturedAt;
    const nodeChanged =
      diff.updatedNodes.some((node) => memoryKey(node.id) === selected) ||
      diff.addedNodes.some((node) => memoryKey(node.id) === selected);
    if (viewMoved || nodeChanged) {
      void loadDetails();
      return;
    }
    paintDetails(detailsState);
  };

  const applyDiff = async (diff: ViewDiff): Promise<void> => {
    status = diff.status;
    refreshing = diff.refreshing;
    viewError = diff.error;
    const summary = diff.summary;
    if (summary === undefined) {
      renderStatus();
      return;
    }
    const displayed = view;
    const refit =
      displayed !== undefined &&
      displayed.projectionId !== summary.projectionId;
    const startedAt = now();
    applying = true;
    applyingView = summary;
    renderStatus();
    let report: ApplyReport;
    try {
      report = await model.applyDiff(diff, {
        ...(batchSize === undefined ? {} : { batchSize }),
        ...(yieldFrame === undefined ? {} : { yieldFrame }),
        // A refit replaces the coordinate system of every memory; staged batches would let a
        // frame draw a mixture of the old and the new projection.
        atomic: refit && !diff.initial,
      });
    } finally {
      applying = false;
      applyingView = undefined;
    }
    if (disposed) {
      return;
    }
    // Publish the completed view only now that the display holds it, so the status line, the
    // details panel and comparison context never describe a view the map does not show yet.
    view = summary;
    if (refit) {
      setNotice(
        `The projection was refitted (${summary.projectionId}); the map layout changed.`,
      );
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
    active.includeBounds(summary.bounds);
    if (diff.initial && !hasAppliedView) {
      active.fitAll();
    }
    hasAppliedView = true;
    active.styleChanged();
    // Hand the planner the display it must reconcile a fallback against: a worker that fails later
    // plans against this index instead of an empty baseline.
    options.differ.adopt(model.viewIndex());
    reconcileSelection(diff, displayed);
    renderStatus();
    syncResultMapping();
    renderResults();
    // The comparison's availability follows the displayed positions of its pair.
    paintComparison(comparison);
    renderControls();
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

  const fetchGraph = async (): Promise<void> => {
    const text = await options.client.graphText();
    if (disposed) {
      return;
    }
    const diff = await options.differ.plan(text);
    if (disposed) {
      return;
    }
    await applyDiff(diff);
    if (syncingNotice !== undefined) {
      // The host answered and the completed view was applied, so a temporary outage is over.
      // Only the notice this sync wrote is cleared; unrelated notices stay.
      if (shell.notice.textContent === syncingNotice) {
        setNotice(undefined);
      }
      syncingNotice = undefined;
    }
  };

  const fail = (cause: unknown): void => {
    if (disposed) {
      return;
    }
    status = view === undefined ? "error" : status;
    syncingNotice = `The inspection host could not serve the latest graph: ${sanitizedMessage(
      cause,
    )}. ${view === undefined ? "" : "The last completed view is still displayed."}`;
    setNotice(syncingNotice);
    renderStatus();
  };

  const clearRetry = (): void => {
    if (retryTimer !== undefined) {
      scheduler.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  /** Retry a failed fetch with bounded backoff until a newer trigger supersedes it. */
  const scheduleRetry = (): void => {
    if (disposed || retryTimer !== undefined) {
      return;
    }
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** retryAttempt);
    retryAttempt += 1;
    retryTimer = scheduler.setTimeout(() => {
      retryTimer = undefined;
      syncNow();
    }, delay);
  };

  /** Serialize graph fetches; a notification during a fetch is applied by one later fetch. */
  const runSync = async (): Promise<void> => {
    syncing = true;
    try {
      await fetchGraph();
      retryAttempt = 0;
      clearRetry();
    } catch (cause) {
      // The notification channel replays nothing, so a failed fetch retries on its own.
      fail(cause);
      scheduleRetry();
    } finally {
      syncing = false;
      if (syncQueued) {
        syncQueued = false;
        // A newer notification supersedes a pending retry of the failed fetch.
        syncNow();
      }
    }
  };

  const syncNow = (): void => {
    if (disposed) {
      return;
    }
    // A newer trigger supersedes a pending retry, including a fresh manual request.
    clearRetry();
    if (syncing) {
      syncQueued = true;
      return;
    }
    void runSync();
  };

  const stream: GraphEventStream = options.events({
    onResync: () => {
      syncNow();
    },
    onStatus: (state) => {
      connection = state;
      renderConnection();
    },
  });

  const requestRefresh = async (): Promise<void> => {
    await options.client.refresh();
    syncNow();
  };

  const requestRebuild = async (): Promise<void> => {
    await options.client.rebuildProjection();
    setNotice(
      "A full projection refit was requested; the map updates after the next complete export.",
    );
    syncNow();
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
    // The cleared request is no longer evidence for any memory it returned, so a selection that
    // only existed through it has nothing left to show.
    if (selectionId !== undefined && !selectionKnown(selectionId)) {
      selectionId = undefined;
      model.select(undefined);
    }
    resetComparison();
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
  // Subscribe before the first fetch: the resync that every connection sends triggers it.
  stream.start();

  return {
    dispose: (): void => {
      disposed = true;
      clearRetry();
      stream.stop();
      options.differ.dispose();
      renderer?.dispose();
    },
    pollNow: (): void => {
      syncNow();
    },
    requestRefresh,
    requestRebuild,
    select,
    display: (nodeIds: readonly string[]) =>
      nodeIds
        .filter((nodeId) => model.hasNode(nodeId))
        .map((nodeId) => {
          const attributes = model.graph.getNodeAttributes(memoryKey(nodeId));
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
      selectedId: selectionId,
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
