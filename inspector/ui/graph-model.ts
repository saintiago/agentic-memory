/**
 * The displayed Graphology graph: stored notes at their projected positions, stored directed
 * links, the selection and the all-links versus focused-links control. Applying a planned view
 * diff mutates this one graph instead of recreating it, so Sigma, the camera and the selection
 * survive refreshes. Applying a diff is idempotent, so a repeated plan cannot corrupt the
 * display.
 *
 * See docs/dashboard.md#live-updates-with-sigma and docs/dashboard.md#asynchronous-data-updates.
 */
import { DirectedGraph } from "graphology";

import { linkKey, type ViewDiff } from "./view-diff.js";
import type { LinkAttributes, NodeAttributes, StyleSource } from "./style.js";

/** The result state the display highlight is derived from. */
export interface ResultsSource {
  readonly highlightIds: ReadonlySet<string>;
  retrievalKind(nodeId: string): "match" | "link" | undefined;
}

/** One completed application of a view diff. */
export interface ApplyReport {
  readonly batches: number;
  readonly addedNodes: number;
  readonly removedNodes: number;
  readonly updatedNodes: number;
  readonly addedLinks: number;
  readonly removedLinks: number;
  readonly selectionCleared: boolean;
}

export interface ApplyOptions {
  /** Mutations applied between two frame yields. */
  readonly batchSize?: number;
  /** Yield to the event loop between batches; the browser waits for the next animation frame. */
  readonly yieldFrame?: () => Promise<void>;
}

/**
 * One batch costs a full renderer redraw, so the default batch stays large enough to amortize
 * that work while still yielding between animation frames on a large import.
 */
const defaultBatchSize = 5_000;

/** Wait for the next animation frame, keeping input handling between mutation batches. */
export const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });

/** One process's displayed graph and its selection state. */
export class GraphModel implements StyleSource {
  readonly graph = new DirectedGraph<NodeAttributes, LinkAttributes>();
  #results: ResultsSource;
  #now: () => number;
  #selectedId: string | undefined;
  #linkMode: "all" | "focused" = "all";

  constructor(options: {
    readonly results: ResultsSource;
    readonly now?: () => number;
  }) {
    this.#results = options.results;
    this.#now = options.now ?? ((): number => Date.now());
  }

  get highlightIds(): ReadonlySet<string> {
    return this.#results.highlightIds;
  }

  retrievalKind(nodeId: string): "match" | "link" | undefined {
    return this.#results.retrievalKind(nodeId);
  }

  get selectedId(): string | undefined {
    return this.#selectedId;
  }

  get linkMode(): "all" | "focused" {
    return this.#linkMode;
  }

  now(): number {
    return this.#now();
  }

  /** Select one displayed memory, or clear the selection with `undefined`. */
  select(nodeId: string | undefined): boolean {
    const next =
      nodeId !== undefined && this.graph.hasNode(nodeId) ? nodeId : undefined;
    if (next === this.#selectedId) {
      return false;
    }
    this.#selectedId = next;
    return true;
  }

  setLinkMode(mode: "all" | "focused"): boolean {
    if (mode === this.#linkMode) {
      return false;
    }
    this.#linkMode = mode;
    return true;
  }

  isNearSelection(nodeId: string): boolean {
    const selected = this.#selectedId;
    if (selected === undefined) {
      return false;
    }
    return (
      nodeId === selected ||
      this.graph.hasEdge(selected, nodeId) ||
      this.graph.hasEdge(nodeId, selected)
    );
  }

  hasNode(nodeId: string): boolean {
    return this.graph.hasNode(nodeId);
  }

  /** The IDs of the supplied memories that the current display does not contain. */
  missingIds(nodeIds: Iterable<string>): string[] {
    const missing: string[] = [];
    for (const nodeId of nodeIds) {
      if (!this.graph.hasNode(nodeId)) {
        missing.push(nodeId);
      }
    }
    return missing;
  }

  counts(): { readonly nodes: number; readonly links: number } {
    return { nodes: this.graph.order, links: this.graph.size };
  }

  /**
   * Apply one planned view diff in bounded batches that yield to the caller between them. An
   * existing node keeps its identity and receives the served attributes, so a refresh never
   * recreates the graph behind Sigma.
   */
  async applyDiff(
    diff: ViewDiff,
    options: ApplyOptions = {},
  ): Promise<ApplyReport> {
    const batchSize = Math.max(1, options.batchSize ?? defaultBatchSize);
    const yieldFrame = options.yieldFrame ?? nextFrame;
    let applied = 0;
    let batches = 0;
    for (const mutate of this.#mutations(diff)) {
      if (applied > 0 && applied % batchSize === 0) {
        batches += 1;
        await yieldFrame();
      }
      mutate();
      applied += 1;
    }
    if (applied > 0) {
      batches += 1;
    }
    const selectionCleared =
      this.#selectedId !== undefined && !this.graph.hasNode(this.#selectedId);
    if (selectionCleared) {
      this.#selectedId = undefined;
    }
    return {
      batches,
      addedNodes: diff.addedNodes.length,
      removedNodes: diff.removedNodeIds.length,
      updatedNodes: diff.updatedNodes.length,
      addedLinks: diff.addedLinks.length,
      removedLinks: diff.removedLinkKeys.length,
      selectionCleared,
    };
  }

  /** The ordered mutation steps of one view diff; removals run before additions. */
  *#mutations(diff: ViewDiff): Generator<() => void> {
    for (const key of diff.removedLinkKeys) {
      yield () => {
        if (this.graph.hasEdge(key)) {
          this.graph.dropEdge(key);
        }
      };
    }
    for (const nodeId of diff.removedNodeIds) {
      yield () => {
        if (this.graph.hasNode(nodeId)) {
          this.graph.dropNode(nodeId);
        }
      };
    }
    for (const node of diff.updatedNodes) {
      yield () => {
        this.#writeNode(node);
      };
    }
    for (const node of diff.addedNodes) {
      yield () => {
        this.#writeNode(node);
      };
    }
    for (const edge of diff.addedLinks) {
      yield () => {
        const key = linkKey(edge.source, edge.target);
        if (
          !this.graph.hasEdge(key) &&
          this.graph.hasNode(edge.source) &&
          this.graph.hasNode(edge.target)
        ) {
          this.graph.addDirectedEdgeWithKey(key, edge.source, edge.target, {
            kind: "link",
          });
        }
      };
    }
  }

  /** Write one served node whether or not it is already displayed. */
  #writeNode(node: {
    readonly id: string;
    readonly label: string;
    readonly x: number;
    readonly y: number;
    readonly updatedAt?: string | undefined;
  }): void {
    const attributes: NodeAttributes = {
      label: node.label,
      x: node.x,
      y: node.y,
      ...(node.updatedAt === undefined ? {} : { updatedAt: node.updatedAt }),
    };
    if (this.graph.hasNode(node.id)) {
      this.graph.replaceNodeAttributes(node.id, attributes);
    } else {
      this.graph.addNode(node.id, attributes);
    }
  }
}
