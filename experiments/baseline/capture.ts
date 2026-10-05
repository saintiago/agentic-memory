/**
 * Capture a consistent baseline pair: an online copy of the live journal and a full snapshot of
 * the collection the journal is bound to, with the prompt, model and encoder settings and the
 * declared queries fixed alongside them. The capture attests whether the pair stayed quiescent
 * while the snapshot was taken and refuses an active-writer capture unless the operator overrides
 * that check.
 *
 * See docs/evaluation.md#quality-maintenance-procedure.
 */
import { readFile, rm, writeFile } from "node:fs/promises";

import { defaultPrompts, type JsonValue } from "../../src/index.js";
import { readDeclaredQueries } from "./declared-queries.js";
import {
  copyJournal,
  readJournalCopy,
  receiptStateFingerprint,
  type JournalCopyReceipt,
} from "./journal-copy.js";
import {
  createEvidenceDirectory,
  fileBytes,
  sha256File,
  sha256Text,
} from "./io.js";
import { baselineDirectory, baselinePath } from "./layout.js";
import {
  baselineManifestSchema,
  type BaselineManifest,
  type CapturedSettings,
} from "./manifest.js";
import {
  collectionInfo,
  createCollectionSnapshot,
  deleteCollectionSnapshot,
  downloadCollectionSnapshot,
  type QdrantTarget,
} from "./qdrant-snapshots.js";
import { countReceipts } from "./receipts.js";

/** A capture that cannot proceed. */
export class BaselineCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineCaptureError";
  }
}

/** One read-only service status sample recorded with the capture. */
export type CapturedService =
  | { url: string; reachable: true; status: JsonValue }
  | { url: string; reachable: false; error: string };

export interface CaptureOptions {
  /** The evidence root; a fresh `baseline/` directory is created under it. */
  root: string;
  /** The live journal file, named explicitly because the queue owns its directory. */
  journalPath: string;
  qdrant: QdrantTarget;
  /** The declared queries file fixed before any baseline query runs. */
  queriesPath: string;
  revision: string;
  /** Prompt, model and encoder settings recorded verbatim; never discovered implicitly. */
  settings: CapturedSettings;
  /** The optional service URL sampled for status evidence. */
  serviceUrl?: string;
  /** Proceed even when receipt state changed during the capture; default refuses. */
  allowActiveWriters?: boolean;
  now?: () => Date;
}

const normalizeEndpoint = (value: string): string =>
  value.replace(/\/+$/, "").toLowerCase();

