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
import { redactCredential } from "../../examples/host-model-transport.js";

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
  /** The insertion the stop interrupted; null when the budget was reached after the last one. */
  sourceId: string | null;
  noteId: string | null;
  budgetReason: "call-budget" | "token-budget";
  detail: string;
}

export type ChangeRecord = InsertionChange | FailureChange | BudgetChange;

/**
 * One supplied source entry with the note identity it produced, as recorded in `sources.jsonl`. The
 * entry is recorded whether or not the insertion succeeded, so a failed or stopped run still shows
 * every supplied source and the identity its failed attempt allocated.
 */
export interface SourceRecord {
  sourceId: string;
  content: string;
  timestamp: string | null;
  metadata: Record<string, JsonValue> | null;
  /** The note identity the insertion allocated; null when no insertion attempt started. */
  noteId: string | null;
  /**
   * How far the supplied entry got: a successful insertion, a failed or budget-stopped attempt, an
   * entry the run deliberately excluded, or an entry the run never reached.
   */
  outcome: "inserted" | "failed" | "stopped" | "excluded" | "unattempted";
}

/** One exported current note with the source it came from, as recorded in `notes.jsonl`. */
export interface FinalNoteRecord {
  /** The fixture source whose insertion allocated this note; null when the run cannot attribute it. */
  sourceId: string | null;
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
  /** The complete note snapshot this mode returned, with its mode-specific attributes. */
  note: Note;
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
  /**
   * The thinking mode recorded for the run. The supplied transports send no thinking parameter, so
   * this states how the provider or model configuration was set, not something the transport
   * applied: `unspecified` when the host declared none.
   */
  thinking: "disabled-external" | "enabled-external" | "unspecified";
  maxOutputTokens: number | null;
  timeoutMs: number | null;
  retries: number;
}

/** The declared live call/token budget, preserved in the run artifacts. */
export interface DeclaredBudget {
  callBudget: number;
  tokenBudget: number;
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
  /** The declared live budget, when the run declared one; null otherwise. */
  budget: DeclaredBudget | null;
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
  /** Total prompt tokens when every call reported them; null otherwise. */
  inputTokens: number | null;
  /** Total cache-hit tokens when every call reported them; null when any call did not. */
  cachedInputTokens: number | null;
  /** Prompt tokens no call served from cache; null when the cache split is unknown. */
  uncachedInputTokens: number | null;
  outputTokens: number | null;
}

/** The declared live budget and what the run could verify about it; null when none was declared. */
export interface BudgetSummary extends DeclaredBudget {
  /** Model calls the run made against the declaration. */
  modelCalls: number;
  /** Prompt and completion tokens the run measured; null when any call left them unreported. */
  tokensUsed: number | null;
  /** Whether every call reported the input and output tokens the token budget needs. */
  usageComplete: boolean;
}

/** A stopping reason of an opt-in run that reached its declared budget. */
export type StoppingReason = "call-budget" | "token-budget";

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

/** A distribution of a measured count or length, with its sample count and total. */
export interface SampleSummary {
  samples: number;
  total: number;
  median: number | null;
  max: number | null;
}

