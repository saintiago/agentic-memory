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
  insertionPlanSchema,
  representationVersion,
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
  queueStatusSchema,
  reconcileOutcomeSchema,
  type LegacyImportResult,
  type LegacyReceipt,
  type QueueBinding,
  type QueueObservation,
  type QueueReceipt,
  type QueueStatus,
  type ReconcileOutcome,
} from "./contract.js";
import { QueueClosedError, QueueRequestError } from "./errors.js";
import { Journal, type JournalFailure, type JournalRecord } from "./journal.js";
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
  /** Accept one observation after its durable commit, or return its existing receipt. */
  submit(observation: QueueObservation): Promise<QueueReceipt>;
  /** Look up one receipt by identity; an unknown identity returns `undefined`. */
  receipt(id: string): Promise<QueueReceipt | undefined>;
  /** Current receipt outcomes, backlog and worker availability. */
  status(): Promise<QueueStatus>;
  /** Import preserved legacy receipts idempotently; no workspace scan is performed. */
  importLegacyReceipts(
    records: readonly LegacyReceipt[],
  ): Promise<LegacyImportResult>;
  /** Apply an operator decision to one blocked receipt. */
  reconcile(id: string, outcome: ReconcileOutcome): Promise<QueueReceipt>;
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

  async submit(observation: QueueObservation): Promise<QueueReceipt> {
    this.#assertOpen();
    const parsed = queueObservationSchema.safeParse(observation);
    if (!parsed.success) {
      throw new QueueRequestError(
        "The observation is not a valid submission.",
        parsed.error,
      );
    }
    const record = await this.#journal.submit(
      parsed.data,
      new Date().toISOString(),
    );
    // New work should not wait for the next poll, but the submission never waits for the worker.
    this.#wake();
    return toReceipt(record);
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

  async status(): Promise<QueueStatus> {
    this.#assertOpen();
    const [journalStatus, workerOwned] = await Promise.all([
      this.#journal.status(),
      WorkerLock.isWorkerRunning(this.journalPath),
    ]);
    const { counts, oldestPendingAt, pendingError } = journalStatus;
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
      while (!this.#stopRequested) {
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
