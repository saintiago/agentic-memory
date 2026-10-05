/**
 * The quality-baseline tooling: the read-only journal copy and its fingerprint, declared-query
 * parsing, receipt accounting and representative selection, retained-evidence integrity, the
 * metrics denominators and the Qdrant collection metadata location. No network: the Qdrant check
 * is served by a local HTTP stub.
 *
 * See docs/evaluation.md#quality-maintenance-procedure and docs/testing.md#test-discipline.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  DeclaredQueryError,
  readDeclaredQueries,
} from "../../experiments/baseline/declared-queries.js";
import { readRetainedBaseline } from "../../experiments/baseline/evidence.js";
import {
  createEvidenceDirectory,
  fileBytes,
  sha256File,
  sha256Text,
  writeJsonFile,
} from "../../experiments/baseline/io.js";
import {
  copyJournal,
  JournalCopyError,
  readJournalCopy,
  receiptStateFingerprint,
  type JournalCopyReceipt,
} from "../../experiments/baseline/journal-copy.js";
import {
  baselineDirectory,
  baselinePath,
} from "../../experiments/baseline/layout.js";
import { aggregateMetrics } from "../../experiments/baseline/metrics.js";
import { collectionInfo } from "../../experiments/baseline/qdrant-snapshots.js";
import {
  selectRepresentativeFailures,
  summarizeReceipts,
} from "../../experiments/baseline/receipts.js";

const BINDING = {
  endpoint: "http://127.0.0.1:6333",
  collection: "nexus-memory",
  embeddingSpace: {
    id: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    dimensions: 4,
    distance: "Cosine" as const,
  },
};

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const receipt = (
  overrides: Partial<JournalCopyReceipt> = {},
): JournalCopyReceipt => ({
  sequence: 1,
  id: uuid(1),
  sourceKey: "source-1",
  noteId: uuid(101),
  status: "stored",
  content: "a retained source",
  timestamp: "2026-10-01T10:00:00Z",
  acceptedAt: "2026-10-01T10:00:01Z",
  updatedAt: "2026-10-01T10:00:02Z",
  attemptCount: 1,
  storedAt: "2026-10-01T10:00:02Z",
  planCommitted: true,
  requiresReconciliation: false,
  reconciled: true,
  ...overrides,
});

const tempDirectory = async (): Promise<string> =>
  await mkdtemp(path.join(tmpdir(), "amem-baseline-test-"));

/** Create one journal file with the retention columns the reader understands. */
const writeJournal = async (
  file: string,
  options: {
    version?: string;
    binding?: unknown;
    receipts?: readonly JournalCopyReceipt[];
  } = {},
): Promise<void> => {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE queue_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE receipts (
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
    const insertMetadata = db.prepare(
      "INSERT INTO queue_metadata (key, value) VALUES (?, ?)",
    );
    insertMetadata.run("journalVersion", options.version ?? "2");
    insertMetadata.run("representation", "amem-note-v1");
    insertMetadata.run("binding", JSON.stringify(options.binding ?? BINDING));
    const insert = db.prepare(
      "INSERT INTO receipts (sequence, id, source_key, note_id, status, content, timestamp, " +
        "accepted_at, updated_at, attempt_count, last_error, stored_at, plan_committed, " +
        "requires_reconciliation, reconciled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const entry of options.receipts ?? [receipt()]) {
      insert.run(
        entry.sequence,
        entry.id,
        entry.sourceKey,
        entry.noteId,
        entry.status,
        entry.content,
        entry.timestamp,
        entry.acceptedAt,
        entry.updatedAt,
        entry.attemptCount,
        entry.lastError ?? null,
        entry.storedAt ?? null,
        entry.planCommitted ? 1 : 0,
        entry.requiresReconciliation ? 1 : 0,
        entry.reconciled ? 1 : 0,
      );
    }
  } finally {
    db.close();
  }
};

describe("declared queries", () => {
  const line = (id: string, overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      id,
      query: "a declared question",
      expectedNoteIds: [uuid(1)],
      rationale: "declared before the run",
      wording: "replacement",
      evidence: "audit",
      ...overrides,
    });

  it("parses labeled replacements and hashes the exact declared text", () => {
    const text = `${line("one")}\n\n${line("two", { wording: "exact", expectedNoteIds: [] })}\n`;
    const queries = readDeclaredQueries(text);
    expect(queries.map((query) => query.id)).toEqual(["one", "two"]);
    expect(queries[0]?.wording).toBe("replacement");
    expect(queries[1]?.wording).toBe("exact");
    expect(sha256Text(text)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses repeated query IDs and non-UUID expected evidence", () => {
    expect(() => readDeclaredQueries(`${line("one")}\n${line("one")}`)).toThrow(
      DeclaredQueryError,
    );
    expect(() =>
      readDeclaredQueries(line("one", { expectedNoteIds: ["not-a-uuid"] })),
    ).toThrow(DeclaredQueryError);
    expect(() => readDeclaredQueries(line("one", { query: "   " }))).toThrow(
      DeclaredQueryError,
    );
    expect(() => readDeclaredQueries("{not json}")).toThrow(DeclaredQueryError);
  });
});

