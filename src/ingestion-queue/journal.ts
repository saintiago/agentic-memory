/**
 * The durable SQLite journal of one ingestion queue: transactional submissions, monotonic drain
 * order, receipt state, persisted insertion plans and the binding it was first opened with.
 *
 * See docs/ingestion-queue.md#durable-acceptance-and-ordering and #crash-recovery.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { representationVersion } from "../memory/index.js";
import type { JsonValue } from "../note-store/index.js";
import type {
  LegacyImportResult,
  LegacyReceipt,
  QueueBinding,
  QueueObservation,
  QueueReceiptStatus,
  ReconcileOutcome,
} from "./contract.js";
import {
  QueueBindingError,
  QueueConflictError,
  QueueRequestError,
} from "./errors.js";

/** The journal file name inside the queue's durable directory. */
export const journalFileName = "ingestion-queue.sqlite";

/**
 * Node's SQLite binding is experimental, so it is loaded only when a queue is opened instead of
 * whenever the package is imported. The queue is the only consumer.
 */
const require = createRequire(import.meta.url);
const loadDatabaseSync = (): typeof DatabaseSync =>
  (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;

/** The journal schema this build can reopen. */
const JOURNAL_VERSION = 1;

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

/** One receipt as the journal stores it; `plan` is the serialized insertion plan when durable. */
export interface JournalRecord {
  readonly sequence: number;
  readonly receiptId: string;
  readonly sourceKey: string;
  readonly noteId: string;
  readonly status: QueueReceiptStatus;
  readonly content: string;
  readonly timestamp: string;
  readonly provenance: Record<string, JsonValue> | undefined;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly attemptCount: number;
  readonly nextRetryAt: string | undefined;
  readonly lastError: string | undefined;
  readonly storedAt: string | undefined;
  readonly plan: string | undefined;
}

/** One failure a worker recorded for a receipt. */
export interface JournalFailure {
  readonly status: Extract<
    QueueReceiptStatus,
    "retrying" | "failed" | "blocked"
  >;
  readonly nextRetryAt: string | undefined;
  readonly lastError: string;
}

/** Receipt counts and the oldest pending acceptance, for status reporting. */
export interface JournalStatus {
  readonly counts: Record<QueueReceiptStatus, number>;
  readonly oldestPendingAt: string | undefined;
}

/** A stable JSON text for comparison, independent of the caller's property order. */
export const canonicalJson = (value: JsonValue): string => {
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

/** Current receipt state of one durable queue journal. */
export class Journal {
  readonly path: string;
  readonly #db: DatabaseSync;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
  }

  /** Open or create the journal and reject a journal bound to another queue. */
  static open(path: string, binding: QueueBinding): Journal {
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
        plan TEXT
      ) STRICT;
    `);
    const journal = new Journal(path, db);
    try {
      journal.#bind(binding);
    } catch (cause) {
      db.close();
      throw cause;
    }
    return journal;
  }

  /** Compare the journal's declared binding with this queue's binding, or write the first one. */
  #bind(binding: QueueBinding): void {
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
    const expected = {
      journalVersion: String(JOURNAL_VERSION),
      representation: representationVersion,
      binding: canonicalJson(binding as unknown as JsonValue),
    };
    if (declared.size === 0) {
      beginTransaction(this.#db, () => {
        const insert = this.#db.prepare(
          "INSERT INTO queue_metadata (key, value) VALUES (?, ?)",
        );
        for (const [key, value] of Object.entries(expected)) {
          insert.run(key, value);
        }
      });
      return;
    }
    const version = declared.get("journalVersion");
    if (version !== expected.journalVersion) {
      throw new QueueBindingError(
        this.path,
        `its journal schema version is ${String(version)} instead of ${expected.journalVersion}`,
      );
    }
    const representation = declared.get("representation");
    if (representation !== expected.representation) {
      throw new QueueBindingError(
        this.path,
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
      throw new QueueBindingError(
        this.path,
        "its binding metadata is unreadable",
      );
    }
    if (canonicalJson(declaredBinding) !== expected.binding) {
      throw new QueueBindingError(
        this.path,
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
          throw new QueueConflictError(observation.sourceKey);
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

  /** Import preserved legacy receipts; identical records are left exactly as they are. */
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
          "stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const record of records) {
        const present = this.#bySourceKey(record.sourceKey);
        if (present !== undefined) {
          if (!sameLegacyObservation(present, record)) {
            throw new QueueConflictError(record.sourceKey);
          }
          existing += 1;
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
          "The legacy receipt has an uncertain outcome and requires reconciliation before " +
            "further collection writes.",
          null,
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

  /** Commit a complete insertion plan before any note write is attempted. */
  savePlan(sequence: number, plan: string, now: string): void {
    this.#db
      .prepare(
        "UPDATE receipts SET plan = ?, updated_at = ? WHERE sequence = ?",
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

  /** Apply an operator decision to one blocked receipt. */
  reconcile(
    receiptId: string,
    outcome: ReconcileOutcome,
    now: string,
  ): JournalRecord {
    return this.#transaction(() => {
      const present = this.byId(receiptId);
      if (present === undefined) {
        throw new QueueRequestError(
          `No queue receipt has the identity ${receiptId}.`,
        );
      }
      if (present.status !== "blocked") {
        throw new QueueRequestError(
          `The queue receipt ${receiptId} is not blocked, so it cannot be reconciled.`,
        );
      }
      if (outcome.outcome === "stored") {
        this.markStored(present.sequence, outcome.noteId, now);
      } else {
        this.#db
          .prepare(
            "UPDATE receipts SET status = 'queued', plan = NULL, next_retry_at = NULL, " +
              "last_error = NULL, updated_at = ? WHERE sequence = ?",
          )
          .run(now, present.sequence);
      }
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
        `SELECT accepted_at FROM receipts WHERE status IN (${placeholders}) ` +
          "ORDER BY sequence LIMIT 1",
      )
      .get(...PENDING_STATUSES) as Record<string, SQLOutputValue> | undefined;
    return {
      counts,
      oldestPendingAt:
        oldest === undefined
          ? undefined
          : requiredText(oldest["accepted_at"], "accepted_at"),
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
