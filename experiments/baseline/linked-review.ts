/**
 * The bounded semantic review of linked additions: the operator's per-addition verdict — useful,
 * unrelated or unresolved — with its reason, validated against the captured retrieval records and
 * aggregated with assessed-sample denominators. Shared vocabulary alone is not a useful
 * relationship, and a linked addition is reported separately from direct recovery; no automatic
 * relevance judgement is made here.
 *
 * See docs/evaluation.md#retrieval-and-semantic-measures and
 * docs/evaluation.md#quality-maintenance-procedure.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { RetrievalRecord } from "../replay/artifacts.js";
import { sha256File } from "./io.js";
import { baselinePath } from "./layout.js";
import type { RetrievalBaseline } from "./retrieval.js";

/** The verdicts one reviewed linked addition can carry. */
export const linkedAdditionVerdicts = [
  "useful",
  "unrelated",
  "unresolved",
] as const;

/** One reviewed linked addition, identified by the query and the added note. */
export const linkedReviewEntrySchema = z.strictObject({
  queryId: z.string().min(1),
  noteId: z.string().min(1),
  verdict: z.enum(linkedAdditionVerdicts),
  reason: z.string().min(1),
});

/** The retained operator review; its hash binds it to the retrieval evidence it reviewed. */
export const linkedReviewSchema = z.strictObject({
  formatVersion: z.literal(1),
  reviewedAt: z.string().min(1),
  revision: z.string().min(1),
  retrievalSha256: z.string().min(1),
  entries: z.array(linkedReviewEntrySchema),
  limits: z.array(z.string().min(1)),
});

export type LinkedReview = z.infer<typeof linkedReviewSchema>;
export type LinkedReviewEntry = z.infer<typeof linkedReviewEntrySchema>;

/** A review that does not match the retrieval evidence it claims to cover. */
export class LinkedReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedReviewError";
  }
}

/** One linked addition beyond expected evidence, as the retrieval records captured it. */
export interface LinkedAddition {
  queryId: string;
  noteId: string;
  query: string;
  reason: string;
}

/** Every linked addition beyond expected evidence, in record order. */
export const linkedAdditionsFromRecords = (
  records: readonly RetrievalRecord[],
): LinkedAddition[] => {
  const expectedByQuery = new Map(
    records.map((record) => [
      record.queryId,
      new Set(record.requiredSourceIds),
    ]),
  );
  const additions: LinkedAddition[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const result of record.results) {
      if (result.origin !== "link") {
        continue;
      }
      if (
        expectedByQuery.get(record.queryId)?.has(result.sourceId ?? "") ??
        false
      ) {
        continue;
      }
      const key = `${record.queryId}\u0000${result.noteId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      additions.push({
        queryId: record.queryId,
        noteId: result.noteId,
        query: record.query,
        reason: record.rationale,
      });
    }
  }
  return additions;
};

/** Every linked addition beyond expected evidence in one retained retrieval baseline. */
export const linkedAdditionsBeyondExpected = (
  retrieval: RetrievalBaseline,
): LinkedAddition[] => linkedAdditionsFromRecords(retrieval.records);

/** The review's verdicts counted with the assessed sample and the addition total as denominators. */
export interface LinkedReviewSummary {
  reviewedAt: string;
  revision: string;
  retrievalSha256: string;
  assessed: number;
  denominator: number;
  unassessed: number;
  useful: number;
  unrelated: number;
  unresolved: number;
  limits: string[];
}

const keyOf = (queryId: string, noteId: string): string =>
  `${queryId}\u0000${noteId.toLowerCase()}`;

/**
 * Validate one review against the captured retrieval evidence and summarize its verdicts. Every
 * entry must name a real linked addition beyond expected evidence and no addition may be reviewed
 * twice; additions the review did not assess stay explicit as `unassessed` instead of counting as
 * useful or unrelated.
 */
export const summarizeLinkedReviewAgainst = (input: {
  additions: readonly LinkedAddition[];
  review: LinkedReview;
}): LinkedReviewSummary => {
  const known = new Set(
    input.additions.map((addition) => keyOf(addition.queryId, addition.noteId)),
  );
  const reviewed = new Set<string>();
  for (const entry of input.review.entries) {
    const key = keyOf(entry.queryId, entry.noteId);
    if (!known.has(key)) {
      throw new LinkedReviewError(
        `The linked review names ${entry.noteId} for query ${entry.queryId}, which is not a ` +
          "captured linked addition beyond expected evidence.",
      );
    }
    if (reviewed.has(key)) {
      throw new LinkedReviewError(
        `The linked review names ${entry.noteId} for query ${entry.queryId} more than once.`,
      );
    }
    reviewed.add(key);
  }
  const count = (verdict: (typeof linkedAdditionVerdicts)[number]): number =>
    input.review.entries.filter((entry) => entry.verdict === verdict).length;
  const assessed = input.review.entries.length;
  return {
    reviewedAt: input.review.reviewedAt,
    revision: input.review.revision,
    retrievalSha256: input.review.retrievalSha256,
    assessed,
    denominator: input.additions.length,
    unassessed: input.additions.length - assessed,
    useful: count("useful"),
    unrelated: count("unrelated"),
    unresolved: count("unresolved"),
    limits: input.review.limits,
  };
};

/** Summarize one review of the retained retrieval baseline's linked additions. */
export const summarizeLinkedReview = (input: {
  retrieval: RetrievalBaseline;
  review: LinkedReview;
}): LinkedReviewSummary =>
  summarizeLinkedReviewAgainst({
    additions: linkedAdditionsBeyondExpected(input.retrieval),
    review: input.review,
  });

/**
 * Read the retained linked-addition review and bind it to the retained retrieval evidence. A
 * review that does not exist yet yields null, so `metrics` reports the semantic review as
 * unmeasured instead of filling it with zeros.
 */
export const readLinkedReviewSummary = async (
  root: string,
): Promise<LinkedReviewSummary | null> => {
  const file = baselinePath(root, "linkedReview");
  let text: string;
  try {
    text = await readFile(file, "utf8");
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
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new LinkedReviewError(
      `The linked-addition review ${file} is not valid JSON.`,
    );
  }
  const review = linkedReviewSchema.safeParse(value);
  if (!review.success) {
    throw new LinkedReviewError(
      `The linked-addition review ${file} is invalid: ${review.error.issues
        .map((issue) =>
          issue.path.length === 0
            ? issue.message
            : `${issue.path.map(String).join(".")}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  }
  const retrievalFile = baselinePath(root, "retrieval");
  const retrievalSha256 = await sha256File(retrievalFile);
  if (review.data.retrievalSha256 !== retrievalSha256) {
    throw new LinkedReviewError(
      "The linked-addition review does not belong to the retained retrieval evidence; review " +
        "the retained linked additions again.",
    );
  }
  const retrieval = JSON.parse(
    await readFile(retrievalFile, "utf8"),
  ) as RetrievalBaseline;
  return summarizeLinkedReview({ retrieval, review: review.data });
};
