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
  type Attributes,
  type Cursor,
  type EmbeddedNote,
  type JsonValue,
  type MemoryPrompts,
  type Note,
} from "../../src/index.js";
import {
  RunArtifacts,
  runArtifactFiles,
  type BudgetSummary,
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
  type StoppingReason,
  type StorageObservation,
  type TokenUsage,
} from "./artifacts.js";
import {
  comparisonModes,
  evaluateRetrieval,
  runtimeRepresentation,
  type ComparisonMode,
  type RetrievalRun,
} from "./comparison.js";
import {
  assertCredentialFreeEndpoint,
  type EvaluationEnvironment,
} from "./environment.js";
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
  summarizeSamples,
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
  /** Host credentials removed from every serialized artifact; never passed to Memory. */
  artifactCredentials?: readonly string[];
  /** A declared call/token budget; a live run stops instead of overspending. */
  budget?: ModelBudget | null;
  /**
   * Durations the host measured while preparing the environment, before the replay started. The
   * host resolves the encoder and the model transport, so only it can report their cold cost.
   */
  startup?: {
    /** Resolving the embedder, including cold encoder loading; null when unmeasured. */
    encoderLoadMs?: number | null;
    /** Resolving the model transport; null when unmeasured. */
    modelSetupMs?: number | null;
  };
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
  stoppingReason: StoppingReason | null;
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
    if (record.noteId !== null) {
      map.set(record.noteId.toLowerCase(), record.sourceId);
    }
  }
  return map;
};

const countLinks = (
  records: readonly SourceRecord[],
  notes: Map<string, Note>,
): number => {
  let links = 0;
  for (const record of records) {
    if (record.noteId === null) {
      continue;
    }
    links += notes.get(record.noteId.toLowerCase())?.links.length ?? 0;
  }
  return links;
};

/**
 * Read the construction attributes a capture holds. A response the response contract rejects is not
 * a successful construction, so only a parseable capture produces a construction artifact.
 */
