/**
 * The details and comparison panels in a real DOM: stored evidence rendered as inert text, the
 * update time and observation time kept apart, unresolved link targets listed without inventing
 * nodes, and the stored-vector comparison labelled as separate from the projection.
 *
 * See docs/dashboard.md#visual-behavior and docs/dashboard.md#acceptance-checks.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  renderComparison,
  renderDetails,
  type ComparisonState,
  type DetailsContext,
} from "../details.js";
import { nodeId, note } from "./support.js";

const context = (
  options: {
    readonly hasNode?: (nodeIdValue: string) => boolean;
    readonly onSelect?: (nodeIdValue: string) => void;
  } = {},
): DetailsContext => ({
  now: Date.parse("2026-09-28T12:00:00.000Z"),
  view: {
    capturedAt: "2026-09-28T11:30:00.000Z",
    embeddingSpaceId: "test-space",
    projectionId: "test-projection",
    layout: "umap",
    bounds: { x: [0, 1], y: [0, 1] },
    nodeCount: 2,
    linkCount: 1,
  },
  hasNode: options.hasNode ?? (() => false),
  onSelect: options.onSelect ?? (() => undefined),
});

describe("details panel", () => {
  it("renders every stored field as inert text", () => {
    const container = document.createElement("div");
    const markup = '<img src="x" onerror="window.hacked = true">';
    renderDetails(
      container,
      {
        kind: "note",
        nodeId: nodeId(0),
        label: "A memory",
        note: note(0, {
          content: `Source text ${markup}`,
          context: `Context ${markup}`,
          keywords: [`key ${markup}`],
          tags: ["tag"],
          metadata: { origin: markup },
        }),
        returnedAt: "2026-09-28T12:05:00.000Z",
      },
      context(),
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(markup);
    expect(container.textContent).toContain("Source text");
    expect(container.textContent).toContain("tag");
    expect(container.textContent).toContain("origin");
    expect(container.textContent).toContain(
      "returned by the memory request at 2026-09-28T12:05:00.000Z",
    );
  });

  it("shows an unknown update time as unknown next to the observation time", () => {
    const container = document.createElement("div");
    renderDetails(
      container,
      {
        kind: "note",
        nodeId: nodeId(0),
        label: "A memory",
        note: note(0, { timestamp: "2026-09-20T10:00:00.000Z" }),
        returnedAt: undefined,
      },
      context(),
    );

    const text = container.textContent ?? "";
    expect(text).toContain(
      "unknown — this memory has no persisted update time",
    );
    expect(text).toContain("2026-09-20T10:00:00.000Z");
    expect(text).toContain("View captured at");
    expect(text).toContain("2026-09-28T11:30:00.000Z");
    expect(text).not.toContain("2026-09-28T11:30:00.000Z (");
    expect(text).toContain(
      "read from the host; the current request did not return this memory",
    );
  });

  it("shows the exact update time and the elapsed age for a known update", () => {
    const container = document.createElement("div");
    renderDetails(
      container,
      {
        kind: "note",
        nodeId: nodeId(0),
        label: "A memory",
        note: note(0, { updatedAt: "2026-09-28T11:00:00.000Z" }),
        returnedAt: undefined,
      },
      context(),
    );

    expect(container.textContent).toContain(
      "2026-09-28T11:00:00.000Z (1–24 hours, 1 hour before this observation)",
    );
  });

  it("lists displayed links as buttons and unresolved targets explicitly", () => {
    const container = document.createElement("div");
    const selected: string[] = [];
    renderDetails(
      container,
      {
        kind: "note",
        nodeId: nodeId(0),
        label: "A memory",
        note: note(0, { links: [nodeId(1), nodeId(9)] }),
        returnedAt: undefined,
      },
      context({
        hasNode: (nodeIdValue) => nodeIdValue === nodeId(1),
        onSelect: (nodeIdValue) => {
          selected.push(nodeIdValue);
        },
      }),
    );

    const button = container.querySelector("button");
    expect(button?.textContent).toContain(nodeId(1));
    button?.click();
    expect(selected).toEqual([nodeId(1)]);
    expect(container.textContent).toContain(
      `outgoing → ${nodeId(9)} (target not in the current view)`,
    );
  });

  it("shows an unavailable memory with the reason", () => {
    const container = document.createElement("div");
    renderDetails(
      container,
      {
        kind: "unavailable",
        nodeId: nodeId(4),
        label: "Gone",
        message: "The host no longer contains this note.",
      },
      context(),
    );

    expect(container.textContent).toContain("Gone");
    expect(container.textContent).toContain(
      "The host no longer contains this note.",
    );
  });
});

describe("comparison panel", () => {
  const state = (
    overrides: Partial<ComparisonState> = {},
  ): ComparisonState => ({
    leftId: nodeId(0),
    rightId: nodeId(1),
    pending: false,
    result: undefined,
    error: undefined,
    ...overrides,
  });

  it("describes the measure as original-space cosine similarity, not projection distance", () => {
    const container = document.createElement("div");
    renderComparison(container, state(), {
      label: (nodeIdValue) => `Memory ${nodeIdValue}`,
      onCompare: () => undefined,
    });

    const text = container.textContent ?? "";
    expect(text).toContain("original stored");
    expect(text).toContain("not the screen distance");
    expect(text).toContain("not a retrieval score");
    expect(text).toContain(`Memory ${nodeId(0)}`);
    expect(text).toContain(`Memory ${nodeId(1)}`);
  });

  it("disables the explicit comparison until two distinct memories are selected", () => {
    const container = document.createElement("div");
    renderComparison(container, state({ rightId: nodeId(0) }), {
      label: (nodeIdValue) => nodeIdValue,
      onCompare: () => undefined,
    });

    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
  });

  it("runs the comparison and shows the similarity with its capture time", () => {
    const container = document.createElement("div");
    const compared: number[] = [];
    renderComparison(
      container,
      state({
        result: {
          leftId: nodeId(0),
          rightId: nodeId(1),
          comparison: {
            similarity: 0.8123456,
            capturedAt: "2026-09-28T11:30:00.000Z",
          },
        },
      }),
      {
        label: (nodeIdValue) => nodeIdValue,
        onCompare: () => {
          compared.push(1);
        },
      },
    );
    container.querySelector("button")?.click();

    expect(compared).toEqual([1]);
    expect(container.textContent).toContain("0.8123");
    expect(container.textContent).toContain("2026-09-28T11:30:00.000Z");
  });

  it("shows a comparison failure as an error", () => {
    const container = document.createElement("div");
    renderComparison(container, state({ error: "The comparison failed." }), {
      label: (nodeIdValue) => nodeIdValue,
      onCompare: () => undefined,
    });

    expect(container.textContent).toContain("The comparison failed.");
  });
});
