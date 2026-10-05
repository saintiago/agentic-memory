/**
 * Restore a retained baseline into isolation and validate it: the copy journal into its own
 * directory and the collection snapshot into a fresh collection, then every documented retention
 * check — source/context pairs, receipt evidence, prompt settings, declared queries and the pair
 * binding. Only a successful report shows that the retained evidence is a usable baseline.
 *
 * See docs/evaluation.md#quality-maintenance-procedure.
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultPrompts,
  openQdrantNoteStore,
  type Note,
  type NoteStore,
} from "../../src/index.js";
import { readRetainedBaseline } from "./evidence.js";
import { createEvidenceDirectory, writeJsonFile } from "./io.js";
import { readJournalCopy, type JournalCopyReceipt } from "./journal-copy.js";
import { baselinePath } from "./layout.js";
import type { BaselineManifest } from "./manifest.js";
import {
  collectionInfo,
  deleteCollection,
  restoreCollectionSnapshot,
  type QdrantTarget,
} from "./qdrant-snapshots.js";
import { z } from "zod";

/** The two named expanded contexts the live audit inspected, retained for the later comparison. */
export const auditSampleNoteIds = [
  "9604b08a-34a1-4950-9e1a-d79127d11369",
  "f8dd980a-77b7-472f-bfc2-dd2ba7a2a17a",
] as const;

/** One restore validation check with the evidence behind its verdict. */
export const restoreCheckSchema = z.strictObject({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().min(1),
});

export type RestoreCheck = z.infer<typeof restoreCheckSchema>;

/** One inspected source/context pair from the restored collection. */
export const restoreSampleSchema = z.strictObject({
  noteId: z.string().min(1),
  found: z.boolean(),
  content: z.string().optional(),
  context: z.string().optional(),
  contentLength: z.int().nonnegative().optional(),
  contextLength: z.int().nonnegative().optional(),
});

export type RestoreSample = z.infer<typeof restoreSampleSchema>;

/** The isolated restore validation report. */
export const restoreReportSchema = z.strictObject({
  restoredAt: z.string().min(1),
  revision: z.string().min(1),
  isolatedCollection: z.string().min(1),
  isolatedJournal: z.string().min(1),
  baseline: z.strictObject({
    journalSha256: z.string().min(1),
    snapshotSha256: z.string().min(1),
  }),
  checks: z.array(restoreCheckSchema),
  counts: z.strictObject({
    acceptedReceipts: z.int().nonnegative(),
    storedReceipts: z.int().nonnegative(),
    failedReceipts: z.int().nonnegative(),
    pendingReceipts: z.int().nonnegative(),
    committedPlans: z.int().nonnegative(),
    restoredNotes: z.int().nonnegative(),
    matchedNotes: z.int().nonnegative(),
    unexplainedNotes: z.int().nonnegative(),
  }),
  samples: z.array(restoreSampleSchema),
  limits: z.array(z.string().min(1)),
});

export type RestoreReport = z.infer<typeof restoreReportSchema>;

/** A restore that cannot produce a valid isolated copy. */
export class BaselineRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineRestoreError";
  }
}

/**
 * Whether one retained capture records its prompt settings, and whether that text still equals
 * this revision's defaults. The capture guard already binds the recorded text to the defaults in
 * force at capture time; a later generation change legitimately makes the two differ, so only the
 * recorded text is required for retention, while the comparison keeps that difference visible.
 */
export const promptSettingsStatus = (
  manifest: Pick<BaselineManifest, "prompts">,
): { retained: boolean; matchesCurrentDefaults: boolean } => ({
  retained:
    manifest.prompts.construction.trim() !== "" &&
    manifest.prompts.evolution.trim() !== "",
  matchesCurrentDefaults:
    manifest.prompts.construction === defaultPrompts.construction &&
    manifest.prompts.evolution === defaultPrompts.evolution,
});

export interface RestoreOptions {
  root: string;
  qdrant: QdrantTarget;
  /** The isolated journal directory; it must not already exist. */
  workDirectory: string;
  /** The isolated collection name; a fresh unique name by default. */
  collection?: string;
  /** Delete the isolated collection after validation; default keeps it for the retrieval step. */
  cleanup?: boolean;
  /** The note identities to retain as inspected source/context samples. */
  sampleNoteIds?: readonly string[];
  now?: () => Date;
}

