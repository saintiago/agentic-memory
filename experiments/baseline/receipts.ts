/**
 * Receipt accounting and failure evidence: how many accepted observations reached which outcome,
 * how many attempts the outcomes took, which safe diagnostics the failed receipts retained, and
 * which representative failures an isolated reproduction should replay.
 *
 * The revision that took this baseline retains no raw failed output: the journal keeps a safe
 * diagnostic, not the provider response. This module states that limit explicitly and selects
 * representative sources for an isolated, recorded reproduction instead of guessing at causes.
 *
 * See docs/evaluation.md#quality-maintenance-procedure.
 */
import path from "node:path";

import { z } from "zod";

import {
  queueReceiptStatuses,
  type QueueReceiptStatus,
} from "../../src/index.js";
import {
  sourceEntrySchema,
  validateFixture,
  type SourceEntry,
} from "../replay/fixture.js";
import {
  createEvidenceDirectory,
  sha256Text,
  writeJsonFile,
  writeJsonl,
} from "./io.js";
import { baselinePath } from "./layout.js";
import type { JournalCopyReceipt } from "./journal-copy.js";

/** Receipt counts by outcome, with the accepted total as the shared denominator. */
export interface ReceiptCounts {
  queued: number;
  processing: number;
  retrying: number;
  stored: number;
  failed: number;
  blocked: number;
}

export const countReceipts = (
  receipts: readonly JournalCopyReceipt[],
): ReceiptCounts => {
  const counts: ReceiptCounts = {
    queued: 0,
    processing: 0,
    retrying: 0,
    stored: 0,
    failed: 0,
    blocked: 0,
  };
  for (const receipt of receipts) {
    counts[receipt.status] += 1;
  }
  return counts;
};

/** One failed-outcome diagnostic with its count and the receipts it covers. */
export interface FailedDiagnostic {
  diagnostic: string;
  count: number;
  denominator: number;
  sampleReceiptIds: string[];
}

/** Receipt accounting over the retained journal copy. */
export interface ReceiptAccounting {
  revision: string;
  acceptedObservations: { count: number; denominator: string };
  statusCounts: ReceiptCounts;
  outcomes: Array<{
    status: QueueReceiptStatus;
    count: number;
    denominator: number;
  }>;
  attempts: {
    total: number;
    byStatus: Record<QueueReceiptStatus, number>;
    receiptsWithMoreThanOneAttempt: number;
  };
  failedDiagnostics: FailedDiagnostic[];
  storedIdentity: {
    withStoredAt: number;
    distinctNoteIds: number;
    denominator: number;
  };
  recoveryEvidence: {
    available: boolean;
    recoveredReceipts: number | null;
    reason: string;
  };
}

/** Summarize one retained receipt inventory for the baseline report. */
export const summarizeReceipts = (
  receipts: readonly JournalCopyReceipt[],
  options: { revision: string },
): ReceiptAccounting => {
  const statusCounts = countReceipts(receipts);
  const byStatus = Object.fromEntries(
    queueReceiptStatuses.map((status) => [
      status,
      receipts
        .filter((receipt) => receipt.status === status)
        .reduce((total, receipt) => total + receipt.attemptCount, 0),
    ]),
  ) as Record<QueueReceiptStatus, number>;
  const diagnostics = new Map<string, string[]>();
  for (const receipt of receipts) {
    if (receipt.status !== "failed" || receipt.lastError === undefined) {
      continue;
    }
    const ids = diagnostics.get(receipt.lastError) ?? [];
    ids.push(receipt.id);
    diagnostics.set(receipt.lastError, ids);
  }
  const stored = receipts.filter((receipt) => receipt.status === "stored");
  return {
    revision: options.revision,
    acceptedObservations: {
      count: receipts.length,
      denominator: "every receipt in the retained journal copy",
    },
    statusCounts,
    outcomes: queueReceiptStatuses.map((status) => ({
      status,
      count: statusCounts[status],
      denominator: receipts.length,
    })),
    attempts: {
      total: receipts.reduce(
        (total, receipt) => total + receipt.attemptCount,
        0,
      ),
      byStatus,
      receiptsWithMoreThanOneAttempt: receipts.filter(
        (receipt) => receipt.attemptCount > 1,
      ).length,
    },
    failedDiagnostics: [...diagnostics.entries()].map(
      ([diagnostic, receiptIds]) => ({
        diagnostic,
        count: receiptIds.length,
        denominator: statusCounts.failed,
        sampleReceiptIds: receiptIds.slice(0, 5),
      }),
    ),
    storedIdentity: {
      withStoredAt: stored.filter((receipt) => receipt.storedAt !== undefined)
        .length,
      distinctNoteIds: new Set(
        stored.map((receipt) => receipt.noteId.toLowerCase()),
      ).size,
      denominator: stored.length,
    },
    recoveryEvidence: {
      available: false,
      recoveredReceipts: null,
      reason:
        "The retained journal copy carries no receipt recovery evidence, so recovered receipts " +
        "cannot be distinguished from unrecovered ones and the recovered count stays unknown " +
        "rather than zero. Recovery evidence belongs to a later journal schema; this baseline " +
        "records accepted, stored and failed outcomes only.",
    },
  };
};

/** One selected failed receipt that a representative reproduction will replay in isolation. */
export const representativeFailureSchema = z.strictObject({
  receiptId: z.uuid(),
  sourceKey: z.string().min(1),
  diagnostic: z.string().min(1),
  contentBytes: z.int().nonnegative(),
  attemptCount: z.int().nonnegative(),
  acceptedAt: z.string().min(1),
});

