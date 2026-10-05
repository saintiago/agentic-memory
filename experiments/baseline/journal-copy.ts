/**
 * Read-only inspection of one retained queue-journal copy: the schema-version check, the declared
 * binding and every receipt a baseline needs to enumerate accepted work, correlate stored notes
 * and select representative failures.
 *
 * The live service owns the journal. This module opens a private copy that the capture step took
 * with SQLite's online backup, so it never locks or writes the live pair. It is evidence tooling
 * over that copy, not a runtime journal client: it refuses an unsupported schema instead of
 * guessing at columns a later journal version may change.
 *
 * See docs/evaluation.md#quality-maintenance-procedure and docs/ingestion-queue.md#interface.
 */
import { createRequire } from "node:module";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { z } from "zod";

import { sha256Text } from "./io.js";

import {
  jsonValueSchema,
  queueBindingSchema,
  queueReceiptStatuses,
  type JsonValue,
  type QueueBinding,
  type QueueReceiptStatus,
} from "../../src/index.js";

const require = createRequire(import.meta.url);
const loadSqlite = (): typeof import("node:sqlite") =>
  require("node:sqlite") as typeof import("node:sqlite");

/** The journal schema this reader understands; a different version is refused, not guessed at. */
export const supportedJournalVersion = "3";

/** One receipt row of the retained journal copy, with the fields baseline evidence needs. */
export const journalCopyReceiptSchema = z.strictObject({
  sequence: z.int().nonnegative(),
  id: z.uuid(),
  sourceKey: z.string().min(1),
  noteId: z.uuid(),
  status: z.enum([
    "queued",
    "processing",
    "retrying",
    "stored",
    "failed",
    "blocked",
  ]),
  content: z.string(),
  timestamp: z.string().min(1),
  provenance: z.record(z.string(), jsonValueSchema).optional(),
  acceptedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  attemptCount: z.int().nonnegative(),
  nextRetryAt: z.string().min(1).optional(),
  lastError: z.string().min(1).optional(),
  storedAt: z.string().min(1).optional(),
  planCommitted: z.boolean(),
  requiresReconciliation: z.boolean(),
  reconciled: z.boolean(),
});

export type JournalCopyReceipt = z.infer<typeof journalCopyReceiptSchema>;

/** The declared pair binding and the receipts one journal copy holds. */
export interface JournalCopy {
  path: string;
  version: string;
  representation: string;
  binding: QueueBinding;
  latestSequence: number;
  receipts: JournalCopyReceipt[];
}

/** A journal copy that cannot be read as the supported schema. */
export class JournalCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalCopyError";
  }
}

const requiredText = (
  value: SQLOutputValue | undefined,
  column: string,
): string => {
  if (typeof value !== "string") {
    throw new JournalCopyError(
      `The journal copy has no text in its "${column}" column.`,
    );
  }
  return value;
};

const optionalText = (value: SQLOutputValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const requiredInteger = (
  value: SQLOutputValue | undefined,
  column: string,
): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new JournalCopyError(
      `The journal copy has no integer in its "${column}" column.`,
    );
  }
  return value;
};

const optionalJson = (
  value: SQLOutputValue | undefined,
): Record<string, JsonValue> | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new JournalCopyError("The journal copy holds unreadable provenance.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JournalCopyError(
      "The journal copy holds provenance that is not a JSON object.",
    );
  }
  return parsed as Record<string, JsonValue>;
};

const receiptStatus = (value: string): QueueReceiptStatus => {
  const known = queueReceiptStatuses.find((status) => status === value);
  if (known === undefined) {
    throw new JournalCopyError(
      `The journal copy holds the unknown receipt status "${value}".`,
    );
  }
  return known;
};

/**
 * Read the journal copy's metadata and receipts. The connection is read-only; a missing file or a
 * different schema fails before any receipt is reported.
 */
