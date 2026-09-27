/**
 * Run artifacts of one replay: the manifest that describes the run, the JSONL records captured
 * while it executes and the final report. Each run owns a fresh directory; an existing directory is
 * never overwritten.
 *
 * See docs/evaluation.md#run-artifacts.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Attributes, JsonValue, Note } from "../../src/index.js";

/** Token usage a provider reported for one model call; `null` means it did not report that part. */
export interface TokenUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

/** One model invocation, successful or failed, as recorded in `calls.jsonl`. */
export interface ModelCallRecord {
  callId: number;
  stage: "construct" | "evolve";
  sourceId: string | null;
  /** The note the insertion allocated, once the runner can correlate the call with it. */
  noteId: string | null;
  /** The complete assembled prompt when raw exchange recording is enabled. */
  request: string | null;
  /** The parsed response the transport returned, when it returned one. */
  response: unknown;
  /** The provider's raw response body when raw exchange recording is enabled. */
  rawResponse: string | null;
  error: { name: string; message: string } | null;
  durationMs: number;
  finishReason: string | null;
  usage: TokenUsage | null;
  requestId: string | null;
}

/** The attributes a successful construction produced, before any evolution. */
export interface ConstructionRecord {
  sourceId: string;
  noteId: string;
  attributes: Attributes;
}

/** The prepared records of one acknowledged batch write, with the state it replaced. */
export interface InsertionChange {
  kind: "insertion";
  sourceId: string;
  changes: Array<{ noteId: string; before: Note | null; after: Note }>;
}

/** An insertion that failed before or at its write boundary. */
export interface FailureChange {
  kind: "failure";
  sourceId: string;
  noteId: string | null;
  operation: string;
  stage: string;
  persistence: string;
  reason: string;
  affectedNoteIds: string[];
  /** The batch Memory prepared but the store did not acknowledge, when a write was attempted. */
  prepared: Array<{ noteId: string; note: Note }>;
}

/** A run stopped on purpose because its declared call or token budget was exhausted. */
export interface BudgetChange {
  kind: "budget";
  sourceId: string;
  noteId: string | null;
  budgetReason: "call-budget" | "token-budget";
  detail: string;
}

export type ChangeRecord = InsertionChange | FailureChange | BudgetChange;

/** One supplied source entry with the note identity it produced, as recorded in `sources.jsonl`. */
export interface SourceRecord {
  sourceId: string;
  content: string;
  timestamp: string | null;
  metadata: Record<string, JsonValue> | null;
  noteId: string;
}

/** One exported current note with the source it came from, as recorded in `notes.jsonl`. */
export interface FinalNoteRecord {
  sourceId: string;
  note: Note;
}

/** Returned text size of one result, measured with the declared canonical serialization. */
export interface ResultCharacters {
  content: number;
  attributes: number;
  total: number;
}

/** One ordered retrieval result, as recorded in `retrieval.jsonl`. */
export interface RetrievalResultRecord {
  noteId: string;
  sourceId: string | null;
  origin: "match" | "link";
  score: number | null;
  characters: ResultCharacters;
}

/** One query under one comparison mode, as recorded in `retrieval.jsonl`. */
export interface RetrievalRecord {
  mode: string;
  representation: string;
  collection: string;
  queryId: string;
  query: string;
  scope: string | null;
  rationale: string;
  requiredSourceIds: string[];
  limits: { direct: number; linked: number };
  latencyMs: number;
  results: RetrievalResultRecord[];
  recovery: {
    firstResultRequired: boolean;
    directRequired: string[];
    linkedOnlyRequired: string[];
    missingRequired: string[];
  };
}

/** Settings of the encoder a run used; the space identity and dimensions come from the embedder. */
export interface ManifestEncoder {
  spaceId: string;
  dimensions: number;
  settings: Record<string, JsonValue> | null;
}

/** Settings of the model a run invoked. `null` marks a setting the run did not use. */
export interface ManifestModel {
  endpoint: string | null;
  id: string;
  thinking: boolean;
  maxOutputTokens: number | null;
  timeoutMs: number | null;
  retries: number;
}

