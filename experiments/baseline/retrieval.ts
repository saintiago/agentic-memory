/**
 * The declared-query retrieval baseline: run every declared question against the restored
 * collection twice — direct matches only, then the same direct limit with the declared nonzero
 * linked budget — and record the complete ordered results, origin classification, returned
 * characters and recovery flags. Direct recovery and linked additions keep separate counts with
 * their denominators.
 *
 * See docs/evaluation.md#retrieval-and-semantic-measures.
 */
import { z } from "zod";

import {
  AgenticMemory,
  embeddingText,
  openQdrantNoteStore,
  openReferenceEmbedder,
  type LanguageModel,
  type Note,
  type SearchResult,
} from "../../src/index.js";
import type {
  ModeSummary,
  RetrievalRecord,
  RetrievalResultRecord,
} from "../replay/artifacts.js";
import { summarizeMode } from "../replay/measures.js";
import { readRetainedBaseline } from "./evidence.js";
import { writeJsonFile } from "./io.js";
import { baselinePath } from "./layout.js";
import { collectionInfo, type QdrantTarget } from "./qdrant-snapshots.js";
import { readRestoreReport } from "./restore.js";

/** The retrieval baseline evidence written for the later before/after comparison. */
export interface RetrievalBaseline {
  generatedAt: string;
  revision: string;
  isolatedCollection: string;
  representation: string;
  limits: { direct: number; linked: number };
  queries: {
    declared: number;
    withExpectedEvidence: number;
    exact: number;
    replacement: number;
    uncovered: number;
  };
  summaries: { direct: ModeSummary; linked: ModeSummary };
  linkedAdditions: {
    count: number;
    characters: number;
    queriesWithAdditions: number;
    additionsBeyondExpected: { count: number; characters: number };
    linkedOnlyRecoveredSources: number;
  };
  records: RetrievalRecord[];
  limitsNotes: string[];
}

export interface RetrievalOptions {
  root: string;
  qdrant: QdrantTarget;
  embeddingCacheDir: string;
  allowEmbeddingDownloads?: boolean;
  directLimit?: number;
  linkedLimit?: number;
  now?: () => Date;
}

const unusedModel: LanguageModel = {
  async generate(): Promise<unknown> {
    throw new Error("Retrieval makes no model call.");
  },
};

const resultCharacters = (note: Note): RetrievalResultRecord["characters"] => {
  const total = embeddingText(note).length;
  return {
    content: note.content.length,
    attributes: total - note.content.length,
    total,
  };
};

const unique = (values: readonly string[]): Set<string> => new Set(values);

const retrievalRecord = (input: {
  mode: string;
  representation: string;
  collection: string;
  queryId: string;
  query: string;
  scope: string | null;
  rationale: string;
  requiredNoteIds: readonly string[];
  directLimit: number;
  linkedLimit: number;
  latencyMs: number;
  results: readonly SearchResult[];
}): RetrievalRecord => {
  const results: RetrievalResultRecord[] = input.results.map((result) => ({
    noteId: result.note.id,
    sourceId: result.note.id,
    origin: result.via,
    score: result.via === "match" ? result.score : null,
    note: structuredClone(result.note),
    characters: resultCharacters(result.note),
  }));
  const directIds = unique(
    results
      .filter((result) => result.origin === "match")
      .map((result) => result.noteId),
  );
  const linkedIds = unique(
    results
      .filter((result) => result.origin === "link")
      .map((result) => result.noteId),
  );
  const required = input.requiredNoteIds;
  const first = results[0];
  return {
    mode: input.mode,
    representation: input.representation,
    collection: input.collection,
    queryId: input.queryId,
    query: input.query,
    scope: input.scope,
    rationale: input.rationale,
    requiredSourceIds: [...required],
    limits: { direct: input.directLimit, linked: input.linkedLimit },
    latencyMs: input.latencyMs,
    results,
    recovery: {
      firstResultRequired:
        first !== undefined &&
        first.origin === "match" &&
        first.noteId !== undefined &&
        required.includes(first.noteId),
      directRequired: required.filter((id) => directIds.has(id)),
      linkedOnlyRequired: required.filter(
        (id) => !directIds.has(id) && linkedIds.has(id),
      ),
      missingRequired: required.filter(
        (id) => !directIds.has(id) && !linkedIds.has(id),
      ),
    },
  };
};