describe("journal copy", () => {
  it("copies and reads the binding and receipts of one journal", async () => {
    const directory = await tempDirectory();
    const source = path.join(directory, "live.sqlite");
    const copy = path.join(directory, "copy.sqlite");
    await writeJournal(source, {
      receipts: [
        receipt({ sequence: 1 }),
        receipt({
          sequence: 2,
          id: uuid(2),
          sourceKey: "source-2",
          noteId: uuid(102),
          status: "failed",
          attemptCount: 38,
          lastError:
            "The evolution response does not satisfy the documented contract.",
          planCommitted: false,
          reconciled: false,
          storedAt: undefined,
        }),
      ],
    });
    await copyJournal(source, copy);
    const journal = readJournalCopy(copy);
    expect(journal.version).toBe("2");
    expect(journal.binding).toEqual(BINDING);
    expect(journal.latestSequence).toBe(2);
    expect(journal.receipts[1]?.attemptCount).toBe(38);
    expect(journal.receipts[1]?.lastError).toContain("evolution response");
  });

  it("refuses an unsupported journal schema instead of guessing at columns", async () => {
    const directory = await tempDirectory();
    const file = path.join(directory, "future.sqlite");
    await writeJournal(file, { version: "3" });
    expect(() => readJournalCopy(file)).toThrow(JournalCopyError);
  });

  it("changes the receipt-state fingerprint when a writer touches receipt state", () => {
    const before = [receipt()];
    const same = [receipt()];
    const retried = [receipt({ attemptCount: 2 })];
    const stored = [
      receipt({
        status: "processing",
        storedAt: undefined,
        planCommitted: false,
      }),
    ];
    expect(receiptStateFingerprint(same)).toBe(receiptStateFingerprint(before));
    expect(receiptStateFingerprint(retried)).not.toBe(
      receiptStateFingerprint(before),
    );
    expect(receiptStateFingerprint(stored)).not.toBe(
      receiptStateFingerprint(before),
    );
  });
});

describe("receipt accounting", () => {
  const failed = (
    id: number,
    diagnostic: string,
    attemptCount: number,
    content = "short",
  ) =>
    receipt({
      sequence: id,
      id: uuid(id),
      sourceKey: `source-${String(id)}`,
      noteId: uuid(100 + id),
      status: "failed",
      content,
      attemptCount,
      lastError: diagnostic,
      planCommitted: false,
      reconciled: false,
      storedAt: undefined,
    });
  const evolution =
    "The evolution response does not satisfy the documented contract.";
  const unusable =
    "The model returned output the queue cannot use, so this observation failed permanently.";

  it("counts outcomes and attempts with the accepted total as denominator", () => {
    const receipts = [
      receipt({ sequence: 1 }),
      receipt({
        sequence: 2,
        id: uuid(2),
        sourceKey: "source-2",
        noteId: uuid(102),
      }),
      failed(3, evolution, 38),
      failed(4, unusable, 1),
    ];
    const accounting = summarizeReceipts(receipts, { revision: "test" });
    expect(accounting.acceptedObservations.count).toBe(4);
    expect(accounting.statusCounts).toMatchObject({ stored: 2, failed: 2 });
    expect(accounting.attempts.byStatus.failed).toBe(39);
    expect(accounting.attempts.receiptsWithMoreThanOneAttempt).toBe(1);
    expect(accounting.outcomes.map((outcome) => outcome.denominator)).toEqual([
      4, 4, 4, 4, 4, 4,
    ]);
    expect(accounting.failedDiagnostics).toEqual([
      {
        diagnostic: evolution,
        count: 1,
        denominator: 2,
        sampleReceiptIds: [uuid(3)],
      },
      {
        diagnostic: unusable,
        count: 1,
        denominator: 2,
        sampleReceiptIds: [uuid(4)],
      },
    ]);
    expect(accounting.recoveryEvidence.available).toBe(false);
    expect(accounting.recoveryEvidence.recoveredReceipts).toBeNull();
  });

  it("selects the most-repeated failure before longer content and alternates classes", () => {
    const receipts = [
      failed(10, evolution, 1, "x".repeat(500)),
      failed(11, evolution, 1, "x".repeat(400)),
      failed(12, evolution, 38),
      failed(13, evolution, 1, "x".repeat(300)),
      failed(14, unusable, 1, "x".repeat(200)),
      failed(15, unusable, 1, "x".repeat(100)),
    ];
    const selected = selectRepresentativeFailures(receipts, {
      perDiagnostic: 2,
      maxTotal: 4,
    });
    expect(selected.map((entry) => entry.receiptId)).toEqual([
      uuid(12),
      uuid(14),
      uuid(10),
      uuid(15),
    ]);
    const withoutDiagnostic = selectRepresentativeFailures([
      receipt({ status: "failed" }),
    ]);
    expect(withoutDiagnostic).toEqual([]);
  });
});

