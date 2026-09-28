/**
 * The styling rules of the displayed memories: freshness fill, selection and request highlighting,
 * dimmed surroundings and the all-links versus focused-links control. The rules are pure so the
 * Sigma reducers stay a thin adapter and a later renderer replacement keeps the same behavior.
 *
 * See docs/dashboard.md#visual-behavior, docs/dashboard.md#memory-requests and
 * docs/dashboard.md#vector-projection-and-proximity.
 */
import { freshnessOf } from "./freshness.js";
import { withAlpha } from "./format.js";

/** The evidence one displayed node carries. */
export interface NodeAttributes {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly updatedAt?: string;
}

/** The evidence one displayed directed link carries. */
export interface LinkAttributes {
  readonly kind: "link";
}

/** The display state the reducers read: the model's selection and the request's results. */
export interface StyleSource {
  /** The returned memory IDs of the latest accepted request. */
  readonly highlightIds: ReadonlySet<string>;
  /** The retrieval classification of one returned memory. */
  retrievalKind(nodeId: string): "match" | "link" | undefined;
  /** The selected memory ID, or `undefined`. */
  readonly selectedId: string | undefined;
  /** Whether links are shown for the whole displayed graph or around the selection. */
  readonly linkMode: "all" | "focused";
  /** Whether one memory is the selection or one of its direct neighbors. */
  isNearSelection(nodeId: string): boolean;
  /** The observation time freshness is computed against. */
  now(): number;
}

/** The node fields a renderer applies on top of the stored evidence. */
export interface NodeStyle {
  readonly label: string | null;
  readonly color: string;
  readonly size: number;
  readonly hidden: boolean;
  readonly highlighted: boolean;
  readonly forceLabel: boolean;
  readonly zIndex: number;
}

/** The link fields a renderer applies on top of the stored direction. */
export interface LinkStyle {
  readonly label: null;
  readonly color: string;
  readonly size: number;
  readonly hidden: boolean;
  readonly forceLabel: boolean;
  readonly zIndex: number;
}

const plainLinkColor = "rgba(78, 96, 110, 0.45)";
const dimLinkColor = "rgba(78, 96, 110, 0.12)";
/** Links between returned memories, and links around the selection, use distinct hues. */
const resultLinkColor = "rgba(194, 65, 12, 0.85)";
const selectionLinkColor = "rgba(15, 118, 110, 0.9)";

const nodeSize = 4.5;
const highlightedSize = 11;
const selectedSize = 13;
const dimmedSize = 3;

/** The label of one displayed memory, prefixed with the request and selection meaning. */
const displayLabel = (
  source: StyleSource,
  nodeId: string,
  label: string,
  selected: boolean,
): string => {
  const parts: string[] = [];
  const kind = source.retrievalKind(nodeId);
  if (kind === "match") {
    parts.push("Direct match");
  } else if (kind === "link") {
    parts.push("Linked addition");
  }
  if (selected) {
    parts.push("Selected");
  }
  return parts.length === 0 ? label : `${parts.join(" · ")} — ${label}`;
};

/**
 * Map one displayed memory to its fill, size and label. Freshness always fills the node; the
 * request highlight adds Sigma's highlight treatment and a forced label, and unrelated memories
 * are dimmed rather than recolored.
 */
export const nodeStyle = (
  source: StyleSource,
  nodeId: string,
  attributes: NodeAttributes,
): NodeStyle => {
  const freshness = freshnessOf(attributes.updatedAt, source.now());
  const selected = source.selectedId === nodeId;
  const returned = source.highlightIds.has(nodeId);
  const focus =
    source.linkMode === "focused" && source.selectedId !== undefined;
  const near = focus ? source.isNearSelection(nodeId) : false;
  const label = displayLabel(source, nodeId, attributes.label, selected);

  if (selected) {
    return {
      label,
      color: freshness.color,
      size: selectedSize,
      hidden: false,
      highlighted: true,
      forceLabel: true,
      zIndex: 3,
    };
  }
  if (returned) {
    return {
      label,
      color: freshness.color,
      size: highlightedSize,
      hidden: false,
      highlighted: true,
      forceLabel: true,
      zIndex: 2,
    };
  }
  const dimmed = (focus && !near) || (!focus && source.highlightIds.size > 0);
  return {
    label,
    color: dimmed ? withAlpha(freshness.color, 0.25) : freshness.color,
    size: dimmed ? dimmedSize : nodeSize,
    hidden: false,
    highlighted: false,
    forceLabel: false,
    zIndex: 0,
  };
};

/**
 * Map one stored directed link to its color and size. Result links and links around the selection
 * are emphasized; in focused mode every link that does not touch the selection is hidden.
 */
export const linkStyle = (
  source: StyleSource,
  link: { readonly source: string; readonly target: string },
): LinkStyle => {
  const selected = source.selectedId;
  const focus = source.linkMode === "focused" && selected !== undefined;
  const touchesSelection =
    selected !== undefined &&
    (link.source === selected || link.target === selected);
  if (focus && !touchesSelection) {
    return {
      label: null,
      color: dimLinkColor,
      size: 0.6,
      hidden: true,
      forceLabel: false,
      zIndex: 0,
    };
  }
  if (touchesSelection) {
    return {
      label: null,
      color: selectionLinkColor,
      size: 1.8,
      hidden: false,
      forceLabel: false,
      zIndex: 2,
    };
  }
  const betweenResults =
    source.highlightIds.size > 0 &&
    source.highlightIds.has(link.source) &&
    source.highlightIds.has(link.target);
  if (betweenResults) {
    return {
      label: null,
      color: resultLinkColor,
      size: 1.8,
      hidden: false,
      forceLabel: false,
      zIndex: 1,
    };
  }
  const dimmed = source.highlightIds.size > 0;
  return {
    label: null,
    color: dimmed ? dimLinkColor : plainLinkColor,
    size: dimmed ? 0.6 : 1,
    hidden: false,
    forceLabel: false,
    zIndex: 0,
  };
};
