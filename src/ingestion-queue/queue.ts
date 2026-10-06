/**
 * The durable ingestion queue: concurrent submissions committed to a local journal, source-key
 * deduplication, one worker per collection and durable restart recovery through persisted
 * insertion plans.
 *
 * See docs/ingestion-queue.md.
 */
import { z } from "zod";

import {
  ModelRequestError,
  type ModelFailureCategory,
} from "../language-model/index.js";
import {
  MemoryError,
  ModelResponseError,
  contextCorrectionInputSchema,
  insertionPlanSchema,
  representationVersion,
  type ContextCorrectionInput,
  type ContextCorrectionPreparer,
  type InsertionPlan,
  type PrepareInput,
} from "../memory/index.js";
import type { Note } from "../note-store/index.js";
import {
  legacyImportResultSchema,
  legacyReceiptSchema,
  queueBindingSchema,
  queueObservationSchema,
  queueReceiptSchema,
  queueReceiptPageSchema,
  queueRecoveryRequestSchema,
  queueRecoverySchema,
  queueStatusSchema,
  queueSubmissionSchema,
  reconcileOutcomeSchema,
  type LegacyImportResult,
  type LegacyReceipt,
  type QueueBinding,
  type QueueObservation,
  type QueueReceipt,
  type QueueReceiptPage,
  type QueueRecovery,
  type QueueRecoveryRequest,
  type QueueSubmission,
  type QueueStatus,
  type ReconcileOutcome,
} from "./contract.js";
import {
  QueueClosedError,
  QueueRequestError,
  QueueStateConflictError,
} from "./errors.js";
import {
  Journal,
  type JournalCorrectionFailure,
  type JournalFailure,
  type JournalRecord,
  type PendingCorrection,
} from "./journal.js";
import { openJournalPath } from "./journal-path.js";
import { WorkerLock } from "./worker-lock.js";

/** The subset of Memory's public contract the ingestion worker consumes. */
export interface MemoryPreparer {
  prepare(input: PrepareInput): Promise<InsertionPlan>;
  apply(plan: InsertionPlan): Promise<Note>;
}

/**
 * Host settings for one queue. The directory holds the durable journal and must live outside
 * temporary and task directories; the binding names the one collection this queue owns.
 */
export interface IngestionQueueOptions {
  readonly directory: string;
  readonly binding: QueueBinding;
  readonly memory: MemoryPreparer;
  /** How long an idle or waiting worker sleeps between polls; 1000 ms by default. */
  readonly pollIntervalMs?: number;
}

/**
 * One durable queue. Producers submit and look up receipts concurrently; the worker owns all
 * collection writes for the bound collection.
 */
export interface IngestionQueue {
  readonly binding: QueueBinding;
  /** The SQLite journal to back up together with the collection. */
  readonly journalPath: string;
  /**
   * Accept one observation after its durable commit, or return its existing receipt. The outcome
   * reports whether this call created the receipt.
   */
  submit(observation: QueueObservation): Promise<QueueSubmission>;
  /** Look up one receipt by identity; an unknown identity returns `undefined`. */
  receipt(id: string): Promise<QueueReceipt | undefined>;
  /**
   * One acceptance-sequence page of current receipts, defaulting to 100. The cursor is opaque and
   * journal-owned; an omitted next cursor completes traversal. Every outcome is included and no
   * source payload, provenance or plan is exposed.
   */
  pageReceipts(limit?: number, cursor?: string): Promise<QueueReceiptPage>;
  /** Current receipt outcomes, backlog and worker availability. */
  status(): Promise<QueueStatus>;
  /** Import preserved legacy receipts idempotently; no workspace scan is performed. */
  importLegacyReceipts(
    records: readonly LegacyReceipt[],
  ): Promise<LegacyImportResult>;
  /** Apply an operator decision to one blocked receipt. */
  reconcile(id: string, outcome: ReconcileOutcome): Promise<QueueReceipt>;
  /**
   * Return one failed receipt known not to have written to processing, after the cause was
   * corrected. An inspected `expectedAttemptCount` guards against stale and repeated requests.
   */
  recoverFailed(
    id: string,
    input: QueueRecoveryRequest,
  ): Promise<QueueRecovery>;
  /**
   * Prepare and apply exactly one reviewed context correction under exclusive writer ownership.
   * The committed plan replays before later ingestion after an interruption; ingestion cannot
   * drain while the correction is pending.
   */
  correctContext(
    input: ContextCorrectionInput,
    preparer: ContextCorrectionPreparer,
  ): Promise<{ note: Note; changed: boolean }>;
  /** Acquire worker ownership and drain durable pending work. */
  start(): Promise<void>;
  /** Stop claiming work, settle the active operation and release worker ownership. */
  stop(): Promise<void>;
  /** Stop the worker and close the journal; accepted but undrained work stays durable. */
  close(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Retry backoff bounds from docs/ingestion-queue.md#writer-lifecycle-and-retries. */
const RETRY_INITIAL_MS = 1_000;
const RETRY_LIMIT_MS = 60_000;

const optionsSchema = z.strictObject({
  directory: z.string().min(1, "A durable directory must be nonempty."),
  binding: queueBindingSchema,
  memory: z.custom<MemoryPreparer>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as MemoryPreparer).prepare === "function" &&
      typeof (value as MemoryPreparer).apply === "function",
    "The ingestion queue needs Memory's prepare and apply operations.",
  ),
  pollIntervalMs: z
    .int()
    .positive("The poll interval must be a positive safe integer.")
    .optional(),
});