export const readJournalCopy = (path: string): JournalCopy => {
  const { DatabaseSync } = loadSqlite();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    throw new JournalCopyError(
      `The journal copy ${path} cannot be opened: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  try {
    const metadata = new Map<string, string>();
    const metadataRows = db
      .prepare("SELECT key, value FROM queue_metadata")
      .all() as ReadonlyArray<Record<string, SQLOutputValue>>;
    for (const row of metadataRows) {
      metadata.set(
        requiredText(row["key"], "key"),
        requiredText(row["value"], "value"),
      );
    }
    const version = metadata.get("journalVersion");
    if (version !== supportedJournalVersion) {
      throw new JournalCopyError(
        `The journal copy declares schema version ${String(version)}; this reader supports ` +
          `version ${supportedJournalVersion}.`,
      );
    }
    const representation = metadata.get("representation");
    if (representation === undefined) {
      throw new JournalCopyError(
        "The journal copy declares no representation identity.",
      );
    }
    let bindingValue: unknown;
    try {
      bindingValue = JSON.parse(metadata.get("binding") ?? "null") as unknown;
    } catch {
      throw new JournalCopyError(
        "The journal copy holds unreadable binding metadata.",
      );
    }
    const binding = queueBindingSchema.safeParse(bindingValue);
    if (!binding.success) {
      throw new JournalCopyError(
        "The journal copy's binding metadata is not a valid queue binding.",
      );
    }
    const rows = db
      .prepare(
        "SELECT sequence, id, source_key, note_id, status, content, timestamp, provenance, " +
          "accepted_at, updated_at, attempt_count, next_retry_at, last_error, stored_at, " +
          "plan_committed, requires_reconciliation, reconciled FROM receipts ORDER BY sequence",
      )
      .all() as ReadonlyArray<Record<string, SQLOutputValue>>;
    const receipts = rows.map((row) =>
      journalCopyReceiptSchema.parse({
        sequence: requiredInteger(row["sequence"], "sequence"),
        id: requiredText(row["id"], "id"),
        sourceKey: requiredText(row["source_key"], "source_key"),
        noteId: requiredText(row["note_id"], "note_id"),
        status: receiptStatus(requiredText(row["status"], "status")),
        content: requiredText(row["content"], "content"),
        timestamp: requiredText(row["timestamp"], "timestamp"),
        provenance: optionalJson(row["provenance"]),
        acceptedAt: requiredText(row["accepted_at"], "accepted_at"),
        updatedAt: requiredText(row["updated_at"], "updated_at"),
        attemptCount: requiredInteger(row["attempt_count"], "attempt_count"),
        nextRetryAt: optionalText(row["next_retry_at"]),
        lastError: optionalText(row["last_error"]),
        storedAt: optionalText(row["stored_at"]),
        planCommitted:
          requiredInteger(row["plan_committed"], "plan_committed") !== 0,
        requiresReconciliation:
          requiredInteger(
            row["requires_reconciliation"],
            "requires_reconciliation",
          ) !== 0,
        reconciled: requiredInteger(row["reconciled"], "reconciled") !== 0,
      }),
    );
    return {
      path,
      version,
      representation,
      binding: binding.data,
      latestSequence: receipts.reduce(
        (latest, receipt) => Math.max(latest, receipt.sequence),
        0,
      ),
      receipts,
    };
  } finally {
    db.close();
  }
};

/**
 * Copy a journal with SQLite's online backup. The source is opened read-only, so the live writer
 * keeps running; the destination is consistent as of the backup's own read transaction.
 */
export const copyJournal = async (
  sourcePath: string,
  destinationPath: string,
): Promise<void> => {
  const { DatabaseSync: Database, backup } = loadSqlite();
  const source = new Database(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }
};

/**
 * A digest of receipt state used to attest that no writer changed the journal while the collection
 * snapshot was taken: identity, outcome, attempts and update time of every receipt, in sequence
 * order.
 */
export const receiptStateFingerprint = (
  receipts: readonly JournalCopyReceipt[],
): string =>
  sha256Text(
    JSON.stringify(
      receipts.map((receipt) => [
        receipt.sequence,
        receipt.id,
        receipt.status,
        receipt.attemptCount,
        receipt.noteId,
        receipt.updatedAt,
        receipt.storedAt ?? "",
        receipt.planCommitted ? 1 : 0,
      ]),
    ),
  );