/** Storage identity and the isolated collections the run opened. */
export interface ManifestStorage {
  kind: "qdrant" | "in-memory";
  endpoint: string | null;
  schemaVersion: number;
  representation: string;
  collections: Record<string, string>;
}

/** The run description written before insertion starts. */
export interface RunManifest {
  runId: string;
  status: "running" | "completed" | "stopped" | "failed";
  revision: string;
  fixture: {
    sourceHash: string;
    queryHash: string;
    sourceCount: number;
    queryCount: number;
    insertionOrder: string[];
  };
  resume: null;
  prompts: { construction: string; evolution: string };
  encoder: ManifestEncoder;
  model: ManifestModel;
  storage: ManifestStorage;
  memory: { neighbors: number; directLimit: number; linkedLimit: number };
  timing: {
    startedAt: string;
    finishedAt: string | null;
    conditions: Record<string, JsonValue>;
  };
}

/** A timing sample set with its count, so a median or p95 is never read without its denominator. */
export interface TimingSummary {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

/** Aggregated retrieval measures of one comparison mode. */
export interface ModeSummary {
  representation: string;
  queries: number;
  queriesWithExpectations: number;
  firstResultRequired: { recovered: number; denominator: number };
  allRequiredDirectTopK: { recovered: number; denominator: number };
  allRequiredWithLinks: { recovered: number; denominator: number };
  linkRecoveredQueries: number;
  linkRecoveredSources: number;
  multiSourceQueries: number;
  returnedNotes: number;
  returnedCharacters: { direct: number; linked: number; total: number };
  latency: TimingSummary;
}

/** Cost rates a report multiplies token usage with; the run supplies them, not this code. */
export interface CostRates {
  currency: string;
  effectiveDate: string;
  uncachedInputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

/** Token usage totals across the run. Unknown totals stay unknown instead of being extrapolated. */
export interface UsageSummary {
  known: boolean;
  calls: { total: number; failed: number; withUsage: number };
  uncachedInputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

/** A pass/fail check the run performed on its own evidence. */
export interface RunCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** A manual semantic review finding recorded with the run. */
export interface SemanticReviewEntry {
  id: string;
  queryId: string | null;
  noteId: string | null;
  finding: string;
}

/** The measurement report written after retrieval evaluation. */
export interface RunReport {
  runId: string;
  revision: string;
  status: "completed" | "stopped" | "failed";
  counts: {
    sources: number;
    queries: number;
    insertions: number;
    insertionFailures: number;
    finalNotes: number;
    directedLinks: number;
    /** Note embeddings the insertion phase performed, including neighbor re-embeddings. */
    embeddingCalls: number;
    modelCalls: { construct: number; evolve: number; total: number };
    failedModelCalls: number;
  };
  generation: {
    successfulConstruct: number;
    successfulEvolve: number;
    totalSuccessful: number;
    upperBound: number;
    withinBound: boolean;
  };
  retrieval: Record<string, ModeSummary>;
  usage: UsageSummary;
  cost: {
    known: boolean;
    rates: CostRates | null;
    total: number | null;
    note: string;
  };
  /** What the run replayed, so a measure keeps the corpus and settings it belongs to. */
  context: {
    corpusNotes: number;
    encoderDimensions: number;
    sourceCharacters: {
      total: number;
      median: number | null;
      max: number | null;
    };
    limits: { neighbors: number; direct: number; linked: number };
    concurrency: number;
    conditions: Record<string, JsonValue>;
  };
  /** The documented raw-vector arithmetic, labeled as excluding payloads and indexes. */
  storage: {
    notes: number;
    dimensions: number;
    rawVectorBytes: number;
    note: string;
  };
  timings: {
    insertions: {
      coldMs: number | null;
      warm: TimingSummary;
      all: TimingSummary;
    };
    insertionStages: {
      generation: TimingSummary;
      embedding: TimingSummary;
      candidateSearch: TimingSummary;
      persistence: TimingSummary;
    };
    retrieval: {
      queryEmbedding: TimingSummary;
      storeSearch: TimingSummary;
    };
    search: Record<
      string,
      { coldMs: number | null; warm: TimingSummary; all: TimingSummary }
    >;
  };
  checks: RunCheck[];
  failures: Array<{
    sourceId: string;
    operation: string;
    stage: string;
    persistence: string;
    reason: string;
  }>;
  exclusions: {
    sources: string[];
    queries: string[];
    note: string;
  };
  semanticReview: SemanticReviewEntry[];
  stoppingReason: string | null;
  limits: string[];
  extrapolations: string[];
  artifacts: string[];
}

/** The artifact files one run directory always holds. */
export const runArtifactFiles = [
  "manifest.json",
  "sources.jsonl",
  "calls.jsonl",
  "construction.jsonl",
  "changes.jsonl",
  "notes.jsonl",
  "retrieval.jsonl",
  "report.json",
] as const;

/** A run identifier that maps to exactly one directory name. */
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class RunDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunDirectoryError";
  }
}

const jsonLine = (record: unknown): string => `${JSON.stringify(record)}\n`;

const jsonl = (records: readonly unknown[]): string =>
  records.map((record) => jsonLine(record)).join("");

/**
 * One run directory. JSONL artifacts are created empty and appended as the run proceeds; the
 * manifest, sources, notes, retrieval list and report are written once their content is known. A
 * run directory is never cleared or reused.
 */
export class RunArtifacts {
  readonly directory: string;
  readonly #manifestPath: string;

