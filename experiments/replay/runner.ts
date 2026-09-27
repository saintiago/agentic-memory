/**
 * The replay runner: validate a fixture, insert its sources through the public Memory contract
 * while recording the run artifacts, verify the persisted notes through public reads, evaluate the
 * documented comparison modes and write the measurement report. A fresh run uses fresh isolated
 * collections and never overwrites an earlier run directory.
 *
 * See docs/evaluation.md.
 */
import os from "node:os";

import {
  AgenticMemory,
  defaultPrompts,
  embeddingText,
  MemoryError,
  readConstructionResponse,
  type Cursor,
  type EmbeddedNote,
  type JsonValue,
  type MemoryPrompts,
  type Note,
} from "../../src/index.js";
import {
  RunArtifacts,
  runArtifactFiles,
  type ChangeRecord,
  type ConstructionRecord,
  type CostRates,
  type FinalNoteRecord,
  type ModeSummary,
  type RetrievalRecord,
  type RunCheck,
  type RunManifest,
  type RunReport,
  type SemanticReviewEntry,
  type SourceRecord,
  type TokenUsage,
} from "./artifacts.js";
import {
  comparisonModes,
  evaluateRetrieval,
  runtimeRepresentation,
  type ComparisonMode,
  type RetrievalRun,
} from "./comparison.js";
import type { EvaluationEnvironment } from "./environment.js";
import {
  FixtureError,
  toAddInput,
  validateFixture,
  type QueryCase,
  type SourceEntry,
} from "./fixture.js";
import {
  computeCost,
  percentile,
  summarizeMode,
  summarizeTimings,
  summarizeUsage,
} from "./measures.js";
import {
  BudgetExhaustedError,
  instrumentEmbedder,
  instrumentModel,
  instrumentStore,
  ReplayRecorder,
  type ModelBudget,
} from "./recorder.js";

/** A constructed note and the vector the run captured for its first representation. */
interface ConstructedNote {
  sourceId: string;
  note: Note;
  vector: number[];
}

/** Everything one replay needs beyond its fixture. */
export interface ReplayRunOptions {
  runId: string;
  /** The code revision recorded in the manifest; the caller supplies it. */
  revision: string;
  /** The directory that holds one subdirectory per run; it is created when missing. */
  runsDirectory: string;
  sources: readonly SourceEntry[];
  queries: readonly QueryCase[];
  /** Hashes of the fixture files, computed from the exact text the caller read. */
  sourceHash: string;
  queryHash: string;
  environment: EvaluationEnvironment;
  prompts?: Partial<MemoryPrompts>;
  /** Candidates considered per insertion; the documented default is 5. */
  neighbors?: number;
  /** Direct matches per query; the documented default is 5. */
  directLimit?: number;
  /** Linked additions for the linked mode; the documented default is 5. */
  linkedLimit?: number;
  /** Record complete prompts and raw provider bodies; off by default for private material. */
  recordRawExchanges?: boolean;
  /** A declared call/token budget; a live run stops instead of overspending. */
  budget?: ModelBudget | null;
  /** Per-million-token rates with currency and effective date, or `null` when unknown. */
  costRates?: CostRates | null;
  /** Manual semantic review findings recorded with the run. */
  semanticReview?: readonly SemanticReviewEntry[];
  /** Fixture sources deliberately kept out of insertion, recorded as input exclusions. */
  excludeSources?: readonly string[];
  /** Fixture queries deliberately not evaluated, recorded as input exclusions. */
  excludeQueries?: readonly string[];
  /**
   * An explicit insertion order: a permutation of the included source IDs. The fixture order is the
   * default; varying the order is part of judging whether an improvement is robust.
   */
  insertionOrder?: readonly string[];
  /** Hardware and timing conditions to add to the ones the runner detects. */
  conditions?: Record<string, JsonValue>;
  /** Caveats a run records about its own evidence. */
  limits?: readonly string[];
}

/** The failure detail of a run that stopped because an insertion failed. */
export interface ReplayFailure {
  sourceId: string;
  noteId: string | null;
  operation: string;
  stage: string;
  persistence: string;
  reason: string;
  affectedNoteIds: string[];
}

