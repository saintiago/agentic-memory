import { describe, expect, it } from "vitest";

import type {
  CostRates,
  RetrievalRecord,
} from "../../experiments/replay/artifacts.js";
import {
  computeCost,
  percentile,
  summarizeMode,
  summarizeTimings,
  summarizeUsage,
} from "../../experiments/replay/measures.js";
import type { RecorderSummary } from "../../experiments/replay/recorder.js";

/**
 * The measurement rules of the report: denominators, separately counted link recovery, the
 * declared character serialization and the documented cost formula.
 *
 * See docs/evaluation.md#retrieval-and-semantic-measures and docs/evaluation.md#performance-and-cost.
 */

const RATES: CostRates = {
  currency: "USD",
  effectiveDate: "2026-09-01",
  uncachedInputPerMillion: 1,
  cachedInputPerMillion: 0.5,
  outputPerMillion: 2,
};

const record = (
  overrides: {
    queryId?: string;
    requiredSourceIds?: string[];
    direct?: Array<[string, number]>;
    linked?: string[];
    latencyMs?: number;
  } = {},
): RetrievalRecord => {
  const required = overrides.requiredSourceIds ?? ["source-a"];
  const direct = overrides.direct ?? [["source-a", 0.9]];
  const linked = overrides.linked ?? [];
  const results = [
    ...direct.map(([sourceId, score]) => ({
      noteId: `note-${sourceId}`,
      sourceId,
      origin: "match" as const,
      score,
      characters: { content: 10, attributes: 20, total: 30 },
    })),
    ...linked.map((sourceId) => ({
      noteId: `note-${sourceId}`,
      sourceId,
      origin: "link" as const,
      score: null,
      characters: { content: 5, attributes: 15, total: 20 },
    })),
  ];
  const directSourceIds = new Set(direct.map(([sourceId]) => sourceId));
  const linkedSourceIds = new Set(linked);
  return {
    mode: "evolved-linked",
    representation: "amem-note-v1",
    collection: "memory:runtime",
    queryId: overrides.queryId ?? "query",
    query: "a query",
    scope: null,
    rationale: "a rationale",
    requiredSourceIds: required,
    limits: { direct: 5, linked: 5 },
    latencyMs: overrides.latencyMs ?? 10,
    results,
    recovery: {
      firstResultRequired:
        results[0]?.origin === "match" &&
        results[0].sourceId !== null &&
        required.includes(results[0].sourceId),
      directRequired: required.filter((id) => directSourceIds.has(id)),
      linkedOnlyRequired: required.filter(
        (id) => !directSourceIds.has(id) && linkedSourceIds.has(id),
      ),
      missingRequired: required.filter(
        (id) => !directSourceIds.has(id) && !linkedSourceIds.has(id),
      ),
    },
  };
};

describe("latency summaries", () => {
  it("uses nearest-rank percentiles and reports the sample count", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBeNull();
    expect(summarizeTimings([5, 1, 3, 2, 4])).toEqual({
      samples: 5,
      medianMs: 3,
      p95Ms: 5,
      minMs: 1,
      maxMs: 5,
    });
    expect(summarizeTimings([])).toEqual({
      samples: 0,
      medianMs: null,
      p95Ms: null,
      minMs: null,
      maxMs: null,
    });
  });
});

describe("comparison mode summary", () => {
  it("counts first-result hits, direct recovery and link-only recovery separately", () => {
    const summary = summarizeMode("amem-note-v1", [
      record({
        queryId: "q1",
        requiredSourceIds: ["source-a", "source-b"],
        direct: [["source-a", 0.9]],
        linked: ["source-b"],
      }),
      record({
        queryId: "q2",
        requiredSourceIds: ["source-c"],
        direct: [["source-x", 0.9]],
        linked: [],
      }),
      record({
        queryId: "q3",
        requiredSourceIds: ["source-a"],
        direct: [
          ["source-x", 0.8],
          ["source-a", 0.7],
        ],
      }),
    ]);
    expect(summary).toMatchObject({
      queries: 3,
      queriesWithExpectations: 3,
      firstResultRequired: { recovered: 1, denominator: 3 },
      allRequiredDirectTopK: { recovered: 1, denominator: 3 },
      allRequiredWithLinks: { recovered: 2, denominator: 3 },
      linkRecoveredQueries: 1,
      linkRecoveredSources: 1,
      multiSourceQueries: 1,
      returnedNotes: 5,
      returnedCharacters: { direct: 120, linked: 20, total: 140 },
    });
  });

  it("keeps queries without expectations out of the recovery denominators", () => {
    const summary = summarizeMode("amem-note-v1", [
      record({ queryId: "q1", requiredSourceIds: [] }),
    ]);
    expect(summary).toMatchObject({
      queries: 1,
      queriesWithExpectations: 0,
      firstResultRequired: { recovered: 0, denominator: 0 },
      allRequiredDirectTopK: { recovered: 0, denominator: 0 },
    });
  });
});

describe("cost", () => {
  it("subtracts reported cache hits before the uncached term", () => {
    expect(
      computeCost(
        { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 100 },
        RATES,
      ),
    ).toBeCloseTo((800 * 1 + 200 * 0.5 + 100 * 2) / 1_000_000, 12);
  });

  it("treats unreported cache hits as uncached input", () => {
    expect(
      computeCost(
        { inputTokens: 1_000, cachedInputTokens: null, outputTokens: 0 },
        RATES,
      ),
    ).toBeCloseTo(1_000 / 1_000_000, 12);
  });

  it("stays unknown without input or output usage", () => {
    expect(
      computeCost(
        { inputTokens: null, cachedInputTokens: 10, outputTokens: 10 },
        RATES,
      ),
    ).toBeNull();
    expect(
      computeCost(
        { inputTokens: 10, cachedInputTokens: 0, outputTokens: null },
        RATES,
      ),
    ).toBeNull();
  });
});

describe("usage summary", () => {
  const summary = (
    overrides: Partial<RecorderSummary["calls"]> = {},
    usage: Partial<RecorderSummary["usage"]> = {},
  ): RecorderSummary => ({
    calls: {
      construct: 1,
      evolve: 0,
      total: 1,
      failed: 0,
      withUsage: 1,
      ...overrides,
    },
    usage: {
      known: true,
      uncachedInputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      ...usage,
    },
    insertionDurations: [],
    callDurations: { construct: [], evolve: [] },
    embeddingDurations: { insertion: [], materialization: [], evaluation: [] },
    storeDurations: {
      insertion: { put: [], nearest: [], get: [] },
      evaluation: { put: [], nearest: [], get: [] },
    },
  });

  it("reports totals only when usage is known for every call", () => {
    expect(summarizeUsage(summary())).toMatchObject({
      known: true,
      uncachedInputTokens: 10,
      outputTokens: 5,
    });
    expect(
      summarizeUsage(summary({ failed: 1 }, { known: false })),
    ).toMatchObject({ known: false, uncachedInputTokens: null });
    expect(summarizeUsage(summary({ total: 0, construct: 0 }))).toMatchObject({
      known: false,
    });
  });
});