/** Canonical JSON text with sorted keys, for comparing evidence independent of property order. */
const canonicalJson = (value: unknown): string => {
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

const receiptIdentity = (receipt: JournalCopyReceipt): string =>
  canonicalJson({
    sequence: receipt.sequence,
    id: receipt.id,
    sourceKey: receipt.sourceKey,
    noteId: receipt.noteId,
    status: receipt.status,
    content: receipt.content,
    timestamp: receipt.timestamp,
    provenance: receipt.provenance ?? null,
    acceptedAt: receipt.acceptedAt,
    updatedAt: receipt.updatedAt,
    attemptCount: receipt.attemptCount,
    nextRetryAt: receipt.nextRetryAt ?? null,
    lastError: receipt.lastError ?? null,
    storedAt: receipt.storedAt ?? null,
    planCommitted: receipt.planCommitted,
    requiresReconciliation: receipt.requiresReconciliation,
    reconciled: receipt.reconciled,
  });

const pageAllNotes = async (store: NoteStore): Promise<Note[]> => {
  const notes: Note[] = [];
  let cursor: string | number | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    const result = await store.page(200, cursor);
    notes.push(...result.notes);
    cursor = result.cursor;
    if (cursor === undefined) {
      return notes;
    }
  }
  throw new BaselineRestoreError(
    "The restored collection pagination did not finish within the page bound.",
  );
};

const samplePair = (note: Note | undefined, noteId: string): RestoreSample =>
  note === undefined
    ? { noteId, found: false }
    : {
        noteId,
        found: true,
        content: note.content,
        context: note.context,
        contentLength: note.content.length,
        contextLength: note.context.length,
      };

/**
 * Restore and validate one retained baseline. The journal copy is copied into the work directory
 * and the snapshot restored into a fresh collection; nothing touches the live pair.
 */
