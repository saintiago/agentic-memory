/**
 * The private baseline evidence layout: the relative paths every baseline command reads and
 * writes under one evidence root. Keeping the names here means the capture, restore, reproduction
 * and metrics steps agree on one layout instead of repeating file names.
 *
 * See docs/evaluation.md#quality-maintenance-procedure.
 */
import path from "node:path";

/** Relative paths under one baseline evidence root. */
export const baselineLayout = {
  /** The consistent journal copy and collection snapshot, with their manifest. */
  manifest: "baseline/manifest.json",
  journal: "baseline/journal.sqlite",
  snapshot: "baseline/collection.snapshot",
  receipts: "baseline/receipts.jsonl",
  /** The declared queries and expected evidence, fixed before any query runs. */
  queries: "baseline/queries.jsonl",
  /** The isolated restore of the captured pair. */
  restoreJournal: "restore/journal.sqlite",
  restoreReport: "restore-report.json",
  /** Receipt accounting and the explicit failed-output evidence limit. */
  accounting: "accounting.json",
  failedEvidence: "failed-evidence.json",
  /** Representative reproductions and their recorded response defects. */
  reproductionSources: "reproduction/sources.jsonl",
  reproductionQueries: "reproduction/queries.jsonl",
  defects: "reproduction/defects.json",
  /** Live reproduction run directories and the baseline retrieval evidence. */
  runs: "runs",
  retrieval: "retrieval.json",
  /** The operator's bounded semantic review of the linked additions beyond expected evidence. */
  linkedReview: "linked-additions-review.json",
  /** The matched isolated before/after comparison of two reproduction runs. */
  matchedComparison: "matched-comparison.json",
  /** The aggregated numbers with their denominators. */
  metrics: "baseline-metrics.json",
} as const;

export type BaselineArtifact = keyof typeof baselineLayout;

/** The capture directory itself, created once under the evidence root. */
export const baselineDirectory = (root: string): string =>
  path.join(root, "baseline");

/** Resolve one layout entry under an evidence root. */
export const baselinePath = (
  root: string,
  artifact: BaselineArtifact,
): string => path.join(root, baselineLayout[artifact]);
