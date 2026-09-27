/**
 * Instrumentation of the host-supplied contracts during a replay: every model invocation, embedding
 * call and store operation is timed, and every acknowledged batch write is captured with the state
 * it replaced. The wrappers are consumers of the public contracts; they add observation only.
 *
 * See docs/evaluation.md#run-artifacts and docs/evaluation.md#performance-and-cost.
 */
import type {
  Embedder,
  EmbeddedNote,
  LanguageModel,
  Match,
  ModelRequest,
  Note,
  NoteStore,
  Page,
} from "../../src/index.js";
import { embeddingText } from "../../src/index.js";
import type {
  DeclaredBudget,
  ModelCallRecord,
  RunArtifacts,
  StoppingReason,
  TokenUsage,
} from "./artifacts.js";

/** One provider HTTP exchange observed by a recording fetch, when a live run supplies one. */
export interface ModelExchange {
  requestBody: string;
  responseBody: string;
  status: number;
  usage: TokenUsage | null;
  finishReason: string | null;
  requestId: string | null;
}

/** A cursor into the exchanges a host records, so each model call reads only its own exchanges. */
export interface ExchangeLog {
  index(): number;
  since(index: number): ModelExchange[];
}

/** A declared call/token budget that stops a live run instead of overspending. */
export type ModelBudget = DeclaredBudget;

/** Raised before a model call once the declared budget is exhausted. */
export class BudgetExhaustedError extends Error {
  readonly budgetReason: "call-budget" | "token-budget";

  constructor(budgetReason: "call-budget" | "token-budget", detail: string) {
    super(detail);
    this.name = "BudgetExhaustedError";
    this.budgetReason = budgetReason;
  }
}

/** What the recorder observed during one insertion. */
export interface InsertionCapture {
  sourceId: string;
  /** The parsed construction response, when the model returned one during this insertion. */
  constructResponse: unknown;
  /** The first embedding of the insertion: the constructed representation and its vector. */
  firstEmbedding: { text: string; vector: number[] } | null;
  /**
   * The candidates the insertion's candidate search returned: how many, and their total length under
   * the declared canonical serialization. Null when the insertion never reached candidate selection.
   */
  neighbors: { count: number; characters: number } | null;
  /** Batch writes with the current-note state each record replaced and their acknowledgment. */
  writes: Array<{
    acknowledged: boolean;
    changes: Array<{ noteId: string; before: Note | null; after: Note }>;
  }>;
}

/** Aggregates the report needs from the instrumentation; raw records already live in the files. */
export interface RecorderSummary {
  /** Every model invocation, whatever its outcome. */
  calls: {
    construct: number;
    evolve: number;
    total: number;
    failed: number;
    withUsage: number;
  };
  usage: {
    /** Whether every invocation reported input and output tokens and none failed. */
    known: boolean;
    /** Whether every invocation also reported its cache-hit tokens. */
    cachedKnown: boolean;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    /** Prompt and completion tokens the run measured; partial when `known` is false. */
    tokensUsed: number;
  };
  insertionDurations: number[];
  callDurations: { construct: number[]; evolve: number[] };
  embeddingDurations: {
    insertion: number[];
    materialization: number[];
    evaluation: number[];
  };
  storeDurations: {
    insertion: { put: number[]; nearest: number[]; get: number[] };
    evaluation: { put: number[]; nearest: number[]; get: number[] };
  };
}

const cloneNote = (note: Note): Note => structuredClone(note);

/**
 * Records the evidence of one replay. The runner marks the insertion boundaries; the wrappers
 * report what each call did. Reads never create change records, and a prepared write is not a
 * snapshot until the store acknowledges it.
 */
