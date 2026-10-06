/**
 * The queue's journal client: durable acceptance, drain order, receipt state, persisted insertion
 * plans and legacy migration. Every durable operation runs on the journal thread
 * (journal-worker.ts), so a slow commit or a contended write lock never blocks a producer's event
 * loop. This module owns the public record types, the request protocol and the typed failures a
 * caller receives.
 *
 * See docs/ingestion-queue.md#durable-acceptance-and-ordering and #crash-recovery.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { representationVersion } from "../memory/index.js";
import type {
  LegacyImportResult,
  LegacyReceipt,
  QueueBinding,
  QueueObservation,
  ReconcileOutcome,
} from "./contract.js";
import {
  QueueBindingError,
  QueueConflictError,
  QueueReceiptNotFoundError,
  QueueRequestError,
  QueueStateConflictError,
  QueueWorkerLockedError,
} from "./errors.js";
import { WorkerLock } from "./worker-lock.js";
import type {
  ExpectedJournalMetadata,
  JournalCorrectionFailure,
  JournalFailure,
  JournalFailureReport,
  JournalOperation,
  JournalRecord,
  JournalResponse,
  JournalStatus,
  PendingCorrection,
} from "./journal-protocol.js";

export type {
  JournalCorrectionFailure,
  JournalFailure,
  JournalRecord,
  JournalStatus,
  PendingCorrection,
};

/** The journal schema this build can reopen. */
const JOURNAL_VERSION = 3;

/**
 * The journal thread module: the TypeScript source while the library runs from source, and the
 * compiled JavaScript in the built package.
 */
const journalThreadUrl = (): URL => {
  const source = new URL("./journal-worker.ts", import.meta.url);
  return existsSync(fileURLToPath(source))
    ? source
    : new URL("./journal-worker.js", import.meta.url);
};

/** Turn one failure report of the journal thread into the queue's typed error. */
const reviveFailure = (
  failure: JournalFailureReport,
  journalPath: string,
): Error => {
  switch (failure.kind) {
    case "conflict":
      return new QueueConflictError(failure.sourceKey);
    case "state":
      return new QueueStateConflictError(failure.reason);
    case "notFound":
      return new QueueReceiptNotFoundError(failure.receiptId);
    case "binding":
      return new QueueBindingError(journalPath, failure.reason);
    case "request":
      return new QueueRequestError(failure.reason);
    case "storage": {
      const cause = new Error(failure.message);
      cause.name = failure.name;
      return cause;
    }
  }
};

/** One outstanding journal operation, waiting for its reply. */
interface PendingOperation {
  resolve(result: unknown): void;
  reject(cause: unknown): void;
}

/**
 * The message channel to one journal thread: request correlation, typed failure revival and the
 * shutdown that releases the thread with its SQLite connection.
 */
class JournalChannel {
  readonly #path: string;
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingOperation>();
  #nextId = 1;
  #closed = false;
  #stopped: Error | undefined;

  private constructor(path: string, worker: Worker) {
    this.#path = path;
    this.#worker = worker;
    worker.on("message", (message: JournalResponse) => {
      this.#receive(message);
    });
    worker.on("error", (cause: unknown) => {
      this.#stop(
        cause instanceof Error
          ? cause
          : new Error(`The queue journal thread failed: ${String(cause)}`),
      );
    });
    worker.on("exit", () => {
      this.#stop(new Error("The queue journal thread stopped."));
    });
  }

  /** Start a journal thread and open its journal, or release the thread again. */
  static async open(
    path: string,
    expected: ExpectedJournalMetadata,
  ): Promise<{ channel: JournalChannel; upgradeRequired: boolean }> {
    const channel = new JournalChannel(path, new Worker(journalThreadUrl()));
    try {
      const state = await channel.request<{ upgradeRequired: boolean }>({
        operation: "open",
        path,
        expected,
      });
      return { channel, upgradeRequired: state.upgradeRequired };
    } catch (cause) {
      await channel.#worker.terminate();
      throw cause;
    }
  }

  /** Run one journal operation and await its durable result. */
  request<Result>(operation: JournalOperation): Promise<Result> {
    const stopped = this.#stopped;
    if (stopped !== undefined) {
      return Promise.reject(stopped);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage({ id, ...operation });
      } catch (cause) {
        this.#pending.delete(id);
        reject(cause);
      }
    }) as Promise<Result>;
  }

  /** Close the journal and let the thread exit; a thread that already stopped is settled. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.request({ operation: "close" });
    } catch {
      // A thread that already stopped released its connection with it.
    }
    // The reply proved the connection is closed, so the thread must not hold the process open.
    this.#worker.unref();
  }

  #receive(message: JournalResponse): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.id);
    if ("failure" in message) {
      pending.reject(reviveFailure(message.failure, this.#path));
      return;
    }
    pending.resolve(message.result);
  }

  #stop(cause: Error): void {
    const stopped = (this.#stopped ??= cause);
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(stopped);
    }
  }
}

/** Current receipt state of one durable queue journal. */
export class Journal {
  readonly path: string;
  readonly #channel: JournalChannel;
  #closed = false;