export type RepresentativeFailure = z.infer<typeof representativeFailureSchema>;

/**
 * Select deterministic representatives from the retained failures: the most-repeated failure of
 * each diagnostic first, then the longest content among the remaining, alternating classes so
 * both the evolution-contract and unusable-output failures are represented when they exist. A
 * receipt that failed many times is the strongest available evidence that its input reproduces
 * the defect; content length only breaks ties.
 */
export const selectRepresentativeFailures = (
  receipts: readonly JournalCopyReceipt[],
  options: { perDiagnostic?: number; maxTotal?: number } = {},
): RepresentativeFailure[] => {
  const perDiagnostic = options.perDiagnostic ?? 3;
  const maxTotal = options.maxTotal ?? 8;
  const groups = new Map<string, JournalCopyReceipt[]>();
  for (const receipt of receipts) {
    if (receipt.status !== "failed" || receipt.lastError === undefined) {
      continue;
    }
    const group = groups.get(receipt.lastError) ?? [];
    group.push(receipt);
    groups.set(receipt.lastError, group);
  }
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        right.attemptCount - left.attemptCount ||
        right.content.length - left.content.length ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  }
  const queues = [...groups.values()].map((group) =>
    group.slice(0, perDiagnostic),
  );
  const selected: RepresentativeFailure[] = [];
  let index = 0;
  while (selected.length < maxTotal) {
    const queue = queues[index % queues.length];
    const next = queue?.shift();
    if (next === undefined) {
      index += 1;
      if (queues.every((candidate) => candidate.length === 0)) {
        break;
      }
      continue;
    }
    selected.push({
      receiptId: next.id,
      sourceKey: next.sourceKey,
      diagnostic: next.lastError ?? "",
      contentBytes: Buffer.byteLength(next.content, "utf8"),
      attemptCount: next.attemptCount,
      acceptedAt: next.acceptedAt,
    });
    index += 1;
  }
  return selected;
};

/** The explicit failed-output evidence limit this baseline retains. */
export interface FailedEvidence {
  generatedAt: string;
  revision: string;
  rawFailedOutputs: {
    available: boolean;
    reason: string;
  };
  diagnostics: FailedDiagnostic[];
  representatives: {
    selected: RepresentativeFailure[];
    rationale: string;
    fixture: string;
  };
  limits: string[];
}

/** The fixture one representative reproduction replays, and the paths that retain it. */
export interface ReproductionFixture {
  sourcesFile: string;
  queriesFile: string;
  sourcesHash: string;
  queryHash: string;
  sources: SourceEntry[];
}

/**
 * Write the representative failed observations as a replay fixture. Sources carry the receipt's
 * accepted identity, content, timestamp and provenance; an empty query list is deliberate, because
 * this run is evidence about ingestion responses, not retrieval.
 */
export const writeReproductionFixture = async (
  root: string,
  receipts: readonly JournalCopyReceipt[],
  selected: readonly RepresentativeFailure[],
): Promise<ReproductionFixture> => {
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const sources = selected.map((representative) => {
    const receipt = byId.get(representative.receiptId);
    if (receipt === undefined) {
      throw new Error(
        `The representative ${representative.receiptId} is not in the retained inventory.`,
      );
    }
    return sourceEntrySchema.parse({
      sourceId: receipt.id,
      content: receipt.content,
      timestamp: receipt.timestamp,
      ...(receipt.provenance === undefined
        ? {}
        : { metadata: receipt.provenance }),
    });
  });
  validateFixture(sources, []);
  const sourcesFile = baselinePath(root, "reproductionSources");
  const queriesFile = baselinePath(root, "reproductionQueries");
  await createEvidenceDirectory(path.dirname(sourcesFile));
  const sourcesText = sources
    .map((source) => `${JSON.stringify(source)}\n`)
    .join("");
  await writeJsonl(sourcesFile, sources);
  await writeJsonl(queriesFile, []);
  return {
    sourcesFile,
    queriesFile,
    sourcesHash: sha256Text(sourcesText),
    queryHash: sha256Text(""),
    sources,
  };
};

/** Write the explicit failure evidence, including the representative fixture reference. */
export const writeFailedEvidence = async (input: {
  root: string;
  revision: string;
  accounting: ReceiptAccounting;
  selected: readonly RepresentativeFailure[];
  fixture: ReproductionFixture;
  now: Date;
}): Promise<FailedEvidence> => {
  const evidence: FailedEvidence = {
    generatedAt: input.now.toISOString(),
    revision: input.revision,
    rawFailedOutputs: {
      available: false,
      reason:
        "The retained journal stores each failure's safe lastError diagnostic, not the provider " +
        "response, and the service retained no raw exchanges at this revision. Concrete " +
        "response defects therefore cannot be read from the live evidence; representative " +
        "sources are replayed in an isolated run with explicit recording instead.",
    },
    diagnostics: input.accounting.failedDiagnostics,
    representatives: {
      selected: [...input.selected],
      rationale:
        "The most-repeated failure of each diagnostic class first, then the longest remaining " +
        "content, alternating classes, replayed in one isolated recorded run. Repository guidance " +
        "prefers representative reproductions over inventing per-receipt causes.",
      fixture: input.fixture.sourcesFile,
    },
    limits: [
      "Representative reproductions are stochastic model runs; a run that does not fail does not " +
        "show that the original failure was not real.",
      "An isolated run does not reproduce the live corpus neighborhood of the original attempt; " +
        "candidate context is rebuilt from the selected sources.",
    ],
  };
  await writeJsonFile(baselinePath(input.root, "failedEvidence"), evidence);
  return evidence;
};