export class ReplayRecorder {
  readonly #artifacts: RunArtifacts;
  readonly #recordRawExchanges: boolean;
  readonly budget: ModelBudget | null;
  readonly #known = new Map<string, Note>();
  #insertion: InsertionCapture | null = null;
  /** Model calls of the open insertion, written once its note identity is known. */
  #pendingCalls: ModelCallRecord[] = [];
  #phase: "insertion" | "materialization" | "evaluation" = "evaluation";
  #nextCallId = 1;
  #calls: RecorderSummary["calls"] = {
    construct: 0,
    evolve: 0,
    total: 0,
    failed: 0,
    withUsage: 0,
  };
  #usage = {
    known: true,
    cachedKnown: true,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    tokensUsed: 0,
  };
  #insertionDurations: number[] = [];
  readonly #callDurations = {
    construct: [] as number[],
    evolve: [] as number[],
  };
  readonly #embeddingDurations = {
    insertion: [] as number[],
    materialization: [] as number[],
    evaluation: [] as number[],
  };
  readonly #storeDurations = {
    insertion: {
      put: [] as number[],
      nearest: [] as number[],
      get: [] as number[],
    },
    evaluation: {
      put: [] as number[],
      nearest: [] as number[],
      get: [] as number[],
    },
  };
  #budgetState: { reason: StoppingReason; detail: string } | null = null;

  constructor(
    artifacts: RunArtifacts,
    options: { recordRawExchanges: boolean; budget?: ModelBudget | null },
  ) {
    this.#artifacts = artifacts;
    this.#recordRawExchanges = options.recordRawExchanges;
    this.budget = options.budget ?? null;
  }

  /** Start observing one insertion; insertions on one instance are serialized by the library. */
  beginInsertion(sourceId: string): void {
    if (this.#insertion !== null) {
      throw new Error(
        `The insertion "${this.#insertion.sourceId}" is still open; replays insert one at a time.`,
      );
    }
    this.#phase = "insertion";
    this.#insertion = {
      sourceId,
      constructResponse: null,
      firstEmbedding: null,
      neighbors: null,
      writes: [],
    };
  }

  /**
   * Finish observing one insertion, write its model calls with the note identity when known, and
   * hand its capture to the runner.
   */
  async endInsertion(
    durationMs: number,
    noteId: string | null,
  ): Promise<InsertionCapture> {
    const capture = this.#insertion;
    if (capture === null) {
      throw new Error("No insertion is open.");
    }
    this.#insertion = null;
    this.#insertionDurations.push(durationMs);
    const pending = this.#pendingCalls;
    this.#pendingCalls = [];
    for (const call of pending) {
      await this.#artifacts.appendModelCall({ ...call, noteId });
    }
    return capture;
  }

  /** Materializing a baseline embeds notes; it is measured apart from the query searches. */
  beginMaterialization(): void {
    this.#phase = "materialization";
  }

  /** Retrieval and comparison work makes no model call, so it is observed on its own. */
  beginEvaluation(): void {
    this.#phase = "evaluation";
  }

  /** The budget stopping reason, once a call exceeded the declared budget. */
  budgetState(): StoppingReason | null {
    return this.#budgetState?.reason ?? null;
  }

  /** The explanation of the recorded budget state, when one exists. */
  budgetDetail(): string | null {
    return this.#budgetState?.detail ?? null;
  }

  summary(): RecorderSummary {
    return {
      calls: { ...this.#calls },
      usage: {
        known: this.#usage.known,
        cachedKnown: this.#usage.cachedKnown,
        inputTokens: this.#usage.inputTokens,
        cachedInputTokens: this.#usage.cachedInputTokens,
        outputTokens: this.#usage.outputTokens,
        tokensUsed: this.#usage.tokensUsed,
      },
      insertionDurations: [...this.#insertionDurations],
      callDurations: {
        construct: [...this.#callDurations.construct],
        evolve: [...this.#callDurations.evolve],
      },
      embeddingDurations: {
        insertion: [...this.#embeddingDurations.insertion],
        materialization: [...this.#embeddingDurations.materialization],
        evaluation: [...this.#embeddingDurations.evaluation],
      },
      storeDurations: {
        insertion: {
          put: [...this.#storeDurations.insertion.put],
          nearest: [...this.#storeDurations.insertion.nearest],
          get: [...this.#storeDurations.insertion.get],
        },
        evaluation: {
          put: [...this.#storeDurations.evaluation.put],
          nearest: [...this.#storeDurations.evaluation.nearest],
          get: [...this.#storeDurations.evaluation.get],
        },
      },
    };
  }

  /** Refuse the next model call once a budget is spent. */
  assertBudget(): void {
    const state = this.#budgetState;
    if (state !== null) {
      throw new BudgetExhaustedError(state.reason, state.detail);
    }
    const budget = this.budget;
    if (budget !== null && this.#calls.total >= budget.callBudget) {
      this.#budgetState = {
        reason: "call-budget",
        detail: `The live run stopped after ${String(budget.callBudget)} model calls.`,
      };
      throw new BudgetExhaustedError(
        this.#budgetState.reason,
        this.#budgetState.detail,
      );
    }
  }

  /** Record one model call: aggregate it now, write it with the note identity of its insertion. */
  async recordModelCall(record: ModelCallRecord): Promise<void> {
    this.#calls[record.stage] += 1;
    this.#calls.total += 1;
    this.#callDurations[record.stage].push(record.durationMs);
    if (record.error !== null) {
      this.#calls.failed += 1;
      // A failed attempt may still have been billed; leave the run totals unknown.
      this.#usage.known = false;
      this.#usage.cachedKnown = false;
    }
    const capture = this.#insertion;
    if (
      capture !== null &&
      record.stage === "construct" &&
      record.error === null
    ) {
      capture.constructResponse = record.response;
    }
    if (capture === null) {
      await this.#artifacts.appendModelCall(record);
    } else {
      // The note identity is known only when the insertion resolves; flush the calls then.
      this.#pendingCalls.push(record);
    }
    this.#observeUsage(record);
  }

  /**
   * Fold one call's reported usage into the run totals and apply the declared token budget. A
   * successful call that does not report the input and output tokens cannot be measured, so a
   * declared token budget stops the run instead of silently continuing beyond an unknown total.
   */
  #observeUsage(record: ModelCallRecord): void {
    const budget = this.budget;
    if (record.usage === null) {
      if (record.error === null) {
        this.#usage.known = false;
        this.#usage.cachedKnown = false;
        if (budget !== null) {
          this.#exhaustTokenBudget(
            `The ${record.stage} call did not report token usage, so the declared ` +
              `${String(budget.tokenBudget)}-token budget cannot be verified.`,
          );
        }
      }
      return;
    }
    this.#calls.withUsage += 1;
    const input = record.usage.inputTokens;
    const cached = record.usage.cachedInputTokens;
    const output = record.usage.outputTokens;
    if (input === null) {
      this.#usage.known = false;
    } else {
      this.#usage.inputTokens += input;
    }
    if (output === null) {
      this.#usage.known = false;
    } else {
      this.#usage.outputTokens += output;
    }
    if (cached === null) {
      // The total is measured, but the split between cached and uncached input stays unknown.
      this.#usage.cachedKnown = false;
    } else {
      this.#usage.cachedInputTokens += cached;
    }
    if (input === null || output === null) {
      if (budget !== null && record.error === null) {
        this.#exhaustTokenBudget(
          `The ${record.stage} call reported no ${input === null ? "input" : "output"} tokens, so ` +
            `the declared ${String(budget.tokenBudget)}-token budget cannot be verified.`,
        );
      }
      return;
    }
    this.#usage.tokensUsed += input + output;
    if (budget !== null && this.#usage.tokensUsed >= budget.tokenBudget) {
      this.#exhaustTokenBudget(
        `The run used ${String(this.#usage.tokensUsed)} tokens, reaching its declared ` +
          `${String(budget.tokenBudget)}-token budget.`,
      );
    }
  }

  /** Record the first budget state the run reaches; a later call must not replace its reason. */
  #exhaustTokenBudget(detail: string): void {
    if (this.#budgetState === null) {
      this.#budgetState = { reason: "token-budget", detail };
    }
  }

  /** Record one embedding call and the vector it returned. */
  async recordEmbedding(input: {
    text: string;
    vector: number[];
    durationMs: number;
  }): Promise<void> {
    this.#embeddingDurations[this.#phase].push(input.durationMs);
    const capture = this.#insertion;
    if (
      this.#phase === "insertion" &&
      capture !== null &&
      capture.firstEmbedding === null
    ) {
      capture.firstEmbedding = {
        text: input.text,
        vector: [...input.vector],
      };
    }
  }

  recordStoreOperation(
    operation: "put" | "nearest" | "get",
    durationMs: number,
    matches?: readonly Match[],
  ): void {
    const bucket = this.#phase === "insertion" ? "insertion" : "evaluation";
    this.#storeDurations[bucket][operation].push(durationMs);
    const capture = this.#insertion;
    if (
      operation === "nearest" &&
      this.#phase === "insertion" &&
      capture !== null &&
      capture.neighbors === null
    ) {
      const candidates = matches ?? [];
      capture.neighbors = {
        count: candidates.length,
        characters: candidates.reduce(
          (total, candidate) => total + embeddingText(candidate.note).length,
          0,
        ),
      };
    }
  }

  /**
   * Capture an acknowledged batch write. The current-note state comes from the writes this replay
   * already acknowledged, so no extra read is needed and a failed attempt records nothing.
   */
  recordAcknowledgedWrite(records: readonly EmbeddedNote[]): void {
    const capture = this.#insertion;
    if (capture === null) {
      return;
    }
    const changes = records.map((record) => {
      const identity = record.note.id.toLowerCase();
      const before = this.#known.get(identity);
      return {
        noteId: record.note.id,
        before: before === undefined ? null : cloneNote(before),
        after: cloneNote(record.note),
      };
    });
    for (const record of records) {
      this.#known.set(record.note.id.toLowerCase(), cloneNote(record.note));
    }
    capture.writes.push({ acknowledged: true, changes });
  }

  /**
   * Capture a rejected write attempt: the records Memory prepared stay reviewable, but a change
   * record never presents them as committed.
   */
  recordRejectedWrite(records: readonly EmbeddedNote[]): void {
    const capture = this.#insertion;
    if (capture === null) {
      return;
    }
    capture.writes.push({
      acknowledged: false,
      changes: records.map((record) => {
        const identity = record.note.id.toLowerCase();
        const before = this.#known.get(identity);
        return {
          noteId: record.note.id,
          before: before === undefined ? null : cloneNote(before),
          after: cloneNote(record.note),
        };
      }),
    });
  }

  nextCallId(): number {
    const callId = this.#nextCallId;
    this.#nextCallId += 1;
    return callId;
  }

  get recordRawExchanges(): boolean {
    return this.#recordRawExchanges;
  }

  get activeSourceId(): string | null {
    return this.#insertion?.sourceId ?? null;
  }
}

const now = (): number => performance.now();

/** Wrap an embedder so every call records its text, vector and duration. */
export const instrumentEmbedder = (
  embedder: Embedder,
  recorder: ReplayRecorder,
): Embedder => ({
  space: embedder.space,
  async embed(text: string): Promise<number[]> {
    const started = now();
    const vector = await embedder.embed(text);
    await recorder.recordEmbedding({
      text,
      vector,
      durationMs: now() - started,
    });
    return vector;
  },
});

const failureRecord = (cause: unknown): { name: string; message: string } => {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return { name: "Error", message: String(cause) };
};

const lastOf = <T>(values: readonly T[]): T | undefined =>
  values.length === 0 ? undefined : values[values.length - 1];

/**
 * Wrap a language model so every invocation, including a failed one, is recorded with its duration,
 * parsed response and, when the host records exchanges, its raw provider body, usage and finish
 * reason. The declared budget is checked before the call and after the response is measured.
 */
export const instrumentModel = (
  model: LanguageModel,
  recorder: ReplayRecorder,
  options: { exchanges?: ExchangeLog | null } = {},
): LanguageModel => {
  const exchanges = options.exchanges ?? null;
  return {
    async generate(request: ModelRequest): Promise<unknown> {
      recorder.assertBudget();
      const callId = recorder.nextCallId();
      const sourceId = recorder.activeSourceId;
      const exchangeStart = exchanges?.index() ?? 0;
      const started = now();
      let response: unknown = null;
      let failure: unknown;
      let failed = false;
      try {
        response = await model.generate(request);
      } catch (cause) {
        failure = cause;
        failed = true;
      }
      const durationMs = now() - started;
      const exchange = lastOf(exchanges?.since(exchangeStart) ?? []);
      const raw = recorder.recordRawExchanges;
      await recorder.recordModelCall({
        callId,
        stage: request.stage,
        sourceId,
        noteId: null,
        request: raw ? request.prompt : null,
        response: response === undefined ? null : response,
        rawResponse: raw ? (exchange?.responseBody ?? null) : null,
        error: failed ? failureRecord(failure) : null,
        durationMs,
        finishReason: exchange?.finishReason ?? null,
        usage: exchange?.usage ?? null,
        requestId: exchange?.requestId ?? null,
      });
      if (failed) {
        throw failure;
      }
      return response;
    },
  };
};

/**
 * Wrap a note store so its write acknowledgments and operation durations are observed. Reads pass
 * through unchanged; only an acknowledged write can create a change record.
 */
export const instrumentStore = (
  store: NoteStore,
  recorder: ReplayRecorder,
): NoteStore => ({
  async put(records: EmbeddedNote[]): Promise<void> {
    const prepared = structuredClone(records);
    const started = now();
    try {
      await store.put(records);
    } catch (cause) {
      // The prepared batch stays reviewable even though the store never acknowledged it.
      recorder.recordRejectedWrite(prepared);
      throw cause;
    }
    recorder.recordStoreOperation("put", now() - started);
    recorder.recordAcknowledgedWrite(prepared);
  },
  async get(ids: string[]): Promise<Note[]> {
    const started = now();
    const notes = await store.get(ids);
    recorder.recordStoreOperation("get", now() - started);
    return notes;
  },
  async nearest(vector: number[], limit: number): Promise<Match[]> {
    const started = now();
    const matches = await store.nearest(vector, limit);
    recorder.recordStoreOperation("nearest", now() - started, matches);
    return matches;
  },
  async page(limit: number, cursor?: string | number): Promise<Page> {
    const started = now();
    const page = await store.page(limit, cursor);
    recorder.recordStoreOperation("get", now() - started);
    return page;
  },
});
