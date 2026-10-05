/**
 * Aggregate the retained baseline evidence into the numbers the quality comparison needs:
 * accepted observations, stored outcomes, failed attempts, direct retrieval recovery and linked
 * additions, each with its denominator. Missing evidence stays explicit instead of becoming a
 * zero; a metric that was never measured is reported as unavailable.
 *
 * See docs/evaluation.md#quality-change-acceptance and docs/evaluation.md#retrieval-and-semantic-measures.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { queueReceiptStatuses } from "../../src/index.js";
import { readRetainedBaseline } from "./evidence.js";
import { writeJsonFile } from "./io.js";
import { baselinePath } from "./layout.js";
import {
  readLinkedReviewSummary,
  type LinkedReviewSummary,
} from "./linked-review.js";
import { summarizeReceipts, type ReceiptAccounting } from "./receipts.js";
import {
  retrievalBaselineSummarySchema,
  type RetrievalBaselineSummary,
} from "./retrieval.js";

const failedEvidenceSchema = z.object({
  generatedAt: z.string().min(1),
  revision: z.string().min(1),
  rawFailedOutputs: z.object({
    available: z.boolean(),
    reason: z.string().min(1),
  }),
  diagnostics: z.array(
    z.object({
      diagnostic: z.string().min(1),
      count: z.int().nonnegative(),
      denominator: z.int().nonnegative(),
      sampleReceiptIds: z.array(z.string()),
    }),
  ),
  representatives: z.object({
    selected: z.array(
      z.object({ receiptId: z.string(), sourceKey: z.string() }),
    ),
    rationale: z.string().min(1),
    fixture: z.string().min(1),
  }),
  limits: z.array(z.string().min(1)),
});

const defectReportSchema = z.object({
  generatedAt: z.string().min(1),
  revision: z.string().min(1),
  runs: z.array(
    z.object({
      runId: z.string().min(1),
      status: z.string().min(1),
      fixtureMatches: z.boolean(),
      calls: z.object({
        total: z.int().nonnegative(),
        construct: z.int().nonnegative(),
        evolve: z.int().nonnegative(),
        outputFailures: z.int().nonnegative().optional(),
        transportFailures: z.int().nonnegative(),
        withRawResponse: z.int().nonnegative(),
        withCandidateIds: z.int().nonnegative(),
      }),
      outcomes: z.object({
        inserted: z.int().nonnegative(),
        failed: z.int().nonnegative(),
        stopped: z.int().nonnegative(),
        unattempted: z.int().nonnegative(),
        excluded: z.int().nonnegative(),
      }),
      findings: z.array(
        z.object({
          callId: z.int().nonnegative(),
          stage: z.string().min(1),
          outcome: z.string().min(1),
          categories: z.array(z.string()),
          issues: z.array(z.string()),
        }),
      ),
      failures: z.array(
        z.object({
          sourceId: z.string(),
          operation: z.string(),
          stage: z.string(),
          reason: z.string(),
        }),
      ),
    }),
  ),
  defects: z.array(
    z.object({
      category: z.string().min(1),
      issue: z.string().min(1),
      occurrences: z.int().nonnegative(),
      callIds: z.array(z.int().nonnegative()),
      sourceIds: z.array(z.string()),
    }),
  ),
  limits: z.array(z.string().min(1)),
});

const restoreReportCountsSchema = z.object({
  counts: z.object({
    acceptedReceipts: z.int().nonnegative(),
    storedReceipts: z.int().nonnegative(),
    failedReceipts: z.int().nonnegative(),
    pendingReceipts: z.int().nonnegative(),
    committedPlans: z.int().nonnegative(),
    restoredNotes: z.int().nonnegative(),
    matchedNotes: z.int().nonnegative(),
    unexplainedNotes: z.int().nonnegative(),
  }),
  checks: z.array(
    z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }),
  ),
});

const readOptionalJson = async (file: string): Promise<unknown | null> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      (cause as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw cause;
  }
};

/** The aggregated baseline numbers with explicit denominators. */
export interface BaselineMetrics {
  generatedAt: string;
  revision: string;
  baseline: {
    capturedAt: string;
    journalSha256: string;
    snapshotSha256: string;
    quiescent: boolean;
  };
  restore: {
    passed: boolean;
    storedReceipts: number;
    restoredNotes: number;
    matchedNotes: number;
    unexplainedNotes: number;
  } | null;
  ingestion: {
    acceptedObservations: { count: number; denominator: string };
    storedOutcomes: { count: number; denominator: string };
    failedOutcomes: { count: number; denominator: string };
    pendingOrBlocked: { count: number; denominator: string };
    attempts: {
      total: { count: number; denominator: string };
      byCurrentOutcome: Array<{
        status: string;
        claims: number;
        denominator: string;
      }>;
      receiptsWithMoreThanOneAttempt: { count: number; denominator: string };
      failedOutcomeClaims: { count: number; denominator: string };
      failureHistory: ReceiptAccounting["attempts"]["failureHistory"];
    };
    storedIdentity: ReceiptAccounting["storedIdentity"];
    failedDiagnostics: ReceiptAccounting["failedDiagnostics"];
    recovery: ReceiptAccounting["recoveryEvidence"];
  };
  retrieval: {
    representation: string;
    limits: { direct: number; linked: number };
    queries: RetrievalBaselineSummary["queries"];
    directRecovery: {
      firstResultRequired: RetrievalBaselineSummary["summaries"]["direct"]["firstResultRequired"];
      allRequiredDirectTopK: RetrievalBaselineSummary["summaries"]["direct"]["allRequiredDirectTopK"];
      allRequiredWithLinks: RetrievalBaselineSummary["summaries"]["linked"]["allRequiredWithLinks"];
      denominator: string;
    };
    linkedAdditions: RetrievalBaselineSummary["linkedAdditions"] & {
      returnedCharacters: RetrievalBaselineSummary["summaries"]["linked"]["returnedCharacters"];
      denominator: string;
      semanticReview: LinkedReviewSummary | null;
    };
  } | null;
  reproduction: {
    runs: number;
    runIds: string[];
    calls: {
      total: number;
      construct: number;
      evolve: number;
      outputFailures: number;
      transportFailures: number;
    };
    outcomes: { inserted: number; failed: number };
    defects: Array<{ category: string; occurrences: number; issue: string }>;
    missingRawFailedOutputs: boolean;
  } | null;
  limits: string[];
}