/** A plan that cannot be applied as stored; only reconciliation can clear it. */
class QueuePlanError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "QueuePlanError";
    this.reason = reason;
  }
}

type FailureKind = "retry" | "failed" | "blocked";

interface FailureDecision {
  readonly kind: FailureKind;
  /** Whether the queue retries after its backoff, instead of waiting for reconciliation. */
  readonly retryAfterBackoff: boolean;
  /** A short, safe description; provider text never becomes a public diagnostic. */
  readonly reason: string;
}

/** Walk a bounded cause chain; provider wrappers often nest the real failure once or twice. */
const errorChain = (cause: unknown): readonly unknown[] => {
  const chain: unknown[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || current === undefined) {
      break;
    }
    chain.push(current);
    if (typeof current !== "object" || !("cause" in current)) {
      break;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
};

/** The HTTP status a provider failure carries, if any; it identifies credentials or storage. */
const providerStatus = (cause: unknown): number | undefined => {
  for (const link of errorChain(cause)) {
    if (typeof link !== "object" || link === null) {
      continue;
    }
    const record = link as Record<string, unknown>;
    for (const key of ["status", "statusCode", "httpStatus"]) {
      const value = record[key];
      if (typeof value === "number" && Number.isInteger(value)) {
        return value;
      }
    }
  }
  return undefined;
};

/**
 * The safe diagnostics of model-transport failure categories. They name the condition a caller must
 * correct without repeating provider text, which can echo credentials or source material.
 */
const MODEL_FAILURE_DECISIONS: Record<ModelFailureCategory, FailureDecision> = {
  authentication: {
    kind: "blocked",
    retryAfterBackoff: true,
    reason:
      "The model provider rejected the queue's credential, which must be corrected before this " +
      "observation can be processed.",
  },
  resource: {
    kind: "blocked",
    retryAfterBackoff: true,
    reason:
      "The model provider reports a missing model or resource, which must be corrected before " +
      "this observation can be processed.",
  },
  unavailable: {
    kind: "retry",
    retryAfterBackoff: true,
    reason: "A temporary model provider failure interrupted this observation.",
  },
  output: {
    kind: "failed",
    retryAfterBackoff: false,
    reason:
      "The model returned output the queue cannot use, so this observation failed permanently.",
  },
};

/** The failure category a model transport reported for the failed attempt, if any. */
const transportFailure = (cause: unknown): ModelRequestError | undefined => {
  for (const link of errorChain(cause)) {
    if (link instanceof ModelRequestError) {
      return link;
    }
  }
  return undefined;
};

/**
 * Classify one failed attempt. A model transport's machine-readable category decides the reaction
 * at the provider boundary: a rejected credential or missing resource blocks the queue until it is
 * corrected, unusable model output fails permanently, and a temporary outage is retried. Memory's
 * failure contract carries the rest: invalid source material and invalid model output fail
 * permanently, a rejected plan or binding needs reconciliation, and a write attempt or provider
 * failure is retried. A storage failure that reports an unauthorized, forbidden or missing resource
 * blocks the queue until it is corrected.
 */
const classifyFailure = (cause: unknown): FailureDecision => {
  if (cause instanceof QueuePlanError) {
    return { kind: "blocked", retryAfterBackoff: false, reason: cause.reason };
  }
  if (cause instanceof QueueStateConflictError) {
    // The queue owns this safe diagnostic; it names durable state that must settle first.
    return { kind: "blocked", retryAfterBackoff: false, reason: cause.reason };
  }
  const transport = transportFailure(cause);
  if (transport !== undefined) {
    return MODEL_FAILURE_DECISIONS[transport.category];
  }
  // An unauthorized, forbidden or missing resource is a credential or storage condition that
  // provider wrapping does not change; it blocks the queue rather than being retried as an outage.
  const status = providerStatus(cause);
  if (status === 401 || status === 403 || status === 404) {
    return {
      kind: "blocked",
      retryAfterBackoff: true,
      reason:
        "The storage or provider rejected the queue's credential or storage configuration, " +
        "which must be corrected before this observation can be processed.",
    };
  }
  if (cause instanceof MemoryError) {
    if (cause.operation === "prepare") {
      const invalidOutput = errorChain(cause).some(
        (link) => link instanceof ModelResponseError,
      );
      return cause.stage === "input" || invalidOutput
        ? { kind: "failed", retryAfterBackoff: false, reason: cause.reason }
        : { kind: "retry", retryAfterBackoff: true, reason: cause.reason };
    }
    if (cause.operation === "apply") {
      return cause.persistence === "uncertain"
        ? { kind: "retry", retryAfterBackoff: true, reason: cause.reason }
        : { kind: "blocked", retryAfterBackoff: false, reason: cause.reason };
    }
    return { kind: "retry", retryAfterBackoff: true, reason: cause.reason };
  }
  // Untrusted provider text can echo credentials or source material, so only the error's class
  // name is attached to the generic description.
  const base =
    "A temporary storage or provider failure interrupted this observation.";
  const name = cause instanceof Error ? cause.name : undefined;
  return {
    kind: "retry",
    retryAfterBackoff: true,
    reason: name === undefined || name === "Error" ? base : `${base} (${name})`,
  };
};

/** The delay before attempt `attempt` (1-based) is retried. */
const retryDelayMs = (attempt: number): number =>
  Math.min(RETRY_INITIAL_MS * 2 ** (Math.max(1, attempt) - 1), RETRY_LIMIT_MS);

const statusFor = (kind: FailureKind): JournalFailure["status"] =>
  kind === "retry" ? "retrying" : kind === "failed" ? "failed" : "blocked";

const toReceipt = (record: JournalRecord): QueueReceipt =>
  queueReceiptSchema.parse({
    id: record.receiptId,
    sourceKey: record.sourceKey,
    status: record.status,
    acceptedAt: record.acceptedAt,
    updatedAt: record.updatedAt,
    attemptCount: record.attemptCount,
    ...(record.nextRetryAt === undefined
      ? {}
      : { nextRetryAt: record.nextRetryAt }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    // A note identity is published only once the note is stored; acceptance is not searchability.
    ...(record.status === "stored" ? { noteId: record.noteId } : {}),
    ...(record.recoveries === undefined
      ? {}
      : { recoveries: record.recoveries }),
  });

/** Compare one plan with the queue's bound collection and the accepted note identity. */
const assertPlanBinding = (
  plan: InsertionPlan,
  binding: QueueBinding,
  noteId: string,
): void => {
  if (
    plan.representation !== representationVersion ||
    plan.embeddingSpace.id !== binding.embeddingSpace.id ||
    plan.embeddingSpace.dimensions !== binding.embeddingSpace.dimensions ||
    plan.embeddingSpace.distance !== binding.embeddingSpace.distance
  ) {
    throw new QueuePlanError(
      "The stored insertion plan was prepared for another representation or embedding space.",
    );
  }
  if (plan.noteId.toLowerCase() !== noteId.toLowerCase()) {
    throw new QueuePlanError(
      "The stored insertion plan belongs to another accepted note identity.",
    );
  }
};

/** Structural JSON equality, independent of object key order; undefined properties are ignored. */
const sameJson = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((element, index) => sameJson(element, right[index]))
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  const meaningful = (value: object): [string, unknown][] =>
    Object.entries(value).filter(([, nested]) => nested !== undefined);
  const rightEntries = new Map(meaningful(right));
  const leftEntries = meaningful(left);
  return (
    leftEntries.length === rightEntries.size &&
    leftEntries.every(
      ([key, value]) =>
        rightEntries.has(key) && sameJson(value, rightEntries.get(key)),
    )
  );
};

/**
 * Validate one prepared correction plan before its slot is committed: it satisfies the public
 * insertion-plan contract, belongs to this queue's binding and the inspected note, contains
 * exactly that one record with a vector matching its declared dimensions, and preserves the
 * inspected source fields and links. Only the reviewed semantic attributes may differ. A plan
 * the queue could not read back is refused here, so
 * invalid preparation never becomes durable evidence that blocks later work.
 */
const assertCorrectionPlan = (
  plan: InsertionPlan,
  binding: QueueBinding,
  expected: Note,
): void => {
  const parsed = insertionPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new QueueStateConflictError(
      "The prepared context correction plan does not satisfy the documented contract.",
    );
  }
  const correction = parsed.data;
  assertPlanBinding(correction, binding, expected.id);
  if (correction.records.length !== 1) {
    throw new QueueStateConflictError(
      "The prepared context correction plan must contain exactly one note record.",
    );
  }
  const record = correction.records[0];
  if (record?.vector.length !== correction.embeddingSpace.dimensions) {
    throw new QueueStateConflictError(
      "The prepared context correction vector does not match its declared embedding space.",
    );
  }
  const note = record?.note;
  if (
    note === undefined ||
    note.id.toLowerCase() !== expected.id.toLowerCase() ||
    note.content !== expected.content ||
    note.timestamp !== expected.timestamp ||
    !sameJson(note.metadata ?? null, expected.metadata ?? null) ||
    !sameJson(note.links, expected.links)
  ) {
    throw new QueueStateConflictError(
      "The prepared context correction does not preserve the inspected note's identity, " +
        "source fields and links.",
    );
  }
};

