/**
 * The details and comparison panels: the complete evidence of one selected memory, rendered as
 * inert text, and the explicit stored-vector comparison of the two most recently selected
 * memories. Update evidence and observation time are shown separately.
 *
 * See docs/dashboard.md#visual-behavior and docs/dashboard.md#vector-projection-and-proximity.
 */
import type { Note } from "../../src/note-store/index.js";
import { clear, element, field } from "./dom.js";
import { formatScore, formatTimestamp } from "./format.js";
import { freshnessOf } from "./freshness.js";
import type { Comparison } from "./client.js";
import type { ViewSummary } from "./view-diff.js";

/** What the details panel currently shows. */
export type DetailsState =
  | { readonly kind: "empty" }
  | {
      readonly kind: "loading";
      readonly nodeId: string;
      readonly label: string;
    }
  | {
      readonly kind: "note";
      readonly nodeId: string;
      readonly label: string;
      readonly note: Note;
      /** The request time when the payload came from the current request's results. */
      readonly returnedAt: string | undefined;
    }
  | {
      readonly kind: "unavailable";
      readonly nodeId: string;
      readonly label: string;
      readonly message: string;
    };

export interface DetailsContext {
  /** The observation time the displayed age is measured against. */
  readonly now: number;
  /** The completed view the display currently shows, when one is ready. */
  readonly view: ViewSummary | undefined;
  /** Whether the displayed graph contains one memory. */
  readonly hasNode: (nodeId: string) => boolean;
  /** Select one displayed link target. */
  readonly onSelect: (nodeId: string) => void;
}

const heading = (nodeId: string, label: string): HTMLElement => {
  const title = element("h3", { className: "details-title", text: label });
  title.append(
    element("span", { className: "details-id", text: `ID ${nodeId}` }),
  );
  return title;
};

const linkList = (note: Note, context: DetailsContext): HTMLElement => {
  const list = element("ul", { className: "link-list" });
  if (note.links.length === 0) {
    list.append(
      element("li", { className: "muted", text: "No stored links." }),
    );
    return list;
  }
  for (const link of note.links) {
    const item = element("li");
    if (context.hasNode(link)) {
      const button = element("button", {
        className: "link-button",
        text: `outgoing → ${link}`,
        type: "button",
      });
      button.addEventListener("click", () => {
        context.onSelect(link);
      });
      item.append(button);
    } else {
      item.append(
        element("span", {
          className: "unresolved",
          text: `outgoing → ${link} (target not in the current view)`,
        }),
      );
    }
    list.append(item);
  }
  return list;
};

/** Render the details panel for the current selection state. */
export const renderDetails = (
  container: HTMLElement,
  state: DetailsState,
  context: DetailsContext,
): void => {
  clear(container);
  if (state.kind === "empty") {
    container.append(
      element("p", {
        className: "muted",
        text: "Select a memory on the map or in the results to inspect its stored evidence.",
      }),
    );
    return;
  }
  if (state.kind === "loading") {
    container.append(
      heading(state.nodeId, state.label),
      element("p", { className: "muted", text: "Reading the current note…" }),
    );
    return;
  }
  if (state.kind === "unavailable") {
    container.append(
      heading(state.nodeId, state.label),
      element("p", { className: "error", text: state.message }),
    );
    return;
  }

  const note = state.note;
  const freshness = freshnessOf(note.updatedAt, context.now);
  container.append(heading(note.id, state.label));
  container.append(
    field("Content", note.content),
    field("Context", note.context),
    field("Keywords", note.keywords.join(", ") || "none"),
    field("Tags", note.tags.join(", ") || "none"),
    field("Memory timestamp (observation)", formatTimestamp(note.timestamp)),
    field(
      "Update evidence",
      note.updatedAt === undefined
        ? "unknown — this memory has no persisted update time"
        : `${note.updatedAt} (${freshness.label}, ${freshness.ageLabel} before this observation)`,
    ),
    field(
      "View captured at",
      formatTimestamp(context.view?.capturedAt),
      "field-value",
    ),
    field(
      "Evidence source",
      state.returnedAt === undefined
        ? "read from the host; the current request did not return this memory"
        : `returned by the memory request at ${state.returnedAt}`,
    ),
  );
  container.append(element("h4", { text: "Stored outgoing links" }));
  container.append(linkList(note, context));
  container.append(element("h4", { text: "Provenance and metadata" }));
  container.append(
    field(
      "Metadata",
      note.metadata === undefined
        ? "none"
        : JSON.stringify(note.metadata, null, 2),
    ),
  );
};

/** The comparison state of the two most recently selected memories. */
export interface ComparisonState {
  readonly leftId: string | undefined;
  readonly rightId: string | undefined;
  readonly pending: boolean;
  readonly result:
    | {
        readonly comparison: Comparison;
        readonly leftId: string;
        readonly rightId: string;
      }
    | undefined;
  readonly error: string | undefined;
}

export interface ComparisonContext {
  /** A short label for one memory; falls back to the ID. */
  readonly label: (nodeId: string) => string;
  readonly onCompare: () => void;
}

/** Render the explicit stored-vector comparison panel. */
export const renderComparison = (
  container: HTMLElement,
  state: ComparisonState,
  context: ComparisonContext,
): void => {
  clear(container);
  container.append(
    element("p", {
      className: "muted",
      text:
        "Compares the two most recently selected memories through the host's original stored " +
        "vectors. Cosine similarity is not the screen distance of the approximate projection " +
        "and is not a retrieval score.",
    }),
  );
  const pair = element("dl", { className: "pair" });
  const pairRow = (name: string, nodeId: string | undefined): void => {
    pair.append(element("dt", { text: name }));
    pair.append(
      element("dd", {
        text:
          nodeId === undefined
            ? "select another memory"
            : `${context.label(nodeId)} (${nodeId})`,
      }),
    );
  };
  pairRow("Earlier selection", state.leftId);
  pairRow("Latest selection", state.rightId);
  container.append(pair);

  const button = element("button", {
    id: "compare",
    type: "button",
    text: "Compare stored vectors",
  });
  button.disabled =
    state.pending ||
    state.leftId === undefined ||
    state.rightId === undefined ||
    state.leftId === state.rightId;
  button.addEventListener("click", () => {
    context.onCompare();
  });
  container.append(element("div", { className: "actions" }, [button]));

  if (state.error !== undefined) {
    container.append(element("p", { className: "error", text: state.error }));
  }
  if (state.result !== undefined) {
    container.append(
      field(
        "Cosine similarity of stored vectors",
        formatScore(state.result.comparison.similarity),
      ),
      field(
        "Computed from the view captured at",
        state.result.comparison.capturedAt,
      ),
    );
  }
};