const capturedConstruction = (response: unknown): Attributes | null => {
  if (response === null) {
    return null;
  }
  try {
    return structuredClone(readConstructionResponse(response));
  } catch {
    return null;
  }
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
  // A recorded endpoint identity must never carry credentials. This runs before the run directory
  // exists, so a rejected configuration cannot leave plaintext credentials in a retained manifest.
  assertCredentialFreeEndpoint(
    description.storage.endpoint,
    "The storage endpoint",
  );
  assertCredentialFreeEndpoint(
    description.model.endpoint,
    "The model endpoint",
  );
  const declaredBudget: ModelBudget | null = options.budget ?? null;
  /**
   * Every supplied entry, recorded whether or not its insertion succeeds. A failed or stopped run
   * still shows what was supplied, what identity an attempt allocated and where it stopped.
   */
  const sourceRecords: SourceRecord[] = options.sources.map((source) => ({
    sourceId: source.sourceId,
    content: source.content,
    timestamp: source.timestamp ?? null,
    metadata: source.metadata ?? null,
    noteId: null,
    outcome: excludeSources.has(source.sourceId) ? "excluded" : "unattempted",
  }));
  const recordBySourceId = new Map(
    sourceRecords.map((record) => [record.sourceId, record]),
  );
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
    budget: declaredBudget,
    timing: {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      conditions: { ...defaultConditions(), ...(options.conditions ?? {}) },
    },
  };
  const artifacts = await RunArtifacts.create(
    options.runsDirectory,
    manifest,
    options.artifactCredentials,
  );
  const recorder = new ReplayRecorder(artifacts, {
    recordRawExchanges: options.recordRawExchanges ?? false,
    budget: declaredBudget,
  });
  const embedder = instrumentEmbedder(options.environment.embedder, recorder);
  const model = instrumentModel(options.environment.model, recorder, {
    exchanges: options.environment.exchanges,
  });
  const runtimeStarted = performance.now();
  const runtime = await options.environment.openCollection({
    representation: runtimeRepresentation,
    label: "runtime",
  });
  const runtimeCollectionMs = performance.now() - runtimeStarted;
  manifest.storage.collections["runtime"] = runtime.collection;
  const runtimeStore = instrumentStore(runtime.store, recorder);
  const memory = new AgenticMemory(runtimeStore, embedder, model, {
    neighbors,
    prompts,
  });

  const constructed: ConstructedNote[] = [];
  const neighborSelections: Array<{ count: number; characters: number }> = [];
  /**
   * Generation invocations the insertion actually accepted: a construction response counts once the
   * response contract accepted it, and an evolution response counts once the insertion moved past
   * its validation. A transport failure or a rejected response is not a successful generation call.
   */
  const acceptedGeneration = { construct: 0, evolve: 0 };
  const failures: ReplayFailure[] = [];
  let status: ReplayResult["status"] = "completed";
  let stoppingReason: StoppingReason | null = null;

  for (const source of inserted) {
    recorder.beginInsertion(source.sourceId);
    const started = performance.now();
    try {
      const note = await memory.add(toAddInput(source));
      const capture = await recorder.endInsertion(
        performance.now() - started,
        note.id,
      );
      if (capture.neighbors !== null && capture.neighbors.count > 0) {
        neighborSelections.push(capture.neighbors);
      }
      const attributes = structuredClone(
        readConstructionResponse(capture.constructResponse),
      );
      acceptedGeneration.construct += 1;
      if (capture.neighbors !== null && capture.neighbors.count > 0) {
        acceptedGeneration.evolve += 1;
      }
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
      const record = recordBySourceId.get(source.sourceId);
      if (record !== undefined) {
        record.noteId = note.id;
        record.outcome = "inserted";
      }
      constructed.push({
        sourceId: source.sourceId,
        note: constructedNote,
        vector: firstEmbedding.vector,
      });
    } catch (cause) {
      const durationMs = performance.now() - started;
      const detail = { ...failureDetail(cause), sourceId: source.sourceId };
      const capture = await recorder.endInsertion(durationMs, detail.noteId);
      if (capture.neighbors !== null && capture.neighbors.count > 0) {
        neighborSelections.push(capture.neighbors);
      }
      const budget = budgetFrom(cause);
      const record = recordBySourceId.get(source.sourceId);
      if (record !== undefined) {
        record.noteId = detail.noteId;
        record.outcome = budget === null ? "failed" : "stopped";
      }
      // A construction that succeeded before a later stage failed is still evidence: retain its
      // attributes and the identity the attempt allocated, as docs/evaluation.md requires.
      const attributes = capturedConstruction(capture.constructResponse);
      if (attributes !== null) {
        acceptedGeneration.construct += 1;
      }
      if ((capture.neighbors?.count ?? 0) > 0 && detail.stage !== "evolve") {
        // The insertion reached and passed evolution before failing at a later stage.
        acceptedGeneration.evolve += 1;
      }
      if (attributes !== null && detail.noteId !== null) {
        await artifacts.appendConstruction({
          sourceId: source.sourceId,
          noteId: detail.noteId,
          attributes,
        } satisfies ConstructionRecord);
      }
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

  // A run that reached its declared budget on its last call never attempts another call, so
  // the exhausted state has to reach the final outcome here as well.
  const exhausted = recorder.budgetState();
  if (status === "completed" && exhausted !== null) {
    status = "stopped";
    stoppingReason = exhausted;
    await artifacts.appendChange({
      kind: "budget",
      sourceId: null,
      noteId: null,
      budgetReason: exhausted,
      detail:
        recorder.budgetDetail() ??
        `The run exhausted its declared ${exhausted.replace("-", " ")}.`,
    });
  }

  await artifacts.writeSources(sourceRecords);

  const exportedNotes = await exportNotes(memory);
  const noteByIdentity = new Map(
    exportedNotes.map((note) => [note.id.toLowerCase(), note]),
  );
  const sourceIdByNoteId = sourceIdByNoteIdentity(sourceRecords);
  // Every note the store actually holds is exported, whether or not its insertion was acknowledged:
  // an uncertain write can persist a note the run never saw acknowledged.
  const finalNotes: FinalNoteRecord[] = exportedNotes.map((note) => ({
    sourceId: sourceIdByNoteId.get(note.id.toLowerCase()) ?? null,
    note,
  }));
  await artifacts.writeNotes(finalNotes);

  const summaryBefore = recorder.summary();
  const retrievalRecords: RetrievalRecord[] = [];
  const checks: RunCheck[] = [];
  const retrievalEvaluated = status !== "failed";
  let baselineMaterializationMs: number | null = null;

  if (retrievalEvaluated) {
    const materializationStarted = performance.now();
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
    baselineMaterializationMs = performance.now() - materializationStarted;
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

  const storageObservation: StorageObservation | null =
    options.environment.observe === undefined
      ? null
      : await options.environment.observe(runtime.collection);

  const summary = recorder.summary();
  const insertions = sourceRecords.filter(
    (record) => record.outcome === "inserted",
  ).length;
  const attemptedInsertions = sourceRecords.filter(
    (record) =>
      record.outcome === "inserted" ||
      record.outcome === "failed" ||
      record.outcome === "stopped",
  ).length;
  // The documented 2N-1 bound describes an uninterrupted run of N successful insertions. A failed
  // or budget-stopped run counts its incomplete attempts separately instead of failing a bound that
  // does not describe it.
  const boundApplies = status === "completed";
  const generationBound = Math.max(0, 2 * insertions - 1);
  const generationCalls =
    acceptedGeneration.construct + acceptedGeneration.evolve;
  checks.push({
    name: "generation call bound",
    ok: !boundApplies || generationCalls <= generationBound,
    detail: boundApplies
      ? `${String(generationCalls)} successful generation calls against the documented bound ` +
        `${String(generationBound)} for ${String(insertions)} insertions.`
      : `Not applicable: the run ended ${status} after ${String(insertions)} insertions; ` +
        `${String(generationCalls)} accepted and ${String(summary.calls.failed)} failed ` +
        "generation attempts stay reported separately.",
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
    ok: sourceRecords.every(
      (record) =>
        record.outcome !== "inserted" ||
        (record.noteId !== null &&
          noteByIdentity.has(record.noteId.toLowerCase())),
    ),
    detail:
      `${String(finalNotes.length)} notes exported through public pagination for ` +
      `${String(insertions)} acknowledged insertions.`,
  });
  const insertionEmbeddings = summary.embeddingDurations.insertion.length;
  checks.push({
    name: "embedding call bound",
    ok: insertionEmbeddings <= attemptedInsertions * (neighbors + 2),
    detail:
      `${String(insertionEmbeddings)} insertion embeddings against the documented bound ` +
      `${String(attemptedInsertions * (neighbors + 2))} for ${String(attemptedInsertions)} ` +
      `attempted insertions with ${String(neighbors)} candidates.`,
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
  const costResult =
    usage.known && rates !== null
      ? computeCost(
          {
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
          } satisfies TokenUsage,
          rates,
        )
      : { exact: null, upperBound: null };
  const noModelCall = summary.calls.total === 0;
  const costNote = ((): string => {
    if (costResult.exact !== null) {
      return (
        "Generation tokens only, from reported usage and the supplied per-million-token " +
        "rates; embedding compute, database hosting and backups are not measured."
      );
    }
    if (costResult.upperBound !== null) {
      return (
        "Unknown: not every call reported its cache-hit tokens, and the supplied cached rate " +
        "differs from the uncached rate. upperBound prices every input token at the higher input rate, the " +
        "highest cost those rates can produce; it is not measured cost."
      );
    }
    const reasons: string[] = [];
    if (rates === null) {
      reasons.push("no rates were supplied");
    }
    if (noModelCall) {
      reasons.push("no model call was made");
    } else if (!usage.known) {
      reasons.push("not every call reported input and output usage");
    }
    return `Unknown: ${reasons.join("; ")}.`;
  })();
  const budget: BudgetSummary | null =
    declaredBudget === null
      ? null
      : {
          callBudget: declaredBudget.callBudget,
          tokenBudget: declaredBudget.tokenBudget,
          modelCalls: summary.calls.total,
          // A partial total is not a measurement, so an incomplete run reports it as unknown.
          tokensUsed: noModelCall
            ? 0
            : usage.known
              ? summary.usage.tokensUsed
              : null,
          usageComplete: noModelCall || usage.known,
        };
  if (budget !== null) {
    checks.push({
      name: "declared token budget enforceable",
      ok: budget.usageComplete,
      detail: budget.usageComplete
        ? `${String(summary.usage.tokensUsed)} tokens reported across ` +
          `${String(summary.calls.total)} calls against the declared ` +
          `${String(budget.tokenBudget)}-token budget.`
        : "Every model call must report its input and output tokens for the declared token " +
          "budget to be verifiable; the run stopped instead of continuing beyond an unknown total.",
    });
  }
  const retrieval: Record<string, ModeSummary> = {};
  const search: RunReport["timings"]["search"] = {};
  for (const mode of comparisonModes) {
    const records = retrievalRecords.filter(
      (record) => record.mode === mode.id,
    );
    retrieval[mode.id] = summarizeMode(mode.representation, records);
    const durations = records.map((record) => record.latencyMs);
    const [firstSearch = null, ...warmSearches] = durations;
    search[mode.id] = {
      firstMs: firstSearch,
      warm: summarizeTimings(warmSearches),
      all: summarizeTimings(durations),
    };
  }
  const insertionDurations = summary.insertionDurations;
  const [firstInsertionMs = null, ...warmDurations] = insertionDurations;
  const sourceCharacters = inserted.map((source) => source.content.length);
  const neighborCounts = neighborSelections.map((entry) => entry.count);
  const neighborCharacters = neighborSelections.map(
    (entry) => entry.characters,
  );
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
      successfulConstruct: acceptedGeneration.construct,
      successfulEvolve: acceptedGeneration.evolve,
      totalSuccessful: generationCalls,
      upperBound: boundApplies ? generationBound : null,
      withinBound: boundApplies ? generationCalls <= generationBound : null,
      note: boundApplies
        ? `The documented bound for ${String(insertions)} uninterrupted insertions; a call counts ` +
          "once the insertion accepted its response, and failed attempts and host retries are " +
          "additional."
        : `Not applicable: the run ended ${status}. The bound describes an uninterrupted run of ` +
          `${String(insertions)} successful insertions; ${String(summary.calls.failed)} transport ` +
          "failures and the incomplete attempts stay reported separately.",
    },
    retrieval,
    usage,
    cost: {
      known: costResult.exact !== null,
      total: costResult.exact,
      upperBound: costResult.upperBound,
      rates,
      note: costNote,
    },
    budget,
    context: {
      corpusNotes: finalNotes.length,
      encoderDimensions: dimensions,
      sourceCharacters: {
        total: sourceCharacters.reduce((total, value) => total + value, 0),
        median: percentile(sourceCharacters, 0.5),
        max: percentile(sourceCharacters, 1),
      },
      neighbors: {
        insertionsWithCandidates: neighborSelections.length,
        count: summarizeSamples(neighborCounts),
        characters: summarizeSamples(neighborCharacters),
      },
      limits: { neighbors, direct: directLimit, linked: linkedLimit },
      concurrency,
      conditions,
    },
    storage: {
      notes: finalNotes.length,
      dimensions,
      rawVectorBytes: finalNotes.length * dimensions * 4,
      indexedVectors: storageObservation?.indexedVectors ?? null,
      configuration: storageObservation?.configuration ?? null,
      note:
        "Raw float32 vectors only; payloads, indexes, WAL, replicas, allocator overhead and " +
        "backups are excluded." +
        (storageObservation === null
          ? " This environment did not report the collection's indexed-vector count or " +
            "configuration."
          : ""),
    },
    timings: {
      startup: {
        encoderLoadMs: options.startup?.encoderLoadMs ?? null,
        modelSetupMs: options.startup?.modelSetupMs ?? null,
        runtimeCollectionMs,
        baselineMaterializationMs,
      },
      insertions: {
        firstMs: firstInsertionMs,
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