/** One queue's worker and journal. @see openIngestionQueue */
class DurableQueue implements IngestionQueue {
  readonly binding: QueueBinding;
  readonly journalPath: string;

  readonly #journal: Journal;
  readonly #memory: MemoryPreparer;
  readonly #pollIntervalMs: number;
  #worker: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  /**
   * Whether a stop was requested for the current or pending worker. Only `start()` clears it, so a
   * shutdown that arrives during acquisition cannot be lost, and a stopped worker never starts
   * claiming again.
   */
  #stopRequested = false;
  /** Ordering evidence: a start is cancelled by a stop issued after it, not by an earlier one. */
  #startEpoch = 0;
  #stopEpoch = 0;
  #closed = false;
  #wakeup: (() => void) | undefined;
  #workerError: string | undefined;

  constructor(
    journal: Journal,
    binding: QueueBinding,
    memory: MemoryPreparer,
    pollIntervalMs: number,
  ) {
    this.#journal = journal;
    this.journalPath = journal.path;
    this.binding = binding;
    this.#memory = memory;
    this.#pollIntervalMs = pollIntervalMs;
  }

  async submit(observation: QueueObservation): Promise<QueueSubmission> {
    this.#assertOpen();
    const parsed = queueObservationSchema.safeParse(observation);
    if (!parsed.success) {
      throw new QueueRequestError(
        "The observation is not a valid submission.",
        parsed.error,
      );
    }
    const { record, created } = await this.#journal.submit(
      parsed.data,
      new Date().toISOString(),
    );
    // New work should not wait for the next poll, but the submission never waits for the worker.
    this.#wake();
    return queueSubmissionSchema.parse({ ...toReceipt(record), created });
  }

  async receipt(id: string): Promise<QueueReceipt | undefined> {
    this.#assertOpen();
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) {
      return undefined;
    }
    const record = await this.#journal.byId(parsed.data);
    return record === undefined ? undefined : toReceipt(record);
  }

  async pageReceipts(limit = 100, cursor?: string): Promise<QueueReceiptPage> {
    this.#assertOpen();
    const parsedLimit = z
      .int()
      .positive("The receipt page limit must be a positive safe integer.")
      .safeParse(limit);
    if (!parsedLimit.success) {
      throw new QueueRequestError(
        "The receipt page limit must be a positive safe integer.",
        parsedLimit.error,
      );
    }
    const parsedCursor =
      cursor === undefined
        ? undefined
        : z
            .string()
            .min(1, "The receipt page cursor must be nonempty.")
            .safeParse(cursor);
    if (parsedCursor !== undefined && !parsedCursor.success) {
      throw new QueueRequestError(
        "The receipt page cursor is not valid.",
        parsedCursor.error,
      );
    }
    const page = await this.#journal.pageReceipts(
      parsedLimit.data,
      parsedCursor?.data,
    );
    return queueReceiptPageSchema.parse({
      receipts: page.records.map(toReceipt),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    });
  }

  async status(): Promise<QueueStatus> {
    this.#assertOpen();
    const [journalStatus, workerOwned] = await Promise.all([
      this.#journal.status(),
      WorkerLock.isWorkerRunning(this.journalPath),
    ]);
    const { counts, oldestPendingAt, pendingError, correction } = journalStatus;
    const accepted = Object.values(counts).reduce(
      (total, count) => total + count,
      0,
    );
    const backlog =
      counts.queued + counts.processing + counts.retrying + counts.blocked;
    const now = Date.now();
    // Receipt diagnostics belong to the journal, including global reconciliation blocks.
    // Only unexpected worker-lifecycle failures need a handle-local fallback.
    const lastError = pendingError ?? this.#workerError;
    return queueStatusSchema.parse({
      worker: workerOwned ? "running" : "stopped",
      accepted,
      backlog,
      counts,
      ...(oldestPendingAt === undefined ? {} : { oldestPendingAt }),
      ...(oldestPendingAt === undefined
        ? {}
        : {
            oldestPendingAgeMs: Math.max(0, now - Date.parse(oldestPendingAt)),
          }),
      ...(lastError === undefined ? {} : { lastError }),
      ...(correction === undefined ? {} : { contextCorrection: correction }),
    });
  }

  async importLegacyReceipts(
    records: readonly LegacyReceipt[],
  ): Promise<LegacyImportResult> {
    this.#assertOpen();
    const parsed = z.array(legacyReceiptSchema).safeParse(records);
    if (!parsed.success) {
      throw new QueueRequestError(
        "The legacy receipts are not valid import records.",
        parsed.error,
      );
    }
    // Migration and draining share exclusive ownership across all handles/processes. A probe
    // followed by an import would race startup or an in-flight application. Hold ownership
    // until the import commits, and refuse migration while a worker owns the queue.
    const lock = await WorkerLock.acquire(this.journalPath, "migration");
    try {
      this.#assertOpen();
      const result = await this.#journal.importLegacy(
        parsed.data,
        new Date().toISOString(),
      );
      return legacyImportResultSchema.parse(result);
    } finally {
      await lock.release();
    }
  }

  async reconcile(
    id: string,
    outcome: ReconcileOutcome,
  ): Promise<QueueReceipt> {
    this.#assertOpen();
    const parsedId = z.uuid().safeParse(id);
    if (!parsedId.success) {
      throw new QueueRequestError(
        "The receipt identity must be a UUID.",
        parsedId.error,
      );
    }
    const parsedOutcome = reconcileOutcomeSchema.safeParse(outcome);
    if (!parsedOutcome.success) {
      throw new QueueRequestError(
        "The reconciliation outcome is not valid.",
        parsedOutcome.error,
      );
    }
    const record = await this.#journal.reconcile(
      parsedId.data,
      parsedOutcome.data,
      new Date().toISOString(),
    );
    this.#wake();
    return toReceipt(record);
  }

  async recoverFailed(
    id: string,
    input: QueueRecoveryRequest,
  ): Promise<QueueRecovery> {
    this.#assertOpen();
    const parsedId = z.uuid().safeParse(id);
    if (!parsedId.success) {
      throw new QueueRequestError(
        "The receipt identity must be a UUID.",
        parsedId.error,
      );
    }
    const parsedInput = queueRecoveryRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new QueueRequestError(
        "The expected attempt count must be a nonnegative safe integer.",
        parsedInput.error,
      );
    }
    const { record, recovered } = await this.#journal.recoverFailed(
      parsedId.data,
      parsedInput.data.expectedAttemptCount,
      new Date().toISOString(),
    );
    if (recovered) {
      // Newly pending work should not wait for the next poll; the request never waits for it.
      this.#wake();
    }
    return queueRecoverySchema.parse({ receipt: toReceipt(record), recovered });
  }

  async correctContext(
    input: ContextCorrectionInput,
    preparer: ContextCorrectionPreparer,
  ): Promise<{ note: Note; changed: boolean }> {
    this.#assertOpen();
    const parsedInput = contextCorrectionInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new QueueRequestError(
        "The context correction input is not valid.",
        parsedInput.error,
      );
    }
    if (typeof preparer?.prepareContextCorrection !== "function") {
      throw new QueueRequestError(
        "The context correction needs a preparation capability.",
      );
    }
    // Maintenance takes the same canonical ownership as draining and import: no worker may drain
    // and no other maintenance operation may run while the reviewed change is prepared and
    // applied. Producers may still submit.
    const lock = await WorkerLock.acquire(this.journalPath, "correction");
    try {
      this.#assertOpen();
      const refusal = await this.#journal.correctionRefusal();
      if (refusal !== undefined) {
        throw new QueueStateConflictError(refusal);
      }
      const expected = parsedInput.data.expected;
      const preparation = await preparer.prepareContextCorrection(
        parsedInput.data,
      );
      if (preparation.plan === undefined) {
        if (preparation.note.id.toLowerCase() !== expected.id.toLowerCase()) {
          throw new QueueStateConflictError(
            "The correction preparation returned another note identity than the inspected one.",
          );
        }
        return { note: preparation.note, changed: false };
      }
      try {
        assertCorrectionPlan(preparation.plan, this.binding, expected);
      } catch (cause) {
        // A returned plan is caller-supplied input, not persisted journal evidence: its refusal
        // is a typed state conflict, never the internal blocked-plan diagnostic.
        if (cause instanceof QueuePlanError) {
          throw new QueueStateConflictError(cause.reason);
        }
        throw cause;
      }
      await this.#journal.saveCorrection(
        expected.id,
        JSON.stringify(preparation.plan),
        new Date().toISOString(),
      );
      const note = await this.#applyCorrection(expected.id);
      if (note === undefined) {
        const pending = await this.#journal.correction();
        throw new QueueStateConflictError(
          pending?.lastError ??
            "The context correction could not be applied; its committed plan remains pending.",
        );
      }
      return { note, changed: true };
    } finally {
      await lock.release();
    }
  }

  /**
   * Acquire worker ownership and drain durable pending work. Concurrent starts share one worker, and
   * a start that arrives while a stopped worker is still settling takes over once it released
   * ownership. A stop that was issued after this start cancels it.
   */
  async start(): Promise<void> {
    this.#assertOpen();
    const epoch = (this.#startEpoch += 1);
    for (;;) {
      const pending = this.#starting;
      if (pending !== undefined) {
        // Another caller already acquires ownership; a later start joins that acquisition.
        await pending.catch(() => undefined);
        continue;
      }
      const worker = this.#worker;
      if (worker === undefined) {
        break;
      }
      if (!this.#stopRequested) {
        // A worker already drains this queue.
        return;
      }
      await worker;
    }
    this.#assertOpen();
    if (epoch <= this.#stopEpoch) {
      // A stop issued after this start cancelled it before it owned anything.
      return;
    }
    this.#stopRequested = false;
    const starting = this.#acquireAndRun(epoch);
    this.#starting = starting;
    try {
      await starting;
    } finally {
      if (this.#starting === starting) {
        this.#starting = undefined;
      }
    }
  }

  /**
   * Stop claiming work, settle the active operation and release ownership. A stop that arrives
   * while ownership is still being acquired waits for that acquisition, so a shutdown never
   * returns while a worker could still start behind it; a start issued after the stop supersedes
   * it and owns the next worker.
   */
  async stop(): Promise<void> {
    this.#stopEpoch = this.#startEpoch;
    this.#stopRequested = true;
    this.#wake();
    const starting = this.#starting;
    const observed = this.#worker;
    if (starting !== undefined) {
      // A refused acquisition is not a stop failure: there was never a worker to stop.
      await starting.catch(() => undefined);
    }
    if (this.#startEpoch > this.#stopEpoch) {
      // A start issued after this stop superseded it and owns whatever runs now.
      return;
    }
    const worker = observed ?? this.#worker;
    if (worker !== undefined) {
      await worker;
    }
  }

  /**
   * Stop the worker and close the journal. Concurrent closes share one completion, and a close that
   * arrives during startup releases the ownership that startup acquired.
   */
  async close(): Promise<void> {
    if (this.#closing === undefined) {
      this.#closing = this.#close();
    }
    await this.#closing;
  }

  async #close(): Promise<void> {
    // A closed queue accepts nothing, and a pending acquisition must release its ownership.
    this.#closed = true;
    await this.stop();
    await this.#journal.close();
  }

  async #acquireAndRun(epoch: number): Promise<void> {
    // Ownership is taken before any durable work is claimed and released on process exit.
    const lock = await WorkerLock.acquire(this.journalPath);
    if (this.#closed) {
      await lock.release();
      throw new QueueClosedError();
    }
    if (this.#stopRequested || epoch <= this.#stopEpoch) {
      await lock.release();
      return;
    }
    // The worker loop reports its own failures through `status()`, so it never rejects; a
    // supervisor restarts it by calling `start()` again.
    this.#workerError = undefined;
    this.#worker = this.#runWorker(lock).finally(() => {
      this.#worker = undefined;
    });
  }

  /**
   * Poll for durable pending work and process the oldest unresolved receipt. A receipt that waits
   * for its retry time, or for reconciliation, keeps later observations behind it, and an
   * unresolved legacy uncertainty keeps every collection write waiting.
   */
  async #runWorker(lock: WorkerLock): Promise<void> {
    try {
      // A pending correction owns the collection state and is replayed before any observation
      // drains. A blocked slot is attempted once per worker start: correcting the configuration
      // and restarting is what resumes it, never a tight retry loop.
      let firstPass = true;
      while (!this.#stopRequested) {
        const correction = await this.#journal.correction();
        if (correction !== undefined) {
          const due =
            correction.nextRetryAt === undefined
              ? firstPass
              : Date.parse(correction.nextRetryAt) <= Date.now();
          firstPass = false;
          if (due) {
            await this.#applyCorrection(correction.noteId);
          } else {
            await this.#wait(this.#correctionWaitMs(correction));
          }
          continue;
        }
        firstPass = false;
        const unresolved = await this.#journal.unresolvedReconciliation();
        if (unresolved !== undefined) {
          // The legacy system may have written this observation, so no collection write may
          // proceed until an operator reconciles it, whatever its place in the drain order.
          await this.#wait(this.#pollIntervalMs);
          continue;
        }
        const pending = await this.#journal.nextPending();
        if (pending === undefined) {
          await this.#wait(this.#pollIntervalMs);
          continue;
        }
        if (pending.status === "blocked" && pending.nextRetryAt === undefined) {
          // The queue waits for an operator decision; later observations must not be written.
          await this.#wait(this.#pollIntervalMs);
          continue;
        }
        const remaining =
          pending.nextRetryAt === undefined
            ? 0
            : Date.parse(pending.nextRetryAt) - Date.now();
        if (remaining > 0) {
          await this.#wait(Math.min(remaining, this.#pollIntervalMs));
          continue;
        }
        // Selection crosses the journal thread; shutdown may have arrived while it was pending.
        if (this.#stopRequested) {
          break;
        }
        await this.#process(pending);
      }
    } catch (cause) {
      // A failure that stops the loop leaves pending work durable for a supervised restart.
      this.#workerError = classifyFailure(cause).reason;
    } finally {
      try {
        await lock.release();
      } catch (cause) {
        this.#workerError = classifyFailure(cause).reason;
      }
    }
  }

  /** Prepare if needed, then apply exactly one plan for one accepted observation. */
  async #process(pending: JournalRecord): Promise<void> {
    const claimed = await this.#journal.claim(
      pending.sequence,
      new Date().toISOString(),
    );
    if (claimed === undefined) {
      return;
    }
    try {
      const plan =
        claimed.plan !== undefined
          ? this.#readPlan(claimed)
          : claimed.planCommitted
            ? this.#missingPlan(claimed)
            : await this.#prepare(claimed);
      const note = await this.#memory.apply(plan);
      if (note.id.toLowerCase() !== claimed.noteId.toLowerCase()) {
        throw new QueuePlanError(
          "Applying the insertion plan produced another note identity than the accepted one.",
        );
      }
      await this.#journal.markStored(
        claimed.sequence,
        note.id,
        new Date().toISOString(),
      );
    } catch (cause) {
      const decision = classifyFailure(cause);
      const nextRetryAt = decision.retryAfterBackoff
        ? new Date(
            Date.now() + retryDelayMs(claimed.attemptCount),
          ).toISOString()
        : undefined;
      const diagnostic = decision.reason;
      await this.#journal.markFailure(
        claimed.sequence,
        {
          status: statusFor(decision.kind),
          nextRetryAt,
          lastError: diagnostic,
        },
        new Date().toISOString(),
      );
    }
  }

  /**
   * Apply the committed correction plan and clear its slot, recording the failure when it cannot.
   * Returns the acknowledged note, or `undefined` when the attempt failed and its evidence was
   * persisted for an exact replay. The same values, vector and update time are written again. A
   * journal failure that prevents recording the outcome leaves the slot pending without durable
   * evidence and reports that unconfirmed correction instead of a bare storage failure.
   */
  async #applyCorrection(noteId: string): Promise<Note | undefined> {
    const pending = await this.#journal.correction();
    if (pending === undefined) {
      throw new QueueStateConflictError(
        "The queue has no pending context correction.",
      );
    }
    let plan: InsertionPlan;
    try {
      plan = this.#readCorrectionPlan(pending);
    } catch (cause) {
      // Damaged committed-plan evidence blocks with a diagnostic; preparation is never repeated.
      const decision = classifyFailure(cause);
      await this.#recordCorrectionFailure(
        { nextRetryAt: undefined, lastError: decision.reason },
        noteId,
      );
      return undefined;
    }
    // Record the attempt before application, so a crash during the write keeps its accounting.
    let attempt: PendingCorrection;
    try {
      attempt = await this.#journal.beginCorrectionAttempt(
        new Date().toISOString(),
      );
    } catch (cause) {
      throw new QueueStateConflictError(
        `The context correction for note ${noteId} could not record its application ` +
          "attempt; the committed plan remains pending for exact replay.",
        cause,
      );
    }
    let note: Note;
    try {
      note = await this.#memory.apply(plan);
      if (note.id.toLowerCase() !== noteId.toLowerCase()) {
        throw new QueuePlanError(
          "Applying the context correction produced another note identity than the selected one.",
        );
      }
    } catch (cause) {
      const decision = classifyFailure(cause);
      await this.#recordCorrectionFailure(
        {
          // Only a transient application failure uses the bounded backoff. A blocking error has
          // no scheduled retry: the host corrects its configuration and restarts the worker.
          nextRetryAt:
            decision.kind === "retry"
              ? new Date(
                  Date.now() + retryDelayMs(attempt.attemptCount),
                ).toISOString()
              : undefined,
          lastError: decision.reason,
        },
        noteId,
      );
      return undefined;
    }
    try {
      await this.#journal.clearCorrection();
      return note;
    } catch {
      // The reviewed replacement is written but its durable completion is unconfirmed. The slot
      // stays, and the exact replay writes the same values, vector and update time.
      await this.#recordCorrectionFailure(
        {
          nextRetryAt: new Date(
            Date.now() + retryDelayMs(attempt.attemptCount),
          ).toISOString(),
          lastError:
            `The reviewed correction for note ${noteId} was applied but its durable ` +
            "completion could not be confirmed, so the committed plan must be replayed exactly.",
        },
        noteId,
      );
      return undefined;
    }
  }

  /**
   * Persist one failed attempt of the pending correction. The committed plan is the only replay
   * evidence, so a journal failure that prevents recording the outcome is reported as an
   * unconfirmed correction that must be replayed, never as a settled failure.
   */
  async #recordCorrectionFailure(
    failure: JournalCorrectionFailure,
    noteId: string,
  ): Promise<void> {
    try {
      await this.#journal.markCorrectionFailure(
        failure,
        new Date().toISOString(),
      );
    } catch (cause) {
      throw new QueueStateConflictError(
        `The context correction for note ${noteId} could not durably record its outcome; ` +
          "the committed plan remains pending and must be replayed exactly.",
        cause,
      );
    }
  }

  /**
   * Read the committed correction plan and validate it against this queue's binding and the
   * selected note identity. A missing, unreadable or incompatible plan is committed-plan evidence
   * that blocks instead of preparing a new correction.
   */
  #readCorrectionPlan(pending: PendingCorrection): InsertionPlan {
    if (pending.plan === undefined) {
      throw new QueuePlanError(
        `The committed context correction for note ${pending.noteId} has no stored plan, so ` +
          "the original application cannot be replayed.",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(pending.plan);
    } catch {
      throw new QueuePlanError(
        `The stored context correction plan for note ${pending.noteId} is unreadable.`,
      );
    }
    const parsed = insertionPlanSchema.safeParse(value);
    if (!parsed.success) {
      throw new QueuePlanError(
        `The stored context correction plan for note ${pending.noteId} does not satisfy the ` +
          "documented contract.",
      );
    }
    assertPlanBinding(parsed.data, this.binding, pending.noteId);
    if (
      parsed.data.records.length !== 1 ||
      parsed.data.records[0]?.note.id.toLowerCase() !==
        pending.noteId.toLowerCase()
    ) {
      throw new QueuePlanError(
        `The stored context correction for note ${pending.noteId} is not its one-record plan.`,
      );
    }
    return parsed.data;
  }

  /** How long to wait before reconsidering the pending correction slot. */
  #correctionWaitMs(correction: PendingCorrection): number {
    if (correction.nextRetryAt === undefined) {
      return this.#pollIntervalMs;
    }
    return Math.min(
      Math.max(0, Date.parse(correction.nextRetryAt) - Date.now()),
      this.#pollIntervalMs,
    );
  }

  /**
   * The receipt's preparation committed a plan, so a receipt without one lost it: a journal
   * restored from the wrong backup, or a damaged file. Regenerating would change the attributes,
   * neighbor updates and timestamps of an insertion the collection may already hold, so only
   * reconciliation clears it.
   */
  #missingPlan(receipt: JournalRecord): never {
    throw new QueuePlanError(
      `The insertion plan committed for receipt ${receipt.receiptId} is missing, so the ` +
        "original insertion cannot be replayed.",
    );
  }

  /** Prepare one plan and commit it durably before any note write is attempted. */
  async #prepare(receipt: JournalRecord): Promise<InsertionPlan> {
    const input: PrepareInput = {
      noteId: receipt.noteId,
      content: receipt.content,
      timestamp: receipt.timestamp,
      ...(receipt.provenance === undefined
        ? {}
        : { metadata: receipt.provenance }),
    };
    const plan = await this.#memory.prepare(input);
    assertPlanBinding(plan, this.binding, receipt.noteId);
    await this.#journal.savePlan(
      receipt.sequence,
      JSON.stringify(plan),
      new Date().toISOString(),
    );
    return plan;
  }

  /** Read and validate the plan committed before a crash so it is replayed exactly. */
  #readPlan(receipt: JournalRecord): InsertionPlan {
    let value: unknown;
    try {
      value = JSON.parse(receipt.plan ?? "null");
    } catch {
      throw new QueuePlanError(
        `The stored insertion plan for receipt ${receipt.receiptId} is unreadable.`,
      );
    }
    const parsed = insertionPlanSchema.safeParse(value);
    if (!parsed.success) {
      throw new QueuePlanError(
        `The stored insertion plan for receipt ${receipt.receiptId} does not satisfy the ` +
          "documented contract.",
      );
    }
    assertPlanBinding(parsed.data, this.binding, receipt.noteId);
    return parsed.data;
  }

  /** Wait for the poll interval, a producer's wake-up or a stop request, whichever comes first. */
  #wait(ms: number): Promise<void> {
    if (this.#stopRequested) {
      // A wait that starts after the stop must not lose the request, whatever interrupted the loop.
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        this.#wakeup = undefined;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.#wakeup = finish;
    });
  }

  #wake(): void {
    const wakeup = this.#wakeup;
    if (wakeup !== undefined) {
      this.#wakeup = undefined;
      wakeup();
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new QueueClosedError();
    }
  }
}

/**
 * Open or create the durable queue in its directory and verify the journal's binding. Submission
 * works before the worker starts; start it separately to drain accepted work. The directory and
 * file are resolved to their canonical identity, so a symlinked or relative name reaches the same
 * queue as the path it points to.
 */
export const openIngestionQueue = async (
  options: IngestionQueueOptions,
): Promise<IngestionQueue> => {
  const parsed = optionsSchema.parse(options);
  const journalPath = openJournalPath(parsed.directory);
  const journal = await Journal.open(journalPath, parsed.binding);
  return new DurableQueue(
    journal,
    parsed.binding,
    parsed.memory,
    parsed.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
};