export const restoreBaseline = async (
  options: RestoreOptions,
): Promise<RestoreReport> => {
  const now = options.now ?? (() => new Date());
  const baseline = await readRetainedBaseline(options.root);
  const manifest: BaselineManifest = baseline.manifest;

  await createEvidenceDirectory(options.workDirectory);
  const isolatedJournal = baselinePath(options.workDirectory, "restoreJournal");
  await mkdir(path.dirname(isolatedJournal), { recursive: true });
  await copyFile(baselinePath(options.root, "journal"), isolatedJournal);

  const restoredJournal = readJournalCopy(isolatedJournal);
  const collection =
    options.collection ??
    `baseline-restore-${now()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const snapshotBytes = await readFile(baselinePath(options.root, "snapshot"));
  await restoreCollectionSnapshot(options.qdrant, collection, snapshotBytes);

  const checks: RestoreCheck[] = [];
  const receiptsRetained =
    restoredJournal.version === manifest.journal.schemaVersion &&
    canonicalJson(restoredJournal.binding) ===
      canonicalJson(manifest.journal.binding) &&
    canonicalJson(restoredJournal.receipts.map(receiptIdentity)) ===
      canonicalJson(baseline.receipts.map(receiptIdentity));
  checks.push({
    name: "journal binding and receipt evidence retained",
    ok: receiptsRetained,
    detail: receiptsRetained
      ? `${String(baseline.receipts.length)} receipts and the declared binding restored unchanged.`
      : "The isolated journal copy does not match the captured binding or receipt inventory.",
  });

  const observed = await collectionInfo(options.qdrant, collection);
  const metadata = observed?.metadata as
    | { agenticMemory?: { representation?: unknown; embeddingSpace?: unknown } }
    | undefined;
  const spaceRetained =
    metadata?.agenticMemory?.representation ===
      restoredJournal.representation &&
    canonicalJson(metadata?.agenticMemory?.embeddingSpace) ===
      canonicalJson(restoredJournal.binding.embeddingSpace);
  checks.push({
    name: "collection representation and embedding space retained",
    ok: spaceRetained,
    detail: spaceRetained
      ? "The restored collection declares the journal's representation and embedding space."
      : "The restored collection does not declare the journal's representation or embedding space.",
  });

  const store = await openQdrantNoteStore({
    url: options.qdrant.url,
    collection,
    space: {
      id: restoredJournal.binding.embeddingSpace.id,
      dimensions: restoredJournal.binding.embeddingSpace.dimensions,
      distance: restoredJournal.binding.embeddingSpace.distance,
    },
    ...(options.qdrant.apiKey === undefined
      ? {}
      : { apiKey: options.qdrant.apiKey }),
    ...(options.qdrant.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.qdrant.timeoutMs }),
  });
  const notes = await pageAllNotes(store);
  const byId = new Map(notes.map((note) => [note.id.toLowerCase(), note]));
  const storedReceipts = restoredJournal.receipts.filter(
    (receipt) => receipt.status === "stored",
  );

  const mismatches: string[] = [];
  let matched = 0;
  for (const receipt of storedReceipts) {
    const note = byId.get(receipt.noteId.toLowerCase());
    if (note === undefined) {
      mismatches.push(
        `stored receipt ${receipt.id} has no note ${receipt.noteId}`,
      );
      continue;
    }
    const problems: string[] = [];
    if (note.content !== receipt.content) {
      problems.push("source content differs");
    }
    if (note.timestamp !== receipt.timestamp) {
      problems.push("source timestamp differs");
    }
    if (
      canonicalJson(note.metadata ?? null) !==
      canonicalJson(receipt.provenance ?? null)
    ) {
      problems.push("source provenance differs");
    }
    if (note.context.trim() === "") {
      problems.push("generated context is empty");
    }
    if (problems.length > 0) {
      mismatches.push(`note ${receipt.noteId}: ${problems.join("; ")}`);
    } else {
      matched += 1;
    }
  }
  const pairsRetained = mismatches.length === 0;
  checks.push({
    name: "source/context pairs retained",
    ok: pairsRetained,
    detail: pairsRetained
      ? `${String(matched)} of ${String(storedReceipts.length)} stored receipts have a matching ` +
        "note with source content, timestamp, provenance and non-empty context."
      : `${String(mismatches.length)} stored receipts failed the pair check: ` +
        `${mismatches.slice(0, 5).join("; ")}`,
  });

  const referenced = new Set(
    storedReceipts.map((receipt) => receipt.noteId.toLowerCase()),
  );
  for (const receipt of restoredJournal.receipts) {
    if (receipt.planCommitted && receipt.status !== "stored") {
      referenced.add(receipt.noteId.toLowerCase());
    }
  }
  const unexplained = notes.filter(
    (note) => !referenced.has(note.id.toLowerCase()),
  );
  checks.push({
    name: "no unexplained collection notes",
    ok: unexplained.length === 0,
    detail:
      unexplained.length === 0
        ? `${String(notes.length)} restored notes are all referenced by stored receipts or ` +
          "committed plans."
        : `${String(unexplained.length)} restored notes have no receipt or committed plan: ` +
          `${unexplained
            .slice(0, 5)
            .map((note) => note.id)
            .join(", ")}`,
  });

  const promptSettings = promptSettingsStatus(manifest);
  checks.push({
    name: "prompt and model settings retained",
    ok: promptSettings.retained,
    detail: promptSettings.retained
      ? `The capture records the prompt text in force for revision ${manifest.revision} and the ` +
        `declared model ${manifest.model.id}` +
        (promptSettings.matchesCurrentDefaults
          ? ", matching this revision's defaults."
          : "; this revision's defaults differ, as expected after a generation change.")
      : "The capture does not retain the construction and evolution prompt text.",
  });

  const queriesRetained =
    baseline.queries.length === manifest.declaredQueries.count &&
    baseline.queries.length > 0;
  checks.push({
    name: "declared queries retained",
    ok: queriesRetained,
    detail: queriesRetained
      ? `${String(baseline.queries.length)} declared queries with fixed expected evidence.`
      : "The declared query count does not match the manifest.",
  });

  const samples = (options.sampleNoteIds ?? auditSampleNoteIds).map((noteId) =>
    samplePair(byId.get(noteId.toLowerCase()), noteId),
  );

  const report: RestoreReport = {
    restoredAt: now().toISOString(),
    revision: manifest.revision,
    isolatedCollection: collection,
    isolatedJournal,
    baseline: {
      journalSha256: manifest.journal.sha256,
      snapshotSha256: manifest.collection.sha256,
    },
    checks,
    counts: {
      acceptedReceipts: restoredJournal.receipts.length,
      storedReceipts: storedReceipts.length,
      failedReceipts: restoredJournal.receipts.filter(
        (receipt) => receipt.status === "failed",
      ).length,
      pendingReceipts: restoredJournal.receipts.filter(
        (receipt) => receipt.status !== "stored" && receipt.status !== "failed",
      ).length,
      committedPlans: restoredJournal.receipts.filter(
        (receipt) => receipt.planCommitted,
      ).length,
      restoredNotes: notes.length,
      matchedNotes: matched,
      unexplainedNotes: unexplained.length,
    },
    samples,
    limits: [
      "The isolated collection and journal copy are evidence copies; they are not a live corpus " +
        "and are never written by the restore.",
      options.cleanup === true
        ? "The isolated collection was removed after validation."
        : "The isolated collection remains for the declared-query retrieval step and later " +
          "isolated comparisons; it is deleted by the operator, not by the library.",
    ],
  };
  await writeJsonFile(baselinePath(options.root, "restoreReport"), report);
  if (options.cleanup === true) {
    await deleteCollection(options.qdrant, collection);
  }
  if (!report.checks.every((check) => check.ok)) {
    throw new BaselineRestoreError(
      "The isolated restore did not pass every retention check; see the restore report.",
    );
  }
  return report;
};

/** Read and validate one restore report against the retained baseline it belongs to. */
export const readRestoreReport = async (
  root: string,
): Promise<RestoreReport> => {
  const baseline = await readRetainedBaseline(root);
  const value = JSON.parse(
    await readFile(baselinePath(root, "restoreReport"), "utf8"),
  ) as unknown;
  const report = restoreReportSchema.safeParse(value);
  if (!report.success) {
    throw new BaselineRestoreError(
      "The restore report is invalid; restore the baseline again.",
    );
  }
  if (report.data.baseline.journalSha256 !== baseline.manifest.journal.sha256) {
    throw new BaselineRestoreError(
      "The restore report does not belong to the retained baseline copy.",
    );
  }
  return report.data;
};