const readServiceStatus = async (url: string): Promise<CapturedService> => {
  try {
    const response = await fetch(new URL("/v1/status", url), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        url,
        reachable: false,
        error: `The service status request failed with HTTP ${String(response.status)}.`,
      };
    }
    return {
      url,
      reachable: true,
      status: (await response.json()) as JsonValue,
    };
  } catch (cause) {
    return {
      url,
      reachable: false,
      error: `The service status request failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
};

/**
 * Capture one baseline. The journal copy is taken before the collection snapshot, so every receipt
 * stored in the copy had already written its note before the snapshot started.
 */
export const captureBaseline = async (
  options: CaptureOptions,
): Promise<{ manifest: BaselineManifest; receipts: JournalCopyReceipt[] }> => {
  const now = options.now ?? (() => new Date());
  const directory = baselineDirectory(options.root);
  await createEvidenceDirectory(directory);

  const queriesText = await readFile(options.queriesPath, "utf8");
  const queries = readDeclaredQueries(queriesText);
  if (queries.length === 0) {
    throw new BaselineCaptureError(
      "The declared queries file is empty; expected evidence must be fixed before the baseline.",
    );
  }
  if (
    options.settings.prompts.construction !== defaultPrompts.construction ||
    options.settings.prompts.evolution !== defaultPrompts.evolution
  ) {
    throw new BaselineCaptureError(
      "The recorded prompt text does not match this revision's default prompts; capture the " +
        "prompts actually in force.",
    );
  }

  const journalFile = baselinePath(options.root, "journal");
  await copyJournal(options.journalPath, journalFile);
  const journal = readJournalCopy(journalFile);
  if (
    normalizeEndpoint(journal.binding.endpoint) !==
    normalizeEndpoint(options.qdrant.url)
  ) {
    throw new BaselineCaptureError(
      "The journal's bound endpoint does not match the supplied Qdrant URL; the pair would not " +
        "be consistent.",
    );
  }

  const observed = await collectionInfo(
    options.qdrant,
    journal.binding.collection,
  );
  const snapshotInfo = await createCollectionSnapshot(
    options.qdrant,
    journal.binding.collection,
  );
  const snapshotFile = baselinePath(options.root, "snapshot");
  let snapshotBytes: Uint8Array;
  try {
    snapshotBytes = await downloadCollectionSnapshot(
      options.qdrant,
      journal.binding.collection,
      snapshotInfo.name,
    );
    await writeFile(snapshotFile, snapshotBytes);
  } finally {
    await deleteCollectionSnapshot(
      options.qdrant,
      journal.binding.collection,
      snapshotInfo.name,
    );
  }
  const snapshotHash = await sha256File(snapshotFile);
  if (
    snapshotInfo.checksum !== undefined &&
    !snapshotHash.endsWith(snapshotInfo.checksum.toLowerCase())
  ) {
    throw new BaselineCaptureError(
      "The downloaded collection snapshot does not match the checksum the provider reported.",
    );
  }

  // A second online copy shows whether any writer changed receipt state while the snapshot ran.
  const checkFile = `${journalFile}.quiescence-check`;
  await copyJournal(options.journalPath, checkFile);
  let quiescent: boolean;
  try {
    const after = readJournalCopy(checkFile);
    quiescent =
      receiptStateFingerprint(after.receipts) ===
      receiptStateFingerprint(journal.receipts);
  } finally {
    await rm(checkFile, { force: true });
  }
  if (!quiescent && options.allowActiveWriters !== true) {
    throw new BaselineCaptureError(
      "Receipt state changed while the collection snapshot was taken. Freeze the ingestion " +
        "writer and capture again into a new evidence directory, or pass --allow-active-writers " +
        "to retain the pair with its quiescence warning.",
    );
  }

  const service =
    options.serviceUrl === undefined
      ? options.settings.service
      : await readServiceStatus(options.serviceUrl);

  const receiptsFile = baselinePath(options.root, "receipts");
  const receiptText = journal.receipts
    .map((receipt) => `${JSON.stringify(receipt)}\n`)
    .join("");
  await writeFile(receiptsFile, receiptText, "utf8");
  const queriesFile = baselinePath(options.root, "queries");
  await writeFile(queriesFile, queriesText, "utf8");

  const counts = countReceipts(journal.receipts);
  const manifest = baselineManifestSchema.parse({
    formatVersion: 1,
    capturedAt: now().toISOString(),
    revision: options.revision,
    journal: {
      file: journalFile,
      sha256: await sha256File(journalFile),
      bytes: await fileBytes(journalFile),
      schemaVersion: journal.version,
      representation: journal.representation,
      latestSequence: journal.latestSequence,
      binding: journal.binding,
    },
    collection: {
      name: journal.binding.collection,
      snapshotFile,
      sha256: snapshotHash,
      bytes: await fileBytes(snapshotFile),
      ...(snapshotInfo.checksum === undefined
        ? {}
        : { providerChecksum: snapshotInfo.checksum }),
      pointsCount: observed?.points_count ?? null,
      metadata: observed?.metadata ?? null,
    },
    quiescent,
    receipts: {
      file: receiptsFile,
      sha256: sha256Text(receiptText),
      bytes: Buffer.byteLength(receiptText, "utf8"),
      count: journal.receipts.length,
      counts,
      attempts: journal.receipts.reduce(
        (total, receipt) => total + receipt.attemptCount,
        0,
      ),
    },
    declaredQueries: {
      file: queriesFile,
      sha256: sha256Text(queriesText),
      count: queries.length,
    },
    prompts: {
      construction: options.settings.prompts.construction,
      evolution: options.settings.prompts.evolution,
    },
    model: options.settings.model,
    encoder: options.settings.encoder,
    service,
    limits: [
      "The journal copy is an online SQLite backup; the collection snapshot is a full Qdrant " +
        "snapshot. Their consistency is attested by the receipt-state fingerprint and proven by " +
        "the isolated restore validation.",
      "Source and replay artifacts remain private and are never committed to the repository.",
      "The capture records provider settings, not the provider's behavior; isolated " +
        "reproductions re-record what the model actually returns.",
    ],
  });
  await writeFile(
    baselinePath(options.root, "manifest"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { manifest, receipts: journal.receipts };
};