  private constructor(path: string, channel: JournalChannel) {
    this.path = path;
    this.#channel = channel;
  }

  /** Open or create the journal on its own thread and reject a journal bound to another queue. */
  static async open(path: string, binding: QueueBinding): Promise<Journal> {
    const expected: ExpectedJournalMetadata = {
      journalVersion: String(JOURNAL_VERSION),
      representation: representationVersion,
      binding: binding as unknown as ExpectedJournalMetadata["binding"],
    };
    const { channel, upgradeRequired } = await JournalChannel.open(
      path,
      expected,
    );
    try {
      if (upgradeRequired) {
        await upgradeJournal(channel, path);
      }
    } catch (cause) {
      await channel.close();
      throw cause;
    }
    return new Journal(path, channel);
  }

  /**
   * Accept one observation durably. An identical resubmission returns the existing receipt without
   * changing it; the same source key with different content or provenance is a conflict.
   */
  submit(
    observation: QueueObservation,
    now: string,
  ): Promise<{ record: JournalRecord; created: boolean }> {
    return this.#channel.request({ operation: "submit", observation, now });
  }

  /** Import preserved legacy receipts; identical records are left exactly as they are. */
  importLegacy(
    records: readonly LegacyReceipt[],
    now: string,
  ): Promise<LegacyImportResult> {
    return this.#channel.request({ operation: "importLegacy", records, now });
  }

  byId(receiptId: string): Promise<JournalRecord | undefined> {
    return this.#channel.request({ operation: "byId", receiptId });
  }

  /** One acceptance-sequence page of receipts; the cursor is the previous page's last sequence. */
  pageReceipts(
    limit: number,
    cursor: string | undefined,
  ): Promise<{
    records: JournalRecord[];
    cursor: string | undefined;
  }> {
    return this.#channel.request({ operation: "pageReceipts", limit, cursor });
  }

  /** The oldest pending receipt; later observations never overtake an unresolved write. */
  nextPending(): Promise<JournalRecord | undefined> {
    return this.#channel.request({ operation: "nextPending" });
  }

  /**
   * The oldest receipt whose outcome the queue cannot resolve by itself, if any. While one exists,
   * every collection write waits for an operator decision.
   */
  unresolvedReconciliation(): Promise<JournalRecord | undefined> {
    return this.#channel.request({ operation: "unresolvedReconciliation" });
  }

  /** Claim a still-eligible receipt, or skip a selection that durable state has superseded. */
  claim(sequence: number, now: string): Promise<JournalRecord | undefined> {
    return this.#channel.request({ operation: "claim", sequence, now });
  }