/** Run the declared queries against the restored baseline collection. */
export const runDeclaredRetrieval = async (
  options: RetrievalOptions,
): Promise<RetrievalBaseline> => {
  const now = options.now ?? (() => new Date());
  const baseline = await readRetainedBaseline(options.root);
  const restore = await readRestoreReport(options.root);
  const directLimit = options.directLimit ?? 3;
  const linkedLimit = options.linkedLimit ?? 3;
  if (!Number.isSafeInteger(directLimit) || directLimit <= 0) {
    throw new Error("The direct limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(linkedLimit) || linkedLimit < 0) {
    throw new Error("The linked limit must be a nonnegative safe integer.");
  }
  // A deleted isolated collection would otherwise be silently recreated empty and the baseline
  // would record zero recovery as if it were quality evidence.
  const observed = await collectionInfo(
    options.qdrant,
    restore.isolatedCollection,
  );
  if (observed === undefined) {
    throw new Error(
      `The restored collection ${restore.isolatedCollection} no longer exists; restore the ` +
        "baseline before running the declared queries.",
    );
  }
  if (observed.points_count !== restore.counts.restoredNotes) {
    throw new Error(
      `The restored collection ${restore.isolatedCollection} holds ` +
        `${String(observed.points_count)} points, not the ` +
        `${String(restore.counts.restoredNotes)} notes in the restore report; restore the ` +
        "baseline again.",
    );
  }

  const embedder = await openReferenceEmbedder({
    cacheDir: options.embeddingCacheDir,
    allowDownloads: options.allowEmbeddingDownloads ?? false,
  });
  const store = await openQdrantNoteStore({
    url: options.qdrant.url,
    collection: restore.isolatedCollection,
    space: embedder.space,
    ...(options.qdrant.apiKey === undefined
      ? {}
      : { apiKey: options.qdrant.apiKey }),
    ...(options.qdrant.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.qdrant.timeoutMs }),
  });
  const memory = new AgenticMemory(store, embedder, unusedModel);
  const representation = baseline.journal.representation;
  const records: RetrievalRecord[] = [];
  for (const query of baseline.queries) {
    const directStarted = performance.now();
    const direct = await memory.search(query.query, {
      limit: directLimit,
      linkedLimit: 0,
    });
    records.push(
      retrievalRecord({
        mode: "evolved-direct",
        representation,
        collection: restore.isolatedCollection,
        queryId: query.id,
        query: query.query,
        scope: query.scope ?? null,
        rationale: query.rationale,
        requiredNoteIds: query.expectedNoteIds,
        directLimit,
        linkedLimit: 0,
        latencyMs: performance.now() - directStarted,
        results: direct,
      }),
    );
    const linkedStarted = performance.now();
    const linked = await memory.search(query.query, {
      limit: directLimit,
      linkedLimit,
    });
    records.push(
      retrievalRecord({
        mode: "evolved-linked",
        representation,
        collection: restore.isolatedCollection,
        queryId: query.id,
        query: query.query,
        scope: query.scope ?? null,
        rationale: query.rationale,
        requiredNoteIds: query.expectedNoteIds,
        directLimit,
        linkedLimit,
        latencyMs: performance.now() - linkedStarted,
        results: linked,
      }),
    );
  }
  const directRecords = records.filter(
    (record) => record.mode === "evolved-direct",
  );
  const linkedRecords = records.filter(
    (record) => record.mode === "evolved-linked",
  );
  const linkedResults = linkedRecords.flatMap((record) =>
    record.results.filter((result) => result.origin === "link"),
  );
  const expectedByQuery = new Map(
    baseline.queries.map((query) => [query.id, new Set(query.expectedNoteIds)]),
  );
  const beyondExpected = linkedRecords.flatMap((record) =>
    record.results.filter(
      (result) =>
        result.origin === "link" &&
        !(expectedByQuery.get(record.queryId)?.has(result.noteId) ?? false),
    ),
  );
  const baselineEvidence: RetrievalBaseline = {
    generatedAt: now().toISOString(),
    revision: baseline.manifest.revision,
    isolatedCollection: restore.isolatedCollection,
    representation,
    limits: { direct: directLimit, linked: linkedLimit },
    queries: {
      declared: baseline.queries.length,
      withExpectedEvidence: baseline.queries.filter(
        (query) => query.expectedNoteIds.length > 0,
      ).length,
      exact: baseline.queries.filter((query) => query.wording === "exact")
        .length,
      replacement: baseline.queries.filter(
        (query) => query.wording === "replacement",
      ).length,
      uncovered: baseline.queries.filter(
        (query) => query.expectedNoteIds.length === 0,
      ).length,
    },
    summaries: {
      direct: summarizeMode("evolved-direct", directRecords),
      linked: summarizeMode("evolved-linked", linkedRecords),
    },
    linkedAdditions: {
      count: linkedResults.length,
      characters: linkedResults.reduce(
        (total, result) => total + result.characters.total,
        0,
      ),
      queriesWithAdditions: linkedRecords.filter((record) =>
        record.results.some((result) => result.origin === "link"),
      ).length,
      additionsBeyondExpected: {
        count: beyondExpected.length,
        characters: beyondExpected.reduce(
          (total, result) => total + result.characters.total,
          0,
        ),
      },
      linkedOnlyRecoveredSources: linkedRecords.reduce(
        (total, record) => total + record.recovery.linkedOnlyRequired.length,
        0,
      ),
    },
    records,
    limitsNotes: [
      "Direct recovery counts declared expected note IDs found in the direct matches; the " +
        "denominator is the declared queries with expected evidence.",
      "Linked additions are unusable to judge by count alone: a linked-only declared source is " +
        "recovery, and a link across scopes may still carry useful attributed evidence. The " +
        "records keep every returned note for the manual semantic review.",
      "The query is embedded and searched locally against the restored snapshot; no model call " +
        "and no live-corpus read is involved.",
    ],
  };
  await writeJsonFile(
    baselinePath(options.root, "retrieval"),
    baselineEvidence,
  );
  return baselineEvidence;
};