/** The outcome of one replay. Artifacts exist in every case; the caller decides how to react. */
export interface ReplayResult {
  status: "completed" | "stopped" | "failed";
  runId: string;
  directory: string;
  manifest: RunManifest;
  report: RunReport;
  /** The recorded failure when `status` is `failed`. */
  failure: ReplayFailure | null;
  /** Why a stopped run stopped, when `status` is `stopped`. */
  stoppingReason: string | null;
}

const defaultConditions = (): Record<string, JsonValue> => ({
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  concurrency: 1,
});

/** Validate the run's own numeric settings before a run directory or a provider call exists. */
const validateLimits = (input: {
  neighbors: number;
  directLimit: number;
  linkedLimit: number;
}): void => {
  const positive = (value: number, name: string): string[] =>
    Number.isSafeInteger(value) && value > 0
      ? []
      : [`${name} must be a positive safe integer`];
  const problems = [
    ...positive(input.neighbors, "The neighbor limit"),
    ...positive(input.directLimit, "The direct-match limit"),
    ...(Number.isSafeInteger(input.linkedLimit) && input.linkedLimit >= 0
      ? []
      : ["The linked-addition limit must be a nonnegative safe integer"]),
  ];
  if (problems.length > 0) {
    throw new FixtureError(problems);
  }
};

const failureDetail = (error: unknown): ReplayFailure => {
  if (error instanceof MemoryError) {
    return {
      sourceId: "",
      noteId: error.noteId ?? null,
      operation: error.operation,
      stage: error.stage,
      persistence: error.persistence,
      reason: error.message,
      affectedNoteIds: [...(error.affectedNoteIds ?? [])],
    };
  }
  return {
    sourceId: "",
    noteId: null,
    operation: "add",
    stage: "unknown",
    persistence: "unknown",
    reason: error instanceof Error ? error.message : String(error),
    affectedNoteIds: [],
  };
};

const budgetFrom = (error: unknown): BudgetExhaustedError | null => {
  if (error instanceof BudgetExhaustedError) {
    return error;
  }
  if (
    error instanceof MemoryError &&
    error.cause instanceof BudgetExhaustedError
  ) {
    return error.cause;
  }
  return null;
};

/** Reject exclusions that name nothing in the fixture, before any insertion. */
const validateExclusions = (
  sources: readonly SourceEntry[],
  queries: readonly QueryCase[],
  excludeSources: ReadonlySet<string>,
  excludeQueries: ReadonlySet<string>,
): void => {
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  const queryIds = new Set(queries.map((query) => query.id));
  const problems: string[] = [];
  for (const id of excludeSources) {
    if (!sourceIds.has(id)) {
      problems.push(`excluded source ID "${id}" is not in the fixture`);
    }
  }
  for (const id of excludeQueries) {
    if (!queryIds.has(id)) {
      problems.push(`excluded query ID "${id}" is not in the fixture`);
    }
  }
  if (problems.length > 0) {
    throw new FixtureError(problems);
  }
};

/**
 * Apply an explicit insertion order. It must be a permutation of the included source IDs, so a
 * mistyped or repeated ID fails the run before any paid work.
 */
const orderInsertions = (
  included: readonly SourceEntry[],
  order: readonly string[] | undefined,
): SourceEntry[] => {
  if (order === undefined) {
    return [...included];
  }
  const byId = new Map(included.map((source) => [source.sourceId, source]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const sourceId of order) {
    if (seen.has(sourceId)) {
      problems.push(`insertion order repeats source ID "${sourceId}"`);
    }
    seen.add(sourceId);
    if (!byId.has(sourceId)) {
      problems.push(`insertion order names unknown source ID "${sourceId}"`);
    }
  }
  for (const source of included) {
    if (!seen.has(source.sourceId)) {
      problems.push(`insertion order omits source ID "${source.sourceId}"`);
    }
  }
  if (problems.length > 0) {
    throw new FixtureError(problems);
  }
  return order.map((sourceId) => byId.get(sourceId)!);
};

/** Export every current note through public pagination, with a bound against a broken cursor. */
const exportNotes = async (memory: AgenticMemory): Promise<Note[]> => {
  const notes: Note[] = [];
  const pageSize = 100;
  const maxPages = 10_000;
  let cursor: Cursor | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const current = await memory.page(pageSize, cursor);
    notes.push(...current.notes);
    if (current.cursor === undefined) {
      return notes;
    }
    cursor = current.cursor;
  }
  throw new Error(
    `Pagination did not finish after ${String(maxPages)} pages; the store cursor is suspect.`,
  );
};