  /** Commit a complete insertion plan before any note write is attempted. */
  savePlan(sequence: number, plan: string, now: string): Promise<void> {
    return this.#channel.request({
      operation: "savePlan",
      sequence,
      plan,
      now,
    });
  }

  /** Mark the receipt stored and drop the temporary plan. */
  markStored(sequence: number, noteId: string, now: string): Promise<void> {
    return this.#channel.request({
      operation: "markStored",
      sequence,
      noteId,
      now,
    });
  }

  /** Record a retryable, permanent or blocking failure without discarding accepted work. */
  markFailure(
    sequence: number,
    failure: JournalFailure,
    now: string,
  ): Promise<void> {
    return this.#channel.request({
      operation: "markFailure",
      sequence,
      failure,
      now,
    });
  }

  /** Apply an operator decision to one blocked receipt. */
  reconcile(
    receiptId: string,
    outcome: ReconcileOutcome,
    now: string,
  ): Promise<JournalRecord> {
    return this.#channel.request({
      operation: "reconcile",
      receiptId,
      outcome,
      now,
    });
  }

  /**
   * Return one failed receipt known not to have written to processing, preserving its identity,
   * source values, attempts and sequence. A stale inspected count is an ineffective repeat that
   * never resumes a later failure; a future count or unsettled later write is refused.
   */
  recoverFailed(
    receiptId: string,
    expectedAttemptCount: number,
    now: string,
  ): Promise<{ record: JournalRecord; recovered: boolean }> {
    return this.#channel.request({
      operation: "recoverFailed",
      receiptId,
      expectedAttemptCount,
      now,
    });
  }

  /** The pending correction, while the journal holds its committed-plan slot. */
  correction(): Promise<PendingCorrection | undefined> {
    return this.#channel.request({ operation: "correction" });
  }

  /** The durable reason a new correction is refused before its expected state is read. */
  correctionRefusal(): Promise<string | undefined> {
    return this.#channel.request({ operation: "correctionRefusal" });
  }

  /** Commit one reviewed correction plan into the singleton slot before any note write. */
  saveCorrection(noteId: string, plan: string, now: string): Promise<void> {
    return this.#channel.request({
      operation: "saveCorrection",
      noteId,
      plan,
      now,
    });
  }

  /** Record one correction application attempt before the write it may perform. */
  beginCorrectionAttempt(now: string): Promise<PendingCorrection> {
    return this.#channel.request({ operation: "beginCorrectionAttempt", now });
  }

  /** Persist a failed correction attempt with its retry timing or blocking diagnostic. */
  markCorrectionFailure(
    failure: JournalCorrectionFailure,
    now: string,
  ): Promise<void> {
    return this.#channel.request({
      operation: "markCorrectionFailure",
      failure,
      now,
    });
  }

  /** Clear the correction slot after an application acknowledgment. */
  clearCorrection(): Promise<void> {
    return this.#channel.request({ operation: "clearCorrection" });
  }

  status(): Promise<JournalStatus> {
    return this.#channel.request({ operation: "status" });
  }

  close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    this.#closed = true;
    return this.#channel.close();
  }
}

/** How many ownership retries a concurrent schema upgrade may take before it is refused. */
const UPGRADE_OWNERSHIP_ATTEMPTS = 100;

/**
 * Upgrade a previous journal schema under exclusive writer ownership. An old worker, import or
 * correction owner refuses the upgrade; a concurrent upgrade of the same journal is waited out
 * and then found already current.
 */
const upgradeJournal = async (
  channel: JournalChannel,
  path: string,
): Promise<void> => {
  for (let attempt = 0; attempt < UPGRADE_OWNERSHIP_ATTEMPTS; attempt += 1) {
    let lock: WorkerLock;
    try {
      lock = await WorkerLock.acquire(path, "upgrade");
    } catch (cause) {
      if (!(cause instanceof QueueWorkerLockedError)) {
        throw cause;
      }
      if (!(await channel.request<boolean>({ operation: "recheckUpgrade" }))) {
        // Another handle upgraded the journal while this one waited for ownership.
        return;
      }
      const purpose = await WorkerLock.ownerPurpose(path);
      if (purpose === "upgrade" || purpose === undefined) {
        // A concurrent upgrade holds the journal only for its transaction, and an owner that
        // released between the failed attempt and this probe must not refuse the retry.
        continue;
      }
      throw cause;
    }
    try {
      await channel.request({ operation: "upgrade" });
    } finally {
      await lock.release();
    }
    return;
  }
  throw new QueueWorkerLockedError(path);
};