/** What an environment could observe about the collection a run wrote to. */
export interface StorageObservation {
  /** Vectors in the collection's specialized index; null when the count is unavailable. */
  indexedVectors: number | null;
  /** Provider collection configuration read back from storage; null when unavailable. */
  configuration: JsonValue | null;
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
    /** Construction responses an insertion accepted; a rejected response is an insertion failure. */
    successfulConstruct: number;
    /** Evolution responses an insertion accepted before advancing past their validation. */
    successfulEvolve: number;
    totalSuccessful: number;
    /** The documented uninterrupted-run bound; null when the run did not insert every source. */
    upperBound: number | null;
    /** Whether the successful calls stayed within that bound; null when it does not apply. */
    withinBound: boolean | null;
    note: string;
  };
  retrieval: Record<string, ModeSummary>;
  usage: UsageSummary;
  cost: {
    /** Whether the exact documented cost was measurable from reported usage. */
    known: boolean;
    /** The cost from reported usage; null when it is not exactly measurable. */
    total: number | null;
    /** The highest cost consistent with reported usage when the cache split is unknown; else null. */
    upperBound: number | null;
    rates: CostRates | null;
    note: string;
  };
  /** The declared live budget and what the run verified about it; null when none was declared. */
  budget: BudgetSummary | null;
  /** What the run replayed, so a measure keeps the corpus and settings it belongs to. */
  context: {
    corpusNotes: number;
    encoderDimensions: number;
    sourceCharacters: {
      total: number;
      median: number | null;
      max: number | null;
    };
    /** The candidate neighbors the insertion phase selected, per insertion that had candidates. */
    neighbors: {
      insertionsWithCandidates: number;
      count: SampleSummary;
      characters: SampleSummary;
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
    /** Vectors the runtime collection actually held; null when the environment cannot report it. */
    indexedVectors: number | null;
    /** Provider configuration read back from the runtime collection; null when unavailable. */
    configuration: JsonValue | null;
    note: string;
  };
  timings: {
    /** Costs the host and the runner measured before the first insertion. */
    startup: {
      /** The host's embedder resolution, including cold encoder loading; null when unmeasured. */
      encoderLoadMs: number | null;
      /** The host's model transport setup; null when unmeasured. */
      modelSetupMs: number | null;
      /** Opening the runtime collection, including creation when it did not exist. */
      runtimeCollectionMs: number;
      /** Materializing the comparison baselines; null when retrieval evaluation was skipped. */
      baselineMaterializationMs: number | null;
    };
    insertions: {
      /** The first insertion, measured apart from the warm ones; not a cold-startup measure. */
      firstMs: number | null;
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
      { firstMs: number | null; warm: TimingSummary; all: TimingSummary }
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
  stoppingReason: StoppingReason | null;
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

/**
 * One run directory. JSONL artifacts are created empty and appended as the run proceeds; the
 * manifest, sources, notes, retrieval list and report are written once their content is known. A
 * run directory is never cleared or reused.
 */
export class RunArtifacts {
  readonly directory: string;
  readonly #manifestPath: string;
  readonly #credentials: readonly string[];

  private constructor(directory: string, credentials: readonly string[]) {
    this.directory = directory;
    this.#manifestPath = path.join(directory, "manifest.json");
    this.#credentials = [...credentials].sort((a, b) => b.length - a.length);
  }

  /** Sanitize only the serialized evidence, leaving transport, memory and measurement inputs intact. */
  #serialize(record: unknown, pretty = false): string {
    const redact = (text: string): string =>
      this.#credentials.reduce(
        (value, credential) => redactCredential(value, credential),
        text,
      );
    return `${JSON.stringify(
      record,
      (_key, value: unknown): unknown => {
        if (typeof value === "string") return redact(value);
        if (
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          // Unknown provider JSON and source metadata can also carry credentials in object keys.
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [redact(key), item]),
          );
        }
        return value;
      },
      pretty ? 2 : undefined,
    )}\n`;
  }

  #jsonl(records: readonly unknown[]): string {
    return records.map((record) => this.#serialize(record)).join("");
  }

  static async create(
    runsDirectory: string,
    manifest: RunManifest,
    credentials: readonly string[] = [],
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
    const artifacts = new RunArtifacts(directory, credentials);
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
      this.#serialize(manifest, true),
      "utf8",
    );
  }

  async appendModelCall(record: ModelCallRecord): Promise<void> {
    await appendFile(
      path.join(this.directory, "calls.jsonl"),
      this.#serialize(record),
      "utf8",
    );
  }

  async appendConstruction(record: ConstructionRecord): Promise<void> {
    await appendFile(
      path.join(this.directory, "construction.jsonl"),
      this.#serialize(record),
      "utf8",
    );
  }

  async appendChange(record: ChangeRecord): Promise<void> {
    await appendFile(
      path.join(this.directory, "changes.jsonl"),
      this.#serialize(record),
      "utf8",
    );
  }

  async writeSources(records: readonly SourceRecord[]): Promise<void> {
    await writeFile(
      path.join(this.directory, "sources.jsonl"),
      this.#jsonl(records),
      "utf8",
    );
  }

  async writeNotes(records: readonly FinalNoteRecord[]): Promise<void> {
    await writeFile(
      path.join(this.directory, "notes.jsonl"),
      this.#jsonl(records),
      "utf8",
    );
  }

  async writeRetrieval(records: readonly RetrievalRecord[]): Promise<void> {
    await writeFile(
      path.join(this.directory, "retrieval.jsonl"),
      this.#jsonl(records),
      "utf8",
    );
  }

  async writeReport(report: RunReport): Promise<void> {
    await writeFile(
      path.join(this.directory, "report.json"),
      this.#serialize(report, true),
      "utf8",
    );
  }
}