describe("retained baseline integrity", () => {
  const queriesText = `${JSON.stringify({
    id: "declared",
    query: "a declared question",
    expectedNoteIds: [uuid(1)],
    rationale: "fixed before the run",
    wording: "replacement",
    evidence: "audit",
  })}\n`;

  const writeBaseline = async (): Promise<string> => {
    const root = await tempDirectory();
    await createEvidenceDirectory(baselineDirectory(root));
    await writeJournal(baselinePath(root, "journal"));
    await writeFile(baselinePath(root, "snapshot"), "snapshot-bytes", "utf8");
    const receiptsText = `${JSON.stringify(receipt())}\n`;
    await writeFile(baselinePath(root, "receipts"), receiptsText, "utf8");
    await writeFile(baselinePath(root, "queries"), queriesText, "utf8");
    const manifest = {
      formatVersion: 1,
      capturedAt: "2026-10-02T10:00:00Z",
      revision: "test-revision",
      journal: {
        file: baselinePath(root, "journal"),
        sha256: await sha256File(baselinePath(root, "journal")),
        bytes: await fileBytes(baselinePath(root, "journal")),
        schemaVersion: "2",
        representation: "amem-note-v1",
        latestSequence: 1,
        binding: BINDING,
      },
      collection: {
        name: "nexus-memory",
        snapshotFile: baselinePath(root, "snapshot"),
        sha256: await sha256File(baselinePath(root, "snapshot")),
        bytes: await fileBytes(baselinePath(root, "snapshot")),
        pointsCount: 1,
        metadata: null,
      },
      quiescent: true,
      receipts: {
        file: baselinePath(root, "receipts"),
        sha256: sha256Text(receiptsText),
        bytes: Buffer.byteLength(receiptsText, "utf8"),
        count: 1,
        counts: {
          queued: 0,
          processing: 0,
          retrying: 0,
          stored: 1,
          failed: 0,
          blocked: 0,
        },
        attempts: 1,
      },
      declaredQueries: {
        file: baselinePath(root, "queries"),
        sha256: sha256Text(queriesText),
        count: 1,
      },
      prompts: { construction: "construct", evolution: "evolve" },
      model: {
        endpoint: null,
        id: "test-model",
        thinking: "disabled-external",
        maxOutputTokens: 6000,
        timeoutMs: 120000,
        retries: 0,
      },
      encoder: {},
      service: null,
      limits: ["test"],
    };
    await writeJsonFile(baselinePath(root, "manifest"), manifest);
    return root;
  };

  it("reads a valid baseline and refuses a modified artifact", async () => {
    const root = await writeBaseline();
    const baseline = await readRetainedBaseline(root);
    expect(baseline.receipts).toHaveLength(1);
    expect(baseline.queries).toHaveLength(1);
    await writeFile(baselinePath(root, "receipts"), "{}\n", "utf8");
    await expect(readRetainedBaseline(root)).rejects.toThrow(
      /modified after capture/,
    );
  });

  it("keeps unmeasured metrics null and states the denominator otherwise", async () => {
    const root = await writeBaseline();
    const metrics = await aggregateMetrics(root);
    expect(metrics.ingestion.acceptedObservations.count).toBe(1);
    expect(metrics.ingestion.storedOutcomes).toEqual({
      count: 1,
      denominator: "1 accepted observations",
    });
    expect(metrics.ingestion.recovery.recoveredReceipts).toBeNull();
    expect(metrics.restore).toBeNull();
    expect(metrics.retrieval).toBeNull();
    expect(metrics.reproduction).toBeNull();
    expect(metrics.limits.join(" ")).toContain(
      "isolated restore validation has not run",
    );
  });
});

describe("qdrant collection metadata", () => {
  const withServer = async (
    handler: (url: string) => Promise<void>,
  ): Promise<void> => {
    const server = createServer((request, response) => {
      const target = request.url ?? "";
      if (target.startsWith("/collections/present")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            result: {
              status: "green",
              points_count: 2,
              config: {
                metadata: {
                  agenticMemory: {
                    schemaVersion: 1,
                    representation: "amem-note-v1",
                  },
                },
              },
            },
            status: "ok",
            time: 0,
          }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: { error: "Not found" }, time: 0 }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      await handler(`http://127.0.0.1:${String(address.port)}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  };

  it("reads metadata from the documented config location and reports absence", async () => {
    await withServer(async (url) => {
      const present = await collectionInfo({ url }, "present");
      expect(present?.metadata).toEqual({
        agenticMemory: { schemaVersion: 1, representation: "amem-note-v1" },
      });
      const absent = await collectionInfo({ url }, "missing");
      expect(absent).toBeUndefined();
    });
  });
});