const sourceIdByNoteIdentity = (
  records: readonly SourceRecord[],
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const record of records) {
    map.set(record.noteId.toLowerCase(), record.sourceId);
  }
  return map;
};

const countLinks = (
  records: readonly SourceRecord[],
  notes: Map<string, Note>,
): number => {
  let links = 0;
  for (const record of records) {
    links += notes.get(record.noteId.toLowerCase())?.links.length ?? 0;
  }
  return links;
};

/**
 * Run one replay. Fixture validation happens before the run directory or any provider call exists;
 * a failure during insertion is recorded and stops the replay without attempting any recovery.
 */
export const runReplay = async (
  options: ReplayRunOptions,
): Promise<ReplayResult> => {
  validateFixture(options.sources, options.queries);
  const excludeSources = new Set(options.excludeSources ?? []);
  const excludeQueries = new Set(options.excludeQueries ?? []);
  validateExclusions(
    options.sources,
    options.queries,
    excludeSources,
    excludeQueries,
  );
  const inserted = orderInsertions(
    options.sources.filter((source) => !excludeSources.has(source.sourceId)),
    options.insertionOrder,
  );
  const evaluated = options.queries.filter(
    (query) => !excludeQueries.has(query.id),
  );
  const prompts: MemoryPrompts = {
    construction: options.prompts?.construction ?? defaultPrompts.construction,
    evolution: options.prompts?.evolution ?? defaultPrompts.evolution,
  };
  const neighbors = options.neighbors ?? 5;
  const directLimit = options.directLimit ?? 5;
  const linkedLimit = options.linkedLimit ?? 5;
  validateLimits({ neighbors, directLimit, linkedLimit });
  const description = options.environment.describe();
  const manifest: RunManifest = {
    runId: options.runId,
    status: "running",
    revision: options.revision,
    fixture: {
      sourceHash: options.sourceHash,
      queryHash: options.queryHash,
      sourceCount: options.sources.length,
      queryCount: options.queries.length,
      insertionOrder: inserted.map((source) => source.sourceId),
    },
    resume: null,
    prompts,
    encoder: {
      spaceId: options.environment.embedder.space.id,
      dimensions: options.environment.embedder.space.dimensions,
      settings: description.encoder.settings,
    },
    model: description.model,
    storage: {
      kind: description.storage.kind,
      endpoint: description.storage.endpoint,
      schemaVersion: description.storage.schemaVersion,
      representation: runtimeRepresentation,
      collections: {},
    },
    memory: { neighbors, directLimit, linkedLimit },
    timing: {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      conditions: { ...defaultConditions(), ...(options.conditions ?? {}) },
    },
  };
  const artifacts = await RunArtifacts.create(options.runsDirectory, manifest);
  const recorder = new ReplayRecorder(artifacts, {
    recordRawExchanges: options.recordRawExchanges ?? false,
    budget: options.budget ?? null,
  });
  const embedder = instrumentEmbedder(options.environment.embedder, recorder);
  const model = instrumentModel(options.environment.model, recorder, {
    exchanges: options.environment.exchanges,
  });
  const runtime = await options.environment.openCollection({
    representation: runtimeRepresentation,
    label: "runtime",
  });
  manifest.storage.collections["runtime"] = runtime.collection;
  const runtimeStore = instrumentStore(runtime.store, recorder);
  const memory = new AgenticMemory(runtimeStore, embedder, model, {
    neighbors,
  });

  const sourceRecords: SourceRecord[] = [];
  const constructed: ConstructedNote[] = [];
  const failures: ReplayFailure[] = [];
  let status: ReplayResult["status"] = "completed";
  let stoppingReason: string | null = null;

  for (const source of inserted) {
    recorder.beginInsertion(source.sourceId);
    const started = performance.now();
    try {
      const note = await memory.add(toAddInput(source));
      const capture = await recorder.endInsertion(
        performance.now() - started,
        note.id,
      );
      const attributes = structuredClone(
        readConstructionResponse(capture.constructResponse),
      );
      const constructedNote: Note = {
        id: note.id,
        content: source.content,
        timestamp: note.timestamp,
        context: attributes.context,
        keywords: attributes.keywords,
        tags: attributes.tags,
        links: [],
        ...(source.metadata === undefined ? {} : { metadata: source.metadata }),
      };
      const firstEmbedding = capture.firstEmbedding;
      if (
        firstEmbedding === null ||
        firstEmbedding.text !== embeddingText(constructedNote)
      ) {
        throw new Error(
          `The first embedding of the insertion "${source.sourceId}" is not the captured ` +
            "constructed representation; the capture and the library disagree.",
        );
      }
      const change: ChangeRecord = {
        kind: "insertion",
        sourceId: source.sourceId,
        changes: capture.writes
          .filter((write) => write.acknowledged)
          .flatMap((write) => write.changes),
      };
      await artifacts.appendChange(change);
      await artifacts.appendConstruction({
        sourceId: source.sourceId,
        noteId: note.id,
        attributes,
      } satisfies ConstructionRecord);
      sourceRecords.push({
        sourceId: source.sourceId,
        content: source.content,
        timestamp: source.timestamp ?? null,
        metadata: source.metadata ?? null,
        noteId: note.id,
      });
      constructed.push({
        sourceId: source.sourceId,
        note: constructedNote,
        vector: firstEmbedding.vector,
      });
    } catch (cause) {
      const durationMs = performance.now() - started;
      const detail = { ...failureDetail(cause), sourceId: source.sourceId };
      const capture = await recorder.endInsertion(durationMs, detail.noteId);
      const budget = budgetFrom(cause);
      if (budget !== null) {
        status = "stopped";
        stoppingReason = budget.budgetReason;
        await artifacts.appendChange({
          kind: "budget",
          sourceId: source.sourceId,
          noteId: detail.noteId,
          budgetReason: budget.budgetReason,
          detail: budget.message,
        });
        break;
      }
      failures.push(detail);
      status = "failed";
      await artifacts.appendChange({
        kind: "failure",
        sourceId: detail.sourceId,
        noteId: detail.noteId,
        operation: detail.operation,
        stage: detail.stage,
        persistence: detail.persistence,
        reason: detail.reason,
        affectedNoteIds: detail.affectedNoteIds,
        prepared: capture.writes
          .filter((write) => !write.acknowledged)
          .flatMap((write) =>
            write.changes.map((entry) => ({
              noteId: entry.noteId,
              note: entry.after,
            })),
          ),
      });
      break;
    }
  }

  await artifacts.writeSources(sourceRecords);

  const exportedNotes = await exportNotes(memory);
  const noteByIdentity = new Map(
    exportedNotes.map((note) => [note.id.toLowerCase(), note]),
  );
  const finalNotes: FinalNoteRecord[] = sourceRecords.map((record) => {
    const note = noteByIdentity.get(record.noteId.toLowerCase());
    if (note === undefined) {
      throw new Error(
        `The acknowledged note ${record.noteId} is missing from the paged export.`,
      );
    }
    return { sourceId: record.sourceId, note };
  });
  await artifacts.writeNotes(finalNotes);

  const summaryBefore = recorder.summary();
  const sourceIdByNoteId = sourceIdByNoteIdentity(sourceRecords);
  const retrievalRecords: RetrievalRecord[] = [];
  const checks: RunCheck[] = [];
  const retrievalEvaluated = status !== "failed";

  if (retrievalEvaluated) {
    recorder.beginMaterialization();
    const runs: RetrievalRun[] = [];
    for (const mode of comparisonModes) {
      if (mode.collectionLabel === null) {
        continue;
      }
      const opened = await options.environment.openCollection({
        representation: mode.representation,
        label: mode.collectionLabel,
      });
      manifest.storage.collections[mode.id] = opened.collection;
      const store = instrumentStore(opened.store, recorder);
      await store.put(await baselineRecords(mode, constructed, embedder));
      runs.push({
        mode,
        collection: opened.collection,
        memory: new AgenticMemory(store, embedder, model, { neighbors }),
      });
    }
    for (const mode of comparisonModes) {
      if (mode.collectionLabel === null) {
        runs.push({ mode, collection: runtime.collection, memory });
      }
    }
    recorder.beginEvaluation();
    const evaluation = await evaluateRetrieval({
      runs,
      queries: evaluated,
      directLimit,
      linkedLimit,
      sourceIdByNoteId,
    });
    retrievalRecords.push(...evaluation.records);
    checks.push(...evaluation.checks);
  }
  await artifacts.writeRetrieval(retrievalRecords);

  const summary = recorder.summary();
  const insertions = sourceRecords.length;
  const generationBound = Math.max(0, 2 * insertions - 1);
  const generationCalls = summary.calls.construct + summary.calls.evolve;
  checks.push({
    name: "generation call bound",
    ok: generationCalls <= generationBound,
    detail:
      `${String(generationCalls)} successful generation calls against the documented bound ` +
      `${String(generationBound)} for ${String(insertions)} insertions.`,
  });
  checks.push({
    name: "retrieval makes no model call",
    ok:
      !retrievalEvaluated || summary.calls.total === summaryBefore.calls.total,
    detail: retrievalEvaluated
      ? `${String(summary.calls.total - summaryBefore.calls.total)} model calls during retrieval.`
      : "Retrieval evaluation was skipped because insertion failed.",
  });
  checks.push({
    name: "acknowledged notes are readable",
    ok: finalNotes.length === insertions,
    detail:
      `${String(finalNotes.length)} of ${String(insertions)} acknowledged notes exported through ` +
      "public pagination.",
  });
  const insertionEmbeddings = summary.embeddingDurations.insertion.length;
  checks.push({
    name: "embedding call bound",
    ok: insertionEmbeddings <= insertions * (neighbors + 2),
    detail:
      `${String(insertionEmbeddings)} insertion embeddings against the documented bound ` +
      `${String(insertions * (neighbors + 2))} for ${String(insertions)} insertions with ` +
      `${String(neighbors)} candidates.`,
  });
  if (retrievalEvaluated) {
    checks.push({
      name: "comparison modes evaluated",
      ok: retrievalRecords.length === evaluated.length * comparisonModes.length,
      detail:
        `${String(retrievalRecords.length)} query evaluations across ` +
        `${String(comparisonModes.length)} modes for ${String(evaluated.length)} queries.`,
    });
    checks.push({
      name: "one query embedding per search",
      ok:
        summary.embeddingDurations.evaluation.length ===
        retrievalRecords.length,
      detail:
        `${String(summary.embeddingDurations.evaluation.length)} query embeddings for ` +
        `${String(retrievalRecords.length)} searches.`,
    });
  }

  const usage = summarizeUsage(summary);
  const rates = options.costRates ?? null;
  const costTotal =
    usage.known && rates !== null
      ? computeCost(
          {
            inputTokens:
              (usage.uncachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
          } satisfies TokenUsage,
          rates,
        )
      : null;
  const retrieval: Record<string, ModeSummary> = {};
  const search: RunReport["timings"]["search"] = {};
  for (const mode of comparisonModes) {
    const records = retrievalRecords.filter(
      (record) => record.mode === mode.id,
    );
    retrieval[mode.id] = summarizeMode(mode.representation, records);
    const durations = records.map((record) => record.latencyMs);
    const [coldSearch = null, ...warmSearches] = durations;
    search[mode.id] = {
      coldMs: coldSearch,
      warm: summarizeTimings(warmSearches),
      all: summarizeTimings(durations),
    };
  }
  const insertionDurations = summary.insertionDurations;
  const [coldMs = null, ...warmDurations] = insertionDurations;
  const sourceCharacters = inserted.map((source) => source.content.length);
  const dimensions = options.environment.embedder.space.dimensions;
  const conditions = manifest.timing.conditions;
  const concurrency =
    typeof conditions["concurrency"] === "number"
      ? conditions["concurrency"]
      : 1;
  const report: RunReport = {
    runId: options.runId,
    revision: options.revision,
    status,
    counts: {
      sources: options.sources.length,
      queries: options.queries.length,
      insertions,
      insertionFailures: failures.length,
      finalNotes: finalNotes.length,
      directedLinks: countLinks(sourceRecords, noteByIdentity),
      embeddingCalls: insertionEmbeddings,
      modelCalls: {
        construct: summary.calls.construct,
        evolve: summary.calls.evolve,
        total: summary.calls.total,
      },
      failedModelCalls: summary.calls.failed,
    },
    generation: {
      successfulConstruct: summary.calls.construct,
      successfulEvolve: summary.calls.evolve,
      totalSuccessful: generationCalls,
      upperBound: generationBound,
      withinBound: generationCalls <= generationBound,
    },
    retrieval,
    usage,
    cost: {
      known: costTotal !== null,
      rates,
      total: costTotal,
      note:
        costTotal !== null
          ? "Generation tokens only, from reported usage and the supplied per-million-token " +
            "rates; embedding compute, database hosting and backups are not measured."
          : `Unknown: ${[
              rates === null ? "no rates were supplied" : null,
              usage.known
                ? null
                : summary.calls.failed > 0
                  ? "a failed model call has unmeasured usage"
                  : "not every successful call reported input and output usage",
            ]
              .filter((reason): reason is string => reason !== null)
              .join("; ")}.`,
    },
    context: {
      corpusNotes: insertions,
      encoderDimensions: dimensions,
      sourceCharacters: {
        total: sourceCharacters.reduce((total, value) => total + value, 0),
        median: percentile(sourceCharacters, 0.5),
        max: percentile(sourceCharacters, 1),
      },
      limits: { neighbors, direct: directLimit, linked: linkedLimit },
      concurrency,
      conditions,
    },
    storage: {
      notes: insertions,
      dimensions,
      rawVectorBytes: insertions * dimensions * 4,
      note:
        "Raw float32 vectors only; payloads, indexes, WAL, replicas, allocator overhead and " +
        "backups are excluded.",
    },
    timings: {
      insertions: {
        coldMs,
        warm: summarizeTimings(warmDurations),
        all: summarizeTimings(insertionDurations),
      },
      insertionStages: {
        generation: summarizeTimings([
          ...summary.callDurations.construct,
          ...summary.callDurations.evolve,
        ]),
        embedding: summarizeTimings(summary.embeddingDurations.insertion),
        candidateSearch: summarizeTimings(
          summary.storeDurations.insertion.nearest,
        ),
        persistence: summarizeTimings(summary.storeDurations.insertion.put),
      },
      retrieval: {
        queryEmbedding: summarizeTimings(summary.embeddingDurations.evaluation),
        storeSearch: summarizeTimings(
          summary.storeDurations.evaluation.nearest,
        ),
      },
      search,
    },
    checks,
    failures: failures.map((failure) => ({
      sourceId: failure.sourceId,
      operation: failure.operation,
      stage: failure.stage,
      persistence: failure.persistence,
      reason: failure.reason,
    })),
    exclusions: {
      sources: [...excludeSources],
      queries: [...excludeQueries],
      note:
        "Query text is never inserted as source material; excluded entries stay out of the " +
        "insertion or evaluation scope and are listed here.",
    },
    semanticReview: [...(options.semanticReview ?? [])],
    stoppingReason,
    limits: [...(options.limits ?? [])],
    extrapolations: [],
    artifacts: [...runArtifactFiles],
  };
  await artifacts.writeReport(report);
  manifest.status = status;
  manifest.timing.finishedAt = new Date().toISOString();
  await artifacts.writeManifest(manifest);
  const failure = failures[0] ?? null;
  return {
    status,
    runId: options.runId,
    directory: artifacts.directory,
    manifest,
    report,
    failure,
    stoppingReason,
  };
};

/**
 * Build the records one baseline collection holds: the constructed note snapshot with the vector of
 * the representation that mode compares. The raw-content baseline embeds only the immutable source
 * content; the constructed baseline reuses the captured construction vector.
 */
const baselineRecords = async (
  mode: ComparisonMode,
  constructed: readonly ConstructedNote[],
  embedder: { embed(text: string): Promise<number[]> },
): Promise<EmbeddedNote[]> => {
  const records: EmbeddedNote[] = [];
  for (const entry of constructed) {
    const vector =
      mode.id === "original-content"
        ? await embedder.embed(entry.note.content)
        : entry.vector;
    records.push({ note: structuredClone(entry.note), vector });
  }
  return records;
};