/**
 * Read every retained artifact and write the aggregated metrics. Evidence that a step did not
 * produce keeps its metric null with the reason in `limits`.
 */
export const aggregateMetrics = async (
  root: string,
  options: { now?: () => Date } = {},
): Promise<BaselineMetrics> => {
  const baseline = await readRetainedBaseline(root);
  const accounting = summarizeReceipts(baseline.receipts, {
    revision: baseline.manifest.revision,
  });
  const restore = await readOptionalJson(baselinePath(root, "restoreReport"));
  const retrieval = await readOptionalJson(baselinePath(root, "retrieval"));
  const defects = await readOptionalJson(baselinePath(root, "defects"));
  const failedEvidence = await readOptionalJson(
    baselinePath(root, "failedEvidence"),
  );

  const restoreValue =
    restore === null ? null : restoreReportCountsSchema.safeParse(restore);
  if (restore !== null && (restoreValue === null || !restoreValue.success)) {
    throw new Error(
      "The retained restore report is invalid; restore the baseline again.",
    );
  }
  const retrievalValue =
    retrieval === null
      ? null
      : retrievalBaselineSummarySchema.safeParse(retrieval);
  if (
    retrieval !== null &&
    (retrievalValue === null || !retrievalValue.success)
  ) {
    throw new Error("The retained retrieval baseline is invalid.");
  }
  const defectValue =
    defects === null ? null : defectReportSchema.safeParse(defects);
  if (defects !== null && (defectValue === null || !defectValue.success)) {
    throw new Error(
      "The retained defect report is invalid; classify the runs again.",
    );
  }
  const failedValue =
    failedEvidence === null
      ? null
      : failedEvidenceSchema.safeParse(failedEvidence);
  if (
    failedEvidence !== null &&
    (failedValue === null || !failedValue.success)
  ) {
    throw new Error(
      "The retained failure evidence is invalid; inspect the receipts again.",
    );
  }
  const linkedReview =
    retrievalValue !== null && retrievalValue.success
      ? await readLinkedReviewSummary(root)
      : null;

  const counts = accounting.statusCounts;
  const metrics: BaselineMetrics = {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    revision: baseline.manifest.revision,
    baseline: {
      capturedAt: baseline.manifest.capturedAt,
      journalSha256: baseline.manifest.journal.sha256,
      snapshotSha256: baseline.manifest.collection.sha256,
      quiescent: baseline.manifest.quiescent,
    },
    restore:
      restoreValue !== null && restoreValue.success
        ? {
            passed: restoreValue.data.checks.every((check) => check.ok),
            storedReceipts: restoreValue.data.counts.storedReceipts,
            restoredNotes: restoreValue.data.counts.restoredNotes,
            matchedNotes: restoreValue.data.counts.matchedNotes,
            unexplainedNotes: restoreValue.data.counts.unexplainedNotes,
          }
        : null,
    ingestion: {
      acceptedObservations: accounting.acceptedObservations,
      storedOutcomes: {
        count: counts.stored,
        denominator: `${String(accounting.acceptedObservations.count)} accepted observations`,
      },
      failedOutcomes: {
        count: counts.failed,
        denominator: `${String(accounting.acceptedObservations.count)} accepted observations`,
      },
      pendingOrBlocked: {
        count:
          counts.queued + counts.processing + counts.retrying + counts.blocked,
        denominator: `${String(accounting.acceptedObservations.count)} accepted observations`,
      },
      attempts: {
        total: {
          count: accounting.attempts.total,
          denominator: `${String(accounting.acceptedObservations.count)} accepted observations`,
        },
        byCurrentOutcome: queueReceiptStatuses.map((status) => ({
          status,
          claims: accounting.attempts.byCurrentOutcome[status],
          denominator: `${String(accounting.attempts.total)} cumulative attempts`,
        })),
        receiptsWithMoreThanOneAttempt: {
          count: accounting.attempts.receiptsWithMoreThanOneAttempt,
          denominator: `${String(accounting.acceptedObservations.count)} accepted observations`,
        },
        failedOutcomeClaims: {
          count: accounting.attempts.byCurrentOutcome.failed,
          denominator:
            `${String(accounting.attempts.total)} cumulative attempts; ` +
            `${String(counts.failed)} receipts currently failed`,
        },
        failureHistory: accounting.attempts.failureHistory,
      },
      storedIdentity: accounting.storedIdentity,
      failedDiagnostics: accounting.failedDiagnostics,
      recovery: accounting.recoveryEvidence,
    },
    retrieval:
      retrievalValue !== null && retrievalValue.success
        ? {
            representation: retrievalValue.data.representation,
            limits: retrievalValue.data.limits,
            queries: retrievalValue.data.queries,
            directRecovery: {
              firstResultRequired:
                retrievalValue.data.summaries.direct.firstResultRequired,
              allRequiredDirectTopK:
                retrievalValue.data.summaries.direct.allRequiredDirectTopK,
              allRequiredWithLinks:
                retrievalValue.data.summaries.linked.allRequiredWithLinks,
              denominator:
                "declared queries with expected evidence; the first-result and direct-top-K " +
                "recovered counts share that denominator",
            },
            linkedAdditions: {
              ...retrievalValue.data.linkedAdditions,
              returnedCharacters:
                retrievalValue.data.summaries.linked.returnedCharacters,
              denominator:
                "declared queries; additions beyond expected exclude the declared sources " +
                "reached through a link (linked-only recovery)",
              semanticReview: linkedReview,
            },
          }
        : null,
    reproduction:
      defectValue !== null && defectValue.success
        ? {
            runs: defectValue.data.runs.length,
            runIds: defectValue.data.runs.map((run) => run.runId),
            calls: defectValue.data.runs.reduce(
              (totals, run) => ({
                total: totals.total + run.calls.total,
                construct: totals.construct + run.calls.construct,
                evolve: totals.evolve + run.calls.evolve,
                outputFailures:
                  totals.outputFailures + (run.calls.outputFailures ?? 0),
                transportFailures:
                  totals.transportFailures + run.calls.transportFailures,
              }),
              {
                total: 0,
                construct: 0,
                evolve: 0,
                outputFailures: 0,
                transportFailures: 0,
              },
            ),
            outcomes: defectValue.data.runs.reduce(
              (totals, run) => ({
                inserted: totals.inserted + run.outcomes.inserted,
                failed: totals.failed + run.outcomes.failed,
              }),
              { inserted: 0, failed: 0 },
            ),
            defects: defectValue.data.defects.map((defect) => ({
              category: defect.category,
              occurrences: defect.occurrences,
              issue: defect.issue,
            })),
            missingRawFailedOutputs:
              failedValue !== null &&
              failedValue.success &&
              !failedValue.data.rawFailedOutputs.available,
          }
        : null,
    limits: [
      "Every count carries the denominator it was measured against; unavailable evidence stays " +
        "null or explicit instead of being filled with a zero.",
      ...(restoreValue === null || !restoreValue.success
        ? ["The isolated restore validation has not run yet."]
        : []),
      ...(retrievalValue === null || !retrievalValue.success
        ? ["The declared-query retrieval baseline has not run yet."]
        : []),
      ...(defectValue === null || !defectValue.success
        ? ["The representative reproduction runs have not been classified yet."]
        : []),
      ...(failedValue !== null && failedValue.success
        ? failedValue.data.limits
        : []),
      ...(defectValue !== null && defectValue.success
        ? defectValue.data.limits
        : []),
      ...(retrievalValue !== null && retrievalValue.success
        ? linkedReview === null
          ? [
              "The captured linked additions have no retained semantic review; unrelated and " +
                "useful additions stay unmeasured rather than zero.",
            ]
          : linkedReview.limits
        : []),
    ],
  };
  await writeJsonFile(baselinePath(root, "metrics"), metrics);
  return metrics;
};
