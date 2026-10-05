/**
 * Read one retained baseline evidence root: the manifest, the receipt inventory, the declared
 * queries and the retained journal copy, each checked against the hash the manifest recorded at
 * capture time. Every later command reads the baseline through this module so an edited or
 * substituted artifact fails instead of silently changing the evidence.
 *
 * See docs/evaluation.md#quality-maintenance-procedure.
 */
import { readFile } from "node:fs/promises";

import { baselineManifestSchema, type BaselineManifest } from "./manifest.js";
import { readDeclaredQueries, type BaselineQuery } from "./declared-queries.js";
import {
  journalCopyReceiptSchema,
  readJournalCopy,
  type JournalCopy,
  type JournalCopyReceipt,
} from "./journal-copy.js";
import { baselinePath } from "./layout.js";
import {
  EvidenceDirectoryError,
  fileBytes,
  readJsonFile,
  readJsonl,
  sha256File,
  sha256Text,
} from "./io.js";

/** Everything later baseline commands share about one retained capture. */
export interface RetainedBaseline {
  root: string;
  manifest: BaselineManifest;
  journal: JournalCopy;
  receipts: JournalCopyReceipt[];
  queries: BaselineQuery[];
  queriesText: string;
}

const checkIntegrity = async (input: {
  file: string;
  expectedHash: string;
  expectedBytes?: number;
  label: string;
}): Promise<void> => {
  const actualHash = await sha256File(input.file);
  if (actualHash !== input.expectedHash) {
    throw new EvidenceDirectoryError(
      `The retained ${input.label} does not match the manifest hash; the baseline evidence was ` +
        "modified after capture.",
    );
  }
  if (input.expectedBytes !== undefined) {
    const actualBytes = await fileBytes(input.file);
    if (actualBytes !== input.expectedBytes) {
      throw new EvidenceDirectoryError(
        `The retained ${input.label} does not match the manifest byte size; the baseline ` +
          "evidence was modified after capture.",
      );
    }
  }
};

/** Read and validate one retained baseline; every hash is checked against the manifest. */
export const readRetainedBaseline = async (
  root: string,
): Promise<RetainedBaseline> => {
  const manifestFile = baselinePath(root, "manifest");
  const manifestValue = await readJsonFile(manifestFile);
  const manifest = baselineManifestSchema.safeParse(manifestValue);
  if (!manifest.success) {
    throw new EvidenceDirectoryError(
      `The baseline manifest ${manifestFile} is invalid: ${manifest.error.issues
        .map((issue) =>
          issue.path.length === 0
            ? issue.message
            : `${issue.path.map(String).join(".")}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  }
  const journalFile = baselinePath(root, "journal");
  await checkIntegrity({
    file: journalFile,
    expectedHash: manifest.data.journal.sha256,
    expectedBytes: manifest.data.journal.bytes,
    label: "journal copy",
  });
  const snapshotFile = baselinePath(root, "snapshot");
  await checkIntegrity({
    file: snapshotFile,
    expectedHash: manifest.data.collection.sha256,
    expectedBytes: manifest.data.collection.bytes,
    label: "collection snapshot",
  });
  const receiptsFile = baselinePath(root, "receipts");
  await checkIntegrity({
    file: receiptsFile,
    expectedHash: manifest.data.receipts.sha256,
    expectedBytes: manifest.data.receipts.bytes,
    label: "receipt inventory",
  });
  const queriesFile = baselinePath(root, "queries");
  const queriesText = await readFile(queriesFile, "utf8");
  if (manifest.data.declaredQueries.sha256 !== sha256Text(queriesText)) {
    throw new EvidenceDirectoryError(
      "The retained declared queries do not match the manifest hash; the baseline evidence was " +
        "modified after capture.",
    );
  }
  const journal = readJournalCopy(journalFile);
  const receiptValues = await readJsonl<unknown>(receiptsFile);
  const receipts = receiptValues.map((value, index) => {
    const parsed = journalCopyReceiptSchema.safeParse(value);
    if (!parsed.success) {
      throw new EvidenceDirectoryError(
        `The receipt inventory line ${String(index + 1)} is invalid.`,
      );
    }
    return parsed.data;
  });
  const queries = readDeclaredQueries(queriesText);
  return {
    root,
    manifest: manifest.data,
    journal,
    receipts,
    queries,
    queriesText,
  };
};
