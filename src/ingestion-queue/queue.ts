/**
 * The durable ingestion queue: concurrent submissions committed to a local journal, source-key
 * deduplication, one worker per collection and durable restart recovery through persisted
 * insertion plans.
 *
 * See docs/ingestion-queue.md.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

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
import {
  Journal,
  journalFileName,
  type JournalFailure,
  type JournalRecord,
} from "./journal.js";
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
 * Classify one failed attempt. Memory's failure contract carries most of the decision: invalid
 * source material and invalid model output fail permanently, a rejected plan or binding needs
 * reconciliation, and a write attempt or provider failure is retried. A provider failure that
 * reports an unauthorized, forbidden or missing resource blocks the queue until it is corrected.
 */
const classifyFailure = (cause: unknown): FailureDecision => {
  if (cause instanceof QueuePlanError) {
    return { kind: "blocked", retryAfterBackoff: false, reason: cause.reason };
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
  #stopping = false;
  #closed = false;
  #wakeup: (() => void) | undefined;
  #lastError: string | undefined;

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
    const record = this.#journal.submit(parsed.data, new Date().toISOString());
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
    const record = this.#journal.byId(parsed.data);
    return record === undefined ? undefined : toReceipt(record);
  }

  async status(): Promise<QueueStatus> {
    this.#assertOpen();
    const { counts, oldestPendingAt } = this.#journal.status();
    const accepted = Object.values(counts).reduce(
      (total, count) => total + count,
      0,
    );
    const backlog =
      counts.queued + counts.processing + counts.retrying + counts.blocked;
    const now = Date.now();
    return queueStatusSchema.parse({
      worker: this.#worker === undefined ? "stopped" : "running",
      accepted,
      backlog,
      counts,
      ...(oldestPendingAt === undefined ? {} : { oldestPendingAt }),
      ...(oldestPendingAt === undefined
        ? {}
        : {
            oldestPendingAgeMs: Math.max(0, now - Date.parse(oldestPendingAt)),
          }),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
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
    const result = this.#journal.importLegacy(
      parsed.data,
      new Date().toISOString(),
    );
    if (result.imported > 0) {
      this.#wake();
    }
    return legacyImportResultSchema.parse(result);
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
    const record = this.#journal.reconcile(
      parsedId.data,
      parsedOutcome.data,
      new Date().toISOString(),
    );
    this.#wake();
    return toReceipt(record);
  }

  async start(): Promise<void> {
    this.#assertOpen();
    if (this.#worker !== undefined) {
      return;
    }
    if (this.#starting === undefined) {
      this.#starting = this.#acquireAndRun();
    }
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async stop(): Promise<void> {
    const worker = this.#worker;
    if (worker === undefined) {
      return;
    }
    this.#stopping = true;
    this.#wake();
    await worker;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    await this.stop();
    this.#closed = true;
    this.#journal.close();
  }

  async #acquireAndRun(): Promise<void> {
    // Ownership is taken before any durable work is claimed and released on process exit.
    const lock = await WorkerLock.acquire(this.journalPath);
    this.#stopping = false;
    if (this.#closed) {
      await lock.release();
      throw new QueueClosedError();
    }
    // The worker loop reports its own failures through `status()`, so it never rejects; a
    // supervisor restarts it by calling `start()` again.
    this.#worker = this.#runWorker(lock).finally(() => {
      this.#worker = undefined;
    });
  }

  /**
   * Poll for durable pending work and process the oldest unresolved receipt. A receipt that waits
   * for its retry time, or for reconciliation, keeps later observations behind it.
   */
  async #runWorker(lock: WorkerLock): Promise<void> {
    try {
      while (!this.#stopping) {
        const pending = this.#journal.nextPending();
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
        await this.#process(pending);
      }
    } catch (cause) {
      // A failure that stops the loop leaves pending work durable for a supervised restart.
      this.#lastError = classifyFailure(cause).reason;
    } finally {
      this.#stopping = false;
      try {
        await lock.release();
      } catch (cause) {
        this.#lastError = classifyFailure(cause).reason;
      }
    }
  }

  /** Prepare if needed, then apply exactly one plan for one accepted observation. */
  async #process(pending: JournalRecord): Promise<void> {
    const claimed = this.#journal.claim(
      pending.sequence,
      new Date().toISOString(),
    );
    try {
      const plan =
        claimed.plan === undefined
          ? await this.#prepare(claimed)
          : this.#readPlan(claimed);
      const note = await this.#memory.apply(plan);
      if (note.id.toLowerCase() !== claimed.noteId.toLowerCase()) {
        throw new QueuePlanError(
          "Applying the insertion plan produced another note identity than the accepted one.",
        );
      }
      this.#journal.markStored(
        claimed.sequence,
        note.id,
        new Date().toISOString(),
      );
      this.#lastError = undefined;
    } catch (cause) {
      const decision = classifyFailure(cause);
      const nextRetryAt = decision.retryAfterBackoff
        ? new Date(
            Date.now() + retryDelayMs(claimed.attemptCount),
          ).toISOString()
        : undefined;
      const diagnostic = decision.reason;
      this.#journal.markFailure(
        claimed.sequence,
        {
          status: statusFor(decision.kind),
          nextRetryAt,
          lastError: diagnostic,
        },
        new Date().toISOString(),
      );
      this.#lastError = diagnostic;
    }
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
    this.#journal.savePlan(
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

  #wait(ms: number): Promise<void> {
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
 * works before the worker starts; start it separately to drain accepted work.
 */
export const openIngestionQueue = async (
  options: IngestionQueueOptions,
): Promise<IngestionQueue> => {
  const parsed = optionsSchema.parse(options);
  mkdirSync(parsed.directory, { recursive: true });
  const journalPath = path.join(parsed.directory, journalFileName);
  const journal = Journal.open(journalPath, parsed.binding);
  return new DurableQueue(
    journal,
    parsed.binding,
    parsed.memory,
    parsed.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
};
