/**
 * Measurement arithmetic for the report: source recovery with explicit denominators, returned text
 * size under the declared serialization, latency summaries with sample counts and the documented
 * token-cost formula. No timing threshold is a correctness rule.
 *
 * See docs/evaluation.md#retrieval-and-semantic-measures and docs/evaluation.md#performance-and-cost.
 */
import type {
  CostRates,
  ModeSummary,
  RetrievalRecord,
  SampleSummary,
  TimingSummary,
  TokenUsage,
  UsageSummary,
} from "./artifacts.js";
import type { RecorderSummary } from "./recorder.js";

const sorted = (samples: readonly number[]): number[] =>
  [...samples].sort((left, right) => left - right);

/**
 * Nearest-rank percentile: the smallest sample at or above the requested fraction. The sample count
 * travels with every summary, because a p95 over few samples is weak evidence.
 */
export const percentile = (
  samples: readonly number[],
  fraction: number,
): number | null => {
  if (samples.length === 0) {
    return null;
  }
  const values = sorted(samples);
  const rank = Math.ceil(fraction * values.length) - 1;
  const index = Math.min(Math.max(rank, 0), values.length - 1);
  return values[index] ?? null;
};

/** Median, p95, minimum and maximum with the sample count they came from. */
export const summarizeTimings = (
  samples: readonly number[],
): TimingSummary => ({
  samples: samples.length,
  medianMs: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  minMs: percentile(samples, 0),
  maxMs: percentile(samples, 1),
});

/** Summarize a measured count or length with its sample count and total. */
export const summarizeSamples = (
  samples: readonly number[],
): SampleSummary => ({
  samples: samples.length,
  total: samples.reduce((total, value) => total + value, 0),
  median: percentile(samples, 0.5),
  max: percentile(samples, 1),
});

/** Aggregate one comparison mode from its per-query records. */
export const summarizeMode = (
  representation: string,
  records: readonly RetrievalRecord[],
): ModeSummary => {
  const withExpectations = records.filter(
    (record) => record.requiredSourceIds.length > 0,
  );
  const count = (predicate: (record: RetrievalRecord) => boolean): number =>
    withExpectations.filter(predicate).length;
  const allRequiredInDirect = (record: RetrievalRecord): boolean =>
    record.recovery.directRequired.length === record.requiredSourceIds.length;
  const allRequiredWithLinks = (record: RetrievalRecord): boolean =>
    record.recovery.missingRequired.length === 0;
  const characters = records
    .flatMap((record) => record.results)
    .reduce(
      (totals, result) => {
        if (result.origin === "match") {
          totals.direct += result.characters.total;
        } else {
          totals.linked += result.characters.total;
        }
        totals.total += result.characters.total;
        return totals;
      },
      { direct: 0, linked: 0, total: 0 },
    );
  return {
    representation,
    queries: records.length,
    queriesWithExpectations: withExpectations.length,
    firstResultRequired: {
      recovered: count((record) => record.recovery.firstResultRequired),
      denominator: withExpectations.length,
    },
    allRequiredDirectTopK: {
      recovered: count(allRequiredInDirect),
      denominator: withExpectations.length,
    },
    allRequiredWithLinks: {
      recovered: count(allRequiredWithLinks),
      denominator: withExpectations.length,
    },
    linkRecoveredQueries: count(
      (record) => record.recovery.linkedOnlyRequired.length > 0,
    ),
    linkRecoveredSources: withExpectations.reduce(
      (total, record) => total + record.recovery.linkedOnlyRequired.length,
      0,
    ),
    multiSourceQueries: withExpectations.filter(
      (record) => record.requiredSourceIds.length > 1,
    ).length,
    returnedNotes: records.reduce(
      (total, record) => total + record.results.length,
      0,
    ),
    returnedCharacters: characters,
    latency: summarizeTimings(records.map((record) => record.latencyMs)),
  };
};

/** The documented cost formula's outcome: an exact cost, or only the bound left by an unknown split. */
export interface CostResult {
  /** The exact documented cost, when input, output and cache hits are all reported. */
  exact: number | null;
  /** The highest cost consistent with reported usage; null unless cache hits are unknown. */
  upperBound: number | null;
}

/**
 * The documented cost formula, with per-million rates supplied by the run. A provider that reports
 * total input including cache hits has the cached tokens subtracted before the uncached term. When
 * input or output usage is missing the cost stays unknown; when only the cache split is missing, a
 * maximum-input-rate bound is reported separately instead of presenting an estimate as measured.
 */
export const computeCost = (
  usage: TokenUsage,
  rates: CostRates,
): CostResult => {
  const { inputTokens, outputTokens, cachedInputTokens } = usage;
  if (inputTokens === null || outputTokens === null) {
    return { exact: null, upperBound: null };
  }
  const outputCost = outputTokens * rates.outputPerMillion;
  if (cachedInputTokens === null) {
    if (rates.cachedInputPerMillion === rates.uncachedInputPerMillion) {
      // The cache split does not change the cost, so reported input tokens are enough.
      return {
        exact:
          (inputTokens * rates.uncachedInputPerMillion + outputCost) /
          1_000_000,
        upperBound: null,
      };
    }
    return {
      exact: null,
      upperBound:
        (inputTokens *
          Math.max(rates.uncachedInputPerMillion, rates.cachedInputPerMillion) +
          outputCost) /
        1_000_000,
    };
  }
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  return {
    exact:
      (uncachedInput * rates.uncachedInputPerMillion +
        cachedInputTokens * rates.cachedInputPerMillion +
        outputCost) /
      1_000_000,
    upperBound: null,
  };
};

/** Fold the recorder's per-call usage into run totals; missing usage leaves them unknown. */
export const summarizeUsage = (summary: RecorderSummary): UsageSummary => {
  const known = summary.usage.known && summary.calls.total > 0;
  const cachedKnown = known && summary.usage.cachedKnown;
  const inputTokens = known ? summary.usage.inputTokens : null;
  return {
    known,
    calls: {
      total: summary.calls.total,
      failed: summary.calls.failed,
      withUsage: summary.calls.withUsage,
    },
    inputTokens,
    cachedInputTokens: cachedKnown ? summary.usage.cachedInputTokens : null,
    uncachedInputTokens:
      cachedKnown && inputTokens !== null
        ? Math.max(0, inputTokens - summary.usage.cachedInputTokens)
        : null,
    outputTokens: known ? summary.usage.outputTokens : null,
  };
};