  private constructor(directory: string) {
    this.directory = directory;
    this.#manifestPath = path.join(directory, "manifest.json");
  }

  static async create(
    runsDirectory: string,
    manifest: RunManifest,
  ): Promise<RunArtifacts> {
    if (!runIdPattern.test(manifest.runId)) {
      throw new RunDirectoryError(
        `A run ID must start with a letter or digit and contain only letters, digits, ".", "_" ` +
          `or "-", received "${manifest.runId}".`,
      );
    }
    await mkdir(runsDirectory, { recursive: true });
    const directory = path.join(runsDirectory, manifest.runId);
    try {
      // No recursion: an existing directory belongs to an earlier run and is never overwritten.
      await mkdir(directory);
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        (cause as { code?: unknown }).code === "EEXIST"
      ) {
        throw new RunDirectoryError(
          `The run directory ${directory} already exists; choose another run ID.`,
        );
      }
      throw cause;
    }
    const artifacts = new RunArtifacts(directory);
    await artifacts.writeManifest(manifest);
    await Promise.all(
      ["calls.jsonl", "construction.jsonl", "changes.jsonl"].map((file) =>
        writeFile(path.join(directory, file), "", "utf8"),
      ),
    );
    return artifacts;
  }

  async writeManifest(manifest: RunManifest): Promise<void> {
    await writeFile(
      this.#manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  async appendModelCall(record: ModelCallRecord): Promise<void> {
    await appendFile(
      path.join(this.directory, "calls.jsonl"),
      jsonLine(record),
      "utf8",
    );
  }

  async appendConstruction(record: ConstructionRecord): Promise<void> {
    await appendFile(
      path.join(this.directory, "construction.jsonl"),
      jsonLine(record),
      "utf8",
    );
  }

  async appendChange(record: ChangeRecord): Promise<void> {
    await appendFile(
      path.join(this.directory, "changes.jsonl"),
      jsonLine(record),
      "utf8",
    );
  }

  async writeSources(records: readonly SourceRecord[]): Promise<void> {
    await writeFile(
      path.join(this.directory, "sources.jsonl"),
      jsonl(records),
      "utf8",
    );
  }

  async writeNotes(records: readonly FinalNoteRecord[]): Promise<void> {
    await writeFile(
      path.join(this.directory, "notes.jsonl"),
      jsonl(records),
      "utf8",
    );
  }

  async writeRetrieval(records: readonly RetrievalRecord[]): Promise<void> {
    await writeFile(
      path.join(this.directory, "retrieval.jsonl"),
      jsonl(records),
      "utf8",
    );
  }

  async writeReport(report: RunReport): Promise<void> {
    await writeFile(
      path.join(this.directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }
}
