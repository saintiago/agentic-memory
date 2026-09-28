/**
 * The display rules: freshness fills every memory, returned memories keep that fill while gaining
 * Sigma's highlight treatment and forced labels, unrelated memories and links are dimmed, and the
 * focused-links control hides everything that does not touch the selection.
 *
 * See docs/dashboard.md#visual-behavior and docs/dashboard.md#memory-requests.
 */
import { describe, expect, it } from "vitest";

import { unknownFreshnessColor } from "../freshness.js";
import { linkStyle, nodeStyle, type StyleSource } from "../style.js";

const now = Date.parse("2026-09-28T12:00:00.000Z");

const style = (options: {
  readonly highlightIds?: readonly string[];
  readonly kinds?: Readonly<Record<string, "match" | "link">>;
  readonly selectedId?: string;
  readonly linkMode?: "all" | "focused";
  readonly near?: readonly string[];
}): StyleSource => {
  const highlightIds = new Set(options.highlightIds ?? []);
  const near = new Set(options.near ?? []);
  return {
    highlightIds,
    retrievalKind: (nodeId) => options.kinds?.[nodeId],
    selectedId: options.selectedId,
    linkMode: options.linkMode ?? "all",
    isNearSelection: (nodeId) => near.has(nodeId),
    now: () => now,
  };
};

const fresh = {
  label: "Fresh",
  x: 0,
  y: 0,
  updatedAt: "2026-09-28T11:59:00.000Z",
};
const old = { label: "Old", x: 1, y: 1, updatedAt: "2026-08-01T00:00:00.000Z" };
const unknown = { label: "Unknown", x: 2, y: 2 };

describe("node styling", () => {
  it("fills a plain memory with its freshness color", () => {
    const result = nodeStyle(style({}), "a", fresh);
    expect(result.color).toBe("#08306b");
    expect(result.highlighted).toBe(false);
    expect(result.forceLabel).toBe(false);
    expect(result.label).toBe("Fresh");
  });

  it("keeps the freshness fill of a returned memory and forces its retrieval label", () => {
    const result = nodeStyle(
      style({ highlightIds: ["a"], kinds: { a: "match" } }),
      "a",
      old,
    );
    expect(result.color).toBe("#cfe3f3");
    expect(result.highlighted).toBe(true);
    expect(result.forceLabel).toBe(true);
    expect(result.label).toBe("Direct match — Old");
    expect(result.size).toBeGreaterThan(nodeStyle(style({}), "a", old).size);
  });

  it("labels a linked addition without a score and marks the selection", () => {
    const linked = nodeStyle(
      style({ highlightIds: ["a"], kinds: { a: "link" } }),
      "a",
      fresh,
    );
    expect(linked.label).toBe("Linked addition — Fresh");
    const selected = nodeStyle(style({ selectedId: "a" }), "a", fresh);
    expect(selected.label).toBe("Selected — Fresh");
    expect(selected.highlighted).toBe(true);
  });

  it("keeps unknown freshness neutral and visible", () => {
    const result = nodeStyle(style({}), "u", unknown);
    expect(result.color).toBe(unknownFreshnessColor);
  });

  it("dims memories the request did not return", () => {
    const returned = nodeStyle(style({ highlightIds: ["a"] }), "a", fresh);
    const unrelated = nodeStyle(style({ highlightIds: ["a"] }), "b", fresh);
    expect(returned.color).toBe("#08306b");
    expect(unrelated.color).not.toBe("#08306b");
    expect(unrelated.color).toContain("rgba(");
    expect(unrelated.size).toBeLessThan(returned.size);
  });

  it("dims memories outside the selection neighborhood in focused mode", () => {
    const focused = style({
      selectedId: "a",
      linkMode: "focused",
      near: ["a", "b"],
    });
    expect(nodeStyle(focused, "b", fresh).color).toBe("#08306b");
    expect(nodeStyle(focused, "c", fresh).color).toContain("rgba(");
  });
});

describe("link styling", () => {
  const link = { source: "a", target: "b" };

  it("emphasizes links between returned memories and dims the rest", () => {
    const source = style({ highlightIds: ["a", "b"] });
    expect(linkStyle(source, link).color).toContain("rgba(194");
    const unrelated = linkStyle(source, { source: "a", target: "c" });
    expect(unrelated.size).toBeLessThan(linkStyle(source, link).size);
  });

  it("hides every link that does not touch the selection in focused mode", () => {
    const focused = style({ selectedId: "a", linkMode: "focused" });
    expect(linkStyle(focused, link).hidden).toBe(false);
    expect(linkStyle(focused, link).color).toContain("rgba(15");
    expect(linkStyle(focused, { source: "b", target: "c" }).hidden).toBe(true);
  });

  it("shows all links in the all-links mode", () => {
    const all = style({ selectedId: "a", linkMode: "all" });
    expect(linkStyle(all, { source: "b", target: "c" }).hidden).toBe(false);
  });
});
