/**
 * The queue journal's SQLite half, running on its own thread: durable acceptance, monotonic drain
 * order, persisted insertion plans, legacy migration and reconciliation state. The thread is
 * started by file path, so this module imports Node built-ins only — it imports the queue's types
 * for checking only, without a runtime module graph — and every public diagnostic belongs to the
 * client that revives its failure reports.
 *
 * See docs/ingestion-queue.md#durable-acceptance-and-ordering, #crash-recovery and
 * #existing-receipts.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import type { JsonValue } from "../note-store/index.js";
import type {
  LegacyImportResult,
  LegacyReceipt,
  QueueObservation,
  QueueReceiptStatus,
  ReconcileOutcome,
} from "./contract.js";
import type {
  ExpectedJournalMetadata,
  JournalFailure,
  JournalFailureReport,
  JournalRecord,
  JournalRequest,
  JournalStatus,
} from "./journal-protocol.js";

/**
 * Node's SQLite binding is experimental, so it is loaded only when a journal thread starts instead
 * of whenever the package is imported.
 */
const require = createRequire(import.meta.url);
const loadDatabaseSync = (): typeof DatabaseSync =>
  (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;

const TERMINAL_STATUSES = ["stored", "failed"] as const;
const PENDING_STATUSES = [
  "queued",
  "processing",
  "retrying",
  "blocked",
] as const;
const ALL_STATUSES: ReadonlyArray<QueueReceiptStatus> = [
  ...PENDING_STATUSES,
  ...TERMINAL_STATUSES,
];

/**
 * The safe diagnostic a legacy uncertainty carries into every later status report. It is persisted
 * because the operator's reconciliation decision is what clears it.
 */
const LEGACY_UNCERTAINTY_DIAGNOSTIC =
  "The legacy receipt has an uncertain outcome and requires reconciliation before further " +
  "collection writes.";

/** A stable JSON text for comparison, independent of the caller's property order. */
const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(
        ([key, element]) => `${JSON.stringify(key)}:${canonicalJson(element)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const beginTransaction = (db: DatabaseSync, run: () => void): void => {
  db.exec("BEGIN IMMEDIATE");
  try {
    run();
    db.exec("COMMIT");
  } catch (cause) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback must not hide the failure that caused it.
    }
    throw cause;
  }
};

const requiredText = (
  value: SQLOutputValue | undefined,
  column: string,
): string => {
  if (typeof value !== "string") {
    throw new Error(`The queue journal has no text in its "${column}" column.`);
  }
  return value;
};

const optionalText = (value: SQLOutputValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const optionalJson = (
  value: SQLOutputValue | undefined,
): Record<string, JsonValue> | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value) as Record<string, JsonValue>;
  } catch {
    throw new Error("The queue journal holds unreadable provenance.");
  }
};

/**
 * A failure the journal reports to its client. The client rebuilds the queue's typed error from the
 * machine-readable report instead of matching messages.
 */
class JournalProblem extends Error {
  readonly report: JournalFailureReport;

  constructor(report: JournalFailureReport) {
    super(report.kind === "storage" ? report.message : report.kind);
    this.name = "JournalProblem";
    this.report = report;
  }
}

const conflictProblem = (sourceKey: string): JournalProblem =>
  new JournalProblem({ kind: "conflict", sourceKey });

const bindingProblem = (reason: string): JournalProblem =>
  new JournalProblem({ kind: "binding", reason });

const requestProblem = (reason: string): JournalProblem =>
  new JournalProblem({ kind: "request", reason });

/** Current durable state of one queue journal, held by its own thread. */
class JournalState {
  readonly path: string;
  readonly #db: DatabaseSync;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
  }

  /** Open or create the journal and reject a journal bound to another queue. */
  static open(path: string, expected: ExpectedJournalMetadata): JournalState {
    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS queue_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_key TEXT NOT NULL UNIQUE,
        note_id TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        provenance TEXT,
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        next_retry_at TEXT,
        last_error TEXT,
        stored_at TEXT,
        plan TEXT,
        plan_committed INTEGER NOT NULL DEFAULT 0,
        requires_reconciliation INTEGER NOT NULL DEFAULT 0,
        reconciled INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
    const journal = new JournalState(path, db);
    try {
      journal.#bind(expected);
    } catch (cause) {
      db.close();
      throw cause;
    }
    return journal;
  }

  /** Compare the journal's declared binding with this queue's binding, or write the first one. */
  #bind(expected: ExpectedJournalMetadata): void {
    const declared = new Map<string, string>();
    const rows = this.#db
      .prepare("SELECT key, value FROM queue_metadata")
      .all() as ReadonlyArray<Record<string, SQLOutputValue>>;
    for (const row of rows) {
      declared.set(
        requiredText(row["key"], "key"),
        requiredText(row["value"], "value"),
      );
    }
    const binding = canonicalJson(expected.binding);
    if (declared.size === 0) {
      beginTransaction(this.#db, () => {
        const insert = this.#db.prepare(
          "INSERT INTO queue_metadata (key, value) VALUES (?, ?)",
        );
        for (const [key, value] of Object.entries({
          journalVersion: expected.journalVersion,
          representation: expected.representation,
          binding,
        })) {
          insert.run(key, value);
        }
      });
      return;
    }
    const version = declared.get("journalVersion");
    if (version !== expected.journalVersion) {
      throw bindingProblem(
        `its journal schema version is ${String(version)} instead of ` +
          expected.journalVersion,
      );
    }
    const representation = declared.get("representation");
    if (representation !== expected.representation) {
      throw bindingProblem(
        `it was opened for the representation ${String(representation)} instead of ` +
          expected.representation,
      );
    }
    let declaredBinding: JsonValue;
    try {
      declaredBinding = JSON.parse(
        declared.get("binding") ?? "null",
      ) as JsonValue;
    } catch {
      throw bindingProblem("its binding metadata is unreadable");
    }
    if (canonicalJson(declaredBinding) !== binding) {
      throw bindingProblem(
        "it was opened for another endpoint, collection or embedding space",
      );
    }
  }

  /**
   * Accept one observation durably. An identical resubmission returns the existing receipt without
   * changing it; the same source key with different content or provenance is a conflict.
   */
  submit(observation: QueueObservation, now: string): JournalRecord {
    return this.#transaction(() => {
      const existing = this.#bySourceKey(observation.sourceKey);
      if (existing !== undefined) {
        if (!sameObservation(existing, observation)) {
          throw conflictProblem(observation.sourceKey);
        }
        return existing;
      }
      this.#db
        .prepare(
          "INSERT INTO receipts (id, source_key, note_id, status, content, timestamp, " +
            "provenance, accepted_at, updated_at, attempt_count) " +
            "VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0)",
        )
        .run(
          randomUUID(),
          observation.sourceKey,
          randomUUID(),
          observation.content,
          observation.timestamp ?? now,
          observation.provenance === undefined
            ? null
            : JSON.stringify(observation.provenance),
          now,
          now,
        );
      return this.#requiredBySourceKey(observation.sourceKey);
    });
  }

  /**
   * Import preserved legacy receipts. A record whose source key already holds the same observation
   * with compatible evidence is left exactly as it is; an uncertain record for an observation the
   * queue has not written turns that receipt into a reconciliation block, because the legacy system
   * may have written it; any other disagreement is a conflict.
   */
  importLegacy(
    records: readonly LegacyReceipt[],
    now: string,
  ): LegacyImportResult {
    let imported = 0;
    let existing = 0;
    let blocked = 0;
    this.#transaction(() => {
      const insert = this.#db.prepare(
        "INSERT INTO receipts (id, source_key, note_id, status, content, timestamp, " +
          "provenance, accepted_at, updated_at, attempt_count, next_retry_at, last_error, " +
          "stored_at, requires_reconciliation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const record of records) {
        const present = this.#bySourceKey(record.sourceKey);
        if (present !== undefined) {
          if (!sameLegacyObservation(present, record)) {
            throw conflictProblem(record.sourceKey);
          }
          switch (legacyVerdict(present, record)) {
            case "existing":
              existing += 1;
              break;
            case "reconcile":
              this.#requireLegacyReconciliation(present, now);
              blocked += 1;
              break;
            case "conflict":
              throw conflictProblem(record.sourceKey);
          }
          continue;
        }
        if (record.status === "stored") {
          const acceptedAt = record.acceptedAt ?? record.storedAt ?? now;
          insert.run(
            record.receiptId ?? randomUUID(),
            record.sourceKey,
            record.noteId,
            "stored",
            record.content,
            record.timestamp ?? acceptedAt,
            record.provenance === undefined
              ? null
              : JSON.stringify(record.provenance),
            acceptedAt,
            now,
            0,
            null,
            null,
            record.storedAt ?? now,
            0,
          );
          imported += 1;
          continue;
        }
        if (record.status === "pending") {
          const acceptedAt = record.acceptedAt ?? now;
          insert.run(
            record.receiptId ?? randomUUID(),
            record.sourceKey,
            randomUUID(),
            "queued",
            record.content,
            record.timestamp ?? acceptedAt,
            record.provenance === undefined
              ? null
              : JSON.stringify(record.provenance),
            acceptedAt,
            now,
            0,
            null,
            null,
            null,
            0,
          );
          imported += 1;
          continue;
        }
        const acceptedAt = record.acceptedAt ?? now;
        insert.run(
          record.receiptId ?? randomUUID(),
          record.sourceKey,
          record.noteId ?? randomUUID(),
          "blocked",
          record.content,
          record.timestamp ?? acceptedAt,
          record.provenance === undefined
            ? null
            : JSON.stringify(record.provenance),
          acceptedAt,
          now,
          0,
          null,
          LEGACY_UNCERTAINTY_DIAGNOSTIC,
          null,
          1,
        );
        imported += 1;
        blocked += 1;
      }
    });
    return { imported, existing, blocked };
  }

  byId(receiptId: string): JournalRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM receipts WHERE id = ?")
      .get(receiptId) as Record<string, SQLOutputValue> | undefined;
    return row === undefined ? undefined : readRecord(row);
  }

  /** The oldest pending receipt; later observations never overtake an unresolved write. */
  nextPending(): JournalRecord | undefined {
    const placeholders = PENDING_STATUSES.map(() => "?").join(", ");
    const row = this.#db
      .prepare(
        `SELECT * FROM receipts WHERE status IN (${placeholders}) ORDER BY sequence LIMIT 1`,
      )
      .get(...PENDING_STATUSES) as Record<string, SQLOutputValue> | undefined;
    return row === undefined ? undefined : readRecord(row);
  }

  /**
   * The oldest receipt whose outcome the queue cannot resolve by itself. While one exists, no
   * collection write may proceed, whatever its place in the drain order: the unresolved legacy
   * mutation could have changed the state a later write would evolve.
   */
  unresolvedReconciliation(): JournalRecord | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM receipts WHERE requires_reconciliation = 1 ORDER BY sequence LIMIT 1",
      )
      .get() as Record<string, SQLOutputValue> | undefined;
    return row === undefined ? undefined : readRecord(row);
  }

  /** Mark a receipt processing for one attempt and retain the attempt count across restarts. */
  claim(sequence: number, now: string): JournalRecord {
    return this.#transaction(() => {
      this.#db
        .prepare(
          "UPDATE receipts SET status = 'processing', attempt_count = attempt_count + 1, " +
            "next_retry_at = NULL, updated_at = ? WHERE sequence = ?",
        )
        .run(now, sequence);
      return this.#requiredBySequence(sequence);
    });
  }

  /**
   * Commit a complete insertion plan before any note write is attempted. The commit evidence stays
   * behind when the temporary plan is dropped, so a plan that goes missing later is distinguishable
   * from preparation that never finished.
   */
  savePlan(sequence: number, plan: string, now: string): void {
    this.#db
      .prepare(
        "UPDATE receipts SET plan = ?, plan_committed = 1, updated_at = ? WHERE sequence = ?",
      )
      .run(plan, now, sequence);
  }

  /** Mark the receipt stored and drop the temporary plan. */
  markStored(sequence: number, noteId: string, now: string): void {
    this.#db
      .prepare(
        "UPDATE receipts SET status = 'stored', note_id = ?, stored_at = ?, plan = NULL, " +
          "next_retry_at = NULL, last_error = NULL, updated_at = ? WHERE sequence = ?",
      )
      .run(noteId, now, now, sequence);
  }

  /** Record a retryable, permanent or blocking failure without discarding accepted work. */
  markFailure(sequence: number, failure: JournalFailure, now: string): void {
    this.#db
      .prepare(
        "UPDATE receipts SET status = ?, next_retry_at = ?, last_error = ?, updated_at = ? " +
          "WHERE sequence = ?",
      )
      .run(
        failure.status,
        failure.nextRetryAt ?? null,
        failure.lastError,
        now,
        sequence,
      );
  }

  /**
   * Apply an operator decision to one blocked receipt. The decision is durable: it clears the
   * uncertainty that blocked every collection write, and a repeated legacy import leaves the
   * decided receipt exactly as it is.
   */
  reconcile(
    receiptId: string,
    outcome: ReconcileOutcome,
    now: string,
  ): JournalRecord {
    return this.#transaction(() => {
      const present = this.byId(receiptId);
      if (present === undefined) {
        throw requestProblem(`No queue receipt has the identity ${receiptId}.`);
      }
      if (present.status !== "blocked") {
        throw requestProblem(
          `The queue receipt ${receiptId} is not blocked, so it cannot be reconciled.`,
        );
      }
      if (outcome.outcome === "stored") {
        this.markStored(present.sequence, outcome.noteId, now);
      } else {
        this.#db
          .prepare(
            "UPDATE receipts SET status = 'queued', plan = NULL, plan_committed = 0, " +
              "next_retry_at = NULL, last_error = NULL, updated_at = ? WHERE sequence = ?",
          )
          .run(now, present.sequence);
      }
      this.#db
        .prepare(
          "UPDATE receipts SET reconciled = 1, requires_reconciliation = 0, updated_at = ? " +
            "WHERE sequence = ?",
        )
        .run(now, present.sequence);
      return this.#requiredBySequence(present.sequence);
    });
  }

  status(): JournalStatus {
    const counts: Record<QueueReceiptStatus, number> = {
      queued: 0,
      processing: 0,
      retrying: 0,
      stored: 0,
      failed: 0,
      blocked: 0,
    };
    for (const row of this.#db
      .prepare("SELECT status, COUNT(*) AS count FROM receipts GROUP BY status")
      .all() as ReadonlyArray<Record<string, SQLOutputValue>>) {
      const status = requiredText(
        row["status"],
        "status",
      ) as QueueReceiptStatus;
      if (status in counts) {
        counts[status] = Number(row["count"]);
      }
    }
    const placeholders = PENDING_STATUSES.map(() => "?").join(", ");
    const oldest = this.#db
      .prepare(
        `SELECT accepted_at, last_error FROM receipts WHERE status IN (${placeholders}) ` +
          "ORDER BY sequence LIMIT 1",
      )
      .get(...PENDING_STATUSES) as Record<string, SQLOutputValue> | undefined;
    return {
      counts,
      oldestPendingAt:
        oldest === undefined
          ? undefined
          : requiredText(oldest["accepted_at"], "accepted_at"),
      pendingError:
        this.unresolvedReconciliation()?.lastError ??
        (oldest === undefined ? undefined : optionalText(oldest["last_error"])),
    };
  }

  close(): void {
    this.#db.close();
  }

  #transaction<Value>(run: () => Value): Value {
    let result!: Value;
    beginTransaction(this.#db, () => {
      result = run();
    });
    return result;
  }

  /** Turn a receipt the queue has not written into a reconciliation block. */
  #requireLegacyReconciliation(present: JournalRecord, now: string): void {
    this.#db
      .prepare(
        "UPDATE receipts SET status = 'blocked', requires_reconciliation = 1, " +
          "next_retry_at = NULL, last_error = ?, updated_at = ? WHERE sequence = ?",
      )
      .run(LEGACY_UNCERTAINTY_DIAGNOSTIC, now, present.sequence);
  }

  #bySourceKey(sourceKey: string): JournalRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM receipts WHERE source_key = ?")
      .get(sourceKey) as Record<string, SQLOutputValue> | undefined;
    return row === undefined ? undefined : readRecord(row);
  }

  #requiredBySourceKey(sourceKey: string): JournalRecord {
    const row = this.#bySourceKey(sourceKey);
    if (row === undefined) {
      throw new Error(`The queue journal lost the receipt for "${sourceKey}".`);
    }
    return row;
  }

  #requiredBySequence(sequence: number): JournalRecord {
    const row = this.#db
      .prepare("SELECT * FROM receipts WHERE sequence = ?")
      .get(sequence) as Record<string, SQLOutputValue> | undefined;
    if (row === undefined) {
      throw new Error(
        `The queue journal lost the receipt with sequence ${sequence}.`,
      );
    }
    return readRecord(row);
  }
}

const readRecord = (row: Record<string, SQLOutputValue>): JournalRecord => {
  const status = requiredText(row["status"], "status") as QueueReceiptStatus;
  if (!ALL_STATUSES.includes(status)) {
    throw new Error(`The queue journal holds the unknown status "${status}".`);
  }
  return {
    sequence: Number(row["sequence"]),
    receiptId: requiredText(row["id"], "id"),
    sourceKey: requiredText(row["source_key"], "source_key"),
    noteId: requiredText(row["note_id"], "note_id"),
    status,
    content: requiredText(row["content"], "content"),
    timestamp: requiredText(row["timestamp"], "timestamp"),
    provenance: optionalJson(row["provenance"]),
    acceptedAt: requiredText(row["accepted_at"], "accepted_at"),
    updatedAt: requiredText(row["updated_at"], "updated_at"),
    attemptCount: Number(row["attempt_count"]),
    nextRetryAt: optionalText(row["next_retry_at"]),
    lastError: optionalText(row["last_error"]),
    storedAt: optionalText(row["stored_at"]),
    plan: optionalText(row["plan"]),
    planCommitted: Number(row["plan_committed"]) === 1,
    requiresReconciliation: Number(row["requires_reconciliation"]) === 1,
    reconciled: Number(row["reconciled"]) === 1,
  };
};

/** Two observations are the same when their source key, content and provenance agree. */
const sameObservation = (
  stored: JournalRecord,
  observation: QueueObservation,
): boolean =>
  stored.content === observation.content &&
  canonicalJson(stored.provenance ?? null) ===
    canonicalJson(observation.provenance ?? null);

const sameLegacyObservation = (
  stored: JournalRecord,
  record: LegacyReceipt,
): boolean =>
  stored.content === record.content &&
  canonicalJson(stored.provenance ?? null) ===
    canonicalJson(record.provenance ?? null) &&
  (record.status !== "stored" || stored.noteId === record.noteId);

/**
 * Whether one imported legacy record agrees with the receipt the journal already holds. Equal
 * observation text is not enough: the recorded outcome must agree too.
 *
 * A preserved pending observation adds nothing to a receipt the queue already holds — the queue's
 * own durable state is authoritative — and a completed receipt resolves an uncertainty unless the
 * legacy record names a different identity, which is a conflict. An uncertain record that names an
 * observation whose legacy outcome has not already been decided becomes a reconciliation block.
 * A queue plan (or interrupted preparation) cannot establish a separate legacy insertion's outcome,
 * even when its note identity matches: the legacy write may have changed other records.
 */
const legacyVerdict = (
  present: JournalRecord,
  record: LegacyReceipt,
): "existing" | "reconcile" | "conflict" => {
  if (record.status === "pending") {
    return "existing";
  }
  if (present.status === "stored") {
    return record.noteId === undefined || record.noteId === present.noteId
      ? "existing"
      : "conflict";
  }
  if (present.reconciled || present.requiresReconciliation) {
    return "existing";
  }
  return "reconcile";
};

/** One reply of the journal thread. */
const reportOf = (cause: unknown): JournalFailureReport =>
  cause instanceof JournalProblem
    ? cause.report
    : {
        kind: "storage",
        name: cause instanceof Error ? cause.name : "Error",
        message: cause instanceof Error ? cause.message : String(cause),
      };

const port = parentPort;
if (port === null) {
  throw new Error("The queue journal runs on its own worker thread.");
}

let journal: JournalState | undefined;

/** Run one journal operation. The client validates inputs against the public schemas. */
const dispatch = (request: JournalRequest): unknown => {
  switch (request.operation) {
    case "open": {
      journal = JournalState.open(request.path, request.expected);
      return null;
    }
    case "close": {
      requireJournal(journal).close();
      journal = undefined;
      return null;
    }
    case "submit":
      return requireJournal(journal).submit(request.observation, request.now);
    case "importLegacy":
      return requireJournal(journal).importLegacy(request.records, request.now);
    case "byId":
      return requireJournal(journal).byId(request.receiptId);
    case "nextPending":
      return requireJournal(journal).nextPending();
    case "unresolvedReconciliation":
      return requireJournal(journal).unresolvedReconciliation();
    case "claim":
      return requireJournal(journal).claim(request.sequence, request.now);
    case "savePlan": {
      requireJournal(journal).savePlan(
        request.sequence,
        request.plan,
        request.now,
      );
      return null;
    }
    case "markStored": {
      requireJournal(journal).markStored(
        request.sequence,
        request.noteId,
        request.now,
      );
      return null;
    }
    case "markFailure": {
      requireJournal(journal).markFailure(
        request.sequence,
        request.failure,
        request.now,
      );
      return null;
    }
    case "reconcile":
      return requireJournal(journal).reconcile(
        request.receiptId,
        request.outcome,
        request.now,
      );
    case "status":
      return requireJournal(journal).status();
  }
};

const requireJournal = (state: JournalState | undefined): JournalState => {
  if (state === undefined) {
    throw new Error(
      "The queue journal received work before it was opened or after it closed.",
    );
  }
  return state;
};

port.on("message", (message: unknown) => {
  const request = message as JournalRequest;
  try {
    port.postMessage({ id: request.id, result: dispatch(request) });
  } catch (cause) {
    port.postMessage({ id: request.id, failure: reportOf(cause) });
  }
  if (request.operation === "close") {
    // The journal is closed; the thread has nothing left to do and exits.
    port.close();
  }
});