/** Timing summary shape of one aggregated mode, mirrored here for read-back validation. */
export const modeSummarySchema = z.object({
  representation: z.string(),
  queries: z.int().nonnegative(),
  queriesWithExpectations: z.int().nonnegative(),
  firstResultRequired: z.object({
    recovered: z.int().nonnegative(),
    denominator: z.int().nonnegative(),
  }),
  allRequiredDirectTopK: z.object({
    recovered: z.int().nonnegative(),
    denominator: z.int().nonnegative(),
  }),
  allRequiredWithLinks: z.object({
    recovered: z.int().nonnegative(),
    denominator: z.int().nonnegative(),
  }),
  linkRecoveredQueries: z.int().nonnegative(),
  linkRecoveredSources: z.int().nonnegative(),
  multiSourceQueries: z.int().nonnegative(),
  returnedNotes: z.int().nonnegative(),
  returnedCharacters: z.object({
    direct: z.int().nonnegative(),
    linked: z.int().nonnegative(),
    total: z.int().nonnegative(),
  }),
  latency: z.object({
    samples: z.int().nonnegative(),
    medianMs: z.number().nullable(),
    p95Ms: z.number().nullable(),
    minMs: z.number().nullable(),
    maxMs: z.number().nullable(),
  }),
});

/** The retrieval-baseline fields later steps read back; unknown evidence fields are ignored. */
export const retrievalBaselineSummarySchema = z.object({
  generatedAt: z.string().min(1),
  revision: z.string().min(1),
  isolatedCollection: z.string().min(1),
  representation: z.string().min(1),
  limits: z.object({
    direct: z.int().nonnegative(),
    linked: z.int().nonnegative(),
  }),
  queries: z.object({
    declared: z.int().nonnegative(),
    withExpectedEvidence: z.int().nonnegative(),
    exact: z.int().nonnegative(),
    replacement: z.int().nonnegative(),
    uncovered: z.int().nonnegative(),
  }),
  summaries: z.object({
    direct: modeSummarySchema,
    linked: modeSummarySchema,
  }),
  linkedAdditions: z.object({
    count: z.int().nonnegative(),
    characters: z.int().nonnegative(),
    queriesWithAdditions: z.int().nonnegative(),
    additionsBeyondExpected: z.object({
      count: z.int().nonnegative(),
      characters: z.int().nonnegative(),
    }),
    linkedOnlyRecoveredSources: z.int().nonnegative(),
  }),
});

export type RetrievalBaselineSummary = z.infer<
  typeof retrievalBaselineSummarySchema
>;
