/**
 * The quality-baseline tooling: the read-only journal copy and its fingerprint, declared-query
 * parsing, receipt accounting and representative selection, retained-evidence integrity, the
 * metrics denominators and the Qdrant collection metadata location. No network: the Qdrant check
 * is served by a local HTTP stub.
 *
 * See docs/evaluation.md#quality-maintenance-procedure and docs/testing.md#test-discipline.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import {
  classifyModelCall,
  classifyReproductionRuns,
  recordedPromptTextSource,
} from "../../experiments/baseline/defects.js";
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
import {
  linkedAdditionsBeyondExpected,
  readLinkedReviewSummary,
  summarizeLinkedReview,
  type LinkedReview,
} from "../../experiments/baseline/linked-review.js";
import {
  compareMatchedRuns,
  MatchedComparisonError,
  readMatchedRun,
  runLinkedReviewFile,
} from "../../experiments/baseline/matched.js";
import { aggregateMetrics } from "../../experiments/baseline/metrics.js";
import { collectionInfo } from "../../experiments/baseline/qdrant-snapshots.js";
import {
  selectRepresentativeFailures,
  summarizeReceipts,
} from "../../experiments/baseline/receipts.js";
import {
  promptSettingsStatus,
  restoreBaseline,
} from "../../experiments/baseline/restore.js";
import {
  providerFetch,
  reproductionConditions,
} from "../../experiments/baseline/reproduce.js";
import type { RetrievalBaseline } from "../../experiments/baseline/retrieval.js";
import type {
  ModeSummary,
  ModelCallRecord,
  RetrievalRecord,
  RetrievalResultRecord,
  RunReport,
} from "../../experiments/replay/artifacts.js";
import type { Note } from "../../src/note-store/index.js";
import { defaultPrompts } from "../../src/index.js";

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
    expect(accounting.attempts.total).toBe(41);
    expect(accounting.attempts.byCurrentOutcome.failed).toBe(39);
    expect(accounting.attempts.byCurrentOutcome.stored).toBe(2);
    expect(accounting.attempts.receiptsWithMoreThanOneAttempt).toBe(1);
    expect(accounting.attempts.failureHistory.available).toBe(false);
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

  it("retains captured prompt text when a generation change replaces the defaults", () => {
    expect(
      promptSettingsStatus({
        prompts: { construction: "old construct", evolution: "old evolve" },
      }),
    ).toEqual({ retained: true, matchesCurrentDefaults: false });
    expect(
      promptSettingsStatus({
        prompts: {
          construction: defaultPrompts.construction,
          evolution: defaultPrompts.evolution,
        },
      }),
    ).toEqual({ retained: true, matchesCurrentDefaults: true });
    expect(
      promptSettingsStatus({
        prompts: { construction: "", evolution: "old evolve" },
      }),
    ).toEqual({ retained: false, matchesCurrentDefaults: false });
  });

  const withQdrant = async (
    handler: (url: string, requests: string[]) => Promise<void>,
  ): Promise<void> => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (
        request.method === "GET" &&
        (request.url ?? "").startsWith("/collections/")
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            result: { status: "green", points_count: 0 },
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
      await handler(`http://127.0.0.1:${String(address.port)}`, requests);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  };

  it("refuses the captured live collection without sending a request", async () => {
    const root = await writeBaseline();
    await withQdrant(async (url, requests) => {
      await expect(
        restoreBaseline({
          root,
          qdrant: { url },
          workDirectory: path.join(root, "restore-live-work"),
          collection: "nexus-memory",
        }),
      ).rejects.toThrow(/captured live collection/);
      expect(requests).toEqual([]);
    });
  });

  it("refuses an existing destination before uploading a snapshot", async () => {
    const root = await writeBaseline();
    await withQdrant(async (url, requests) => {
      await expect(
        restoreBaseline({
          root,
          qdrant: { url },
          workDirectory: path.join(root, "restore-existing-work"),
          collection: "another-collection",
          cleanup: true,
        }),
      ).rejects.toThrow(/already exists/);
      expect(
        requests.some((request) => request.includes("/snapshots/upload")),
      ).toBe(false);
      expect(requests.some((request) => request.startsWith("DELETE"))).toBe(
        false,
      );
    });
  });
});

describe("model-call classification", () => {
  const call = (overrides: Partial<ModelCallRecord> = {}): ModelCallRecord => ({
    callId: 1,
    stage: "construct",
    sourceId: "source-1",
    noteId: null,
    candidateIds: null,
    request: null,
    response: { context: "a note", keywords: ["a"], tags: [] },
    rawResponse: null,
    error: null,
    durationMs: 1,
    finishReason: "stop",
    usage: null,
    requestId: null,
    ...overrides,
  });

  it("validates a returned JSON null through the public contract", () => {
    const finding = classifyModelCall(call({ response: null }));
    expect(finding.outcome).toBe("contract-violation");
    expect(finding.categories).toEqual(["structure"]);
    expect(finding.issues.join(" ")).not.toBe("");
  });

  it("separates output failures from provider failures by the recorded category", () => {
    const output = classifyModelCall(
      call({
        error: {
          name: "HostModelTransportError",
          message: "The construct model request failed: output.",
          category: "output",
        },
      }),
    );
    expect(output).toMatchObject({
      outcome: "output-failure",
      categories: ["output"],
    });
    const provider = classifyModelCall(
      call({
        error: {
          name: "HostModelTransportError",
          message: "The construct model request failed: unavailable.",
          category: "unavailable",
        },
      }),
    );
    expect(provider).toMatchObject({
      outcome: "transport-failure",
      categories: ["unavailable"],
    });
    const uncategorized = classifyModelCall(
      call({ error: { name: "Error", message: "old record", category: null } }),
    );
    expect(uncategorized).toMatchObject({
      outcome: "transport-failure",
      categories: ["transport"],
    });
  });
});

describe("reproduction prompt-source attribution", () => {
  const sourceLine = `${JSON.stringify({
    sourceId: "source-1",
    content: "a retained source",
    timestamp: "2026-10-01T10:00:00Z",
  })}\n`;

  const modelCall = (
    overrides: Partial<ModelCallRecord> = {},
  ): ModelCallRecord => ({
    callId: 1,
    stage: "construct",
    sourceId: "source-1",
    noteId: null,
    candidateIds: null,
    request: null,
    response: { context: "a note", keywords: ["a"], tags: [] },
    rawResponse: null,
    error: null,
    durationMs: 1,
    finishReason: "stop",
    usage: null,
    requestId: null,
    ...overrides,
  });

  const writeRun = async (
    root: string,
    runId: string,
    options: {
      status?: string;
      promptTextSource?: string | null;
      calls?: readonly ModelCallRecord[];
    } = {},
  ): Promise<void> => {
    const directory = path.join(baselinePath(root, "runs"), runId);
    await mkdir(directory, { recursive: true });
    await writeJsonFile(path.join(directory, "manifest.json"), {
      runId,
      status: options.status ?? "completed",
      revision: "task/test@abc",
      fixture: {
        sourceHash: sha256Text(sourceLine),
        sourceCount: 1,
        queryHash: sha256Text(""),
        queryCount: 0,
        insertionOrder: ["source-1"],
      },
      timing: {
        startedAt: "2026-10-05T10:00:00Z",
        finishedAt: "2026-10-05T10:01:00Z",
        conditions:
          options.promptTextSource === undefined
            ? {}
            : { promptTextSource: options.promptTextSource },
      },
    });
    await writeFile(
      path.join(directory, "calls.jsonl"),
      (options.calls ?? []).map((call) => `${JSON.stringify(call)}\n`).join(""),
      "utf8",
    );
    await writeFile(path.join(directory, "changes.jsonl"), "", "utf8");
    await writeFile(
      path.join(directory, "sources.jsonl"),
      `${JSON.stringify({ outcome: "inserted" })}\n`,
      "utf8",
    );
  };

  it("attributes runs and every failing call to the recorded prompt source", async () => {
    const root = await tempDirectory();
    await mkdir(path.dirname(baselinePath(root, "reproductionSources")), {
      recursive: true,
    });
    await writeFile(
      baselinePath(root, "reproductionSources"),
      sourceLine,
      "utf8",
    );
    await writeRun(root, "baseline-run", {
      status: "failed",
      promptTextSource: "retained-baseline",
      calls: [
        modelCall(),
        modelCall({
          callId: 2,
          stage: "evolve",
          candidateIds: [],
          response: { links: ["not-a-candidate"], newTags: [], updates: [] },
        }),
      ],
    });
    await writeRun(root, "current-run", {
      promptTextSource: "current-defaults",
      calls: [
        modelCall(),
        modelCall({
          callId: 2,
          stage: "evolve",
          error: {
            name: "HostModelTransportError",
            message: "the model returned output that is not valid JSON.",
            category: "output",
          },
        }),
      ],
    });
    await writeRun(root, "unrecorded-run", {
      calls: [
        modelCall({
          callId: 1,
          error: {
            name: "HostModelTransportError",
            message: "unavailable",
            category: "unavailable",
          },
        }),
      ],
    });

    const report = await classifyReproductionRuns(root, {
      now: () => new Date("2026-10-05T12:00:00Z"),
    });

    expect(report.failingCalls).toBe(3);
    expect(report.runs.map((run) => run.promptTextSource)).toEqual([
      "retained-baseline",
      "current-defaults",
      null,
    ]);
    const bySource = new Map(
      report.promptSources.map((summary) => [
        summary.promptTextSource,
        summary,
      ]),
    );
    expect(bySource.get("retained-baseline")).toMatchObject({
      runs: 1,
      completed: 0,
      evolveCalls: 1,
      contractViolations: 1,
      outputFailures: 0,
      transportFailures: 0,
    });
    expect(bySource.get("current-defaults")).toMatchObject({
      runs: 1,
      completed: 1,
      evolveCalls: 1,
      contractViolations: 0,
      outputFailures: 1,
      transportFailures: 0,
    });
    expect(bySource.get(null)).toMatchObject({
      runs: 1,
      transportFailures: 1,
      outputFailures: 0,
      contractViolations: 0,
    });
    expect(report.limits.join(" ")).toContain("unrecorded");
  });

  it("records no prompt source when the manifest holds none or a non-string value", () => {
    expect(() =>
      recordedPromptTextSource({ timing: { conditions: {} } }),
    ).not.toThrow();
    expect(recordedPromptTextSource({ timing: { conditions: {} } })).toBeNull();
    expect(
      recordedPromptTextSource({
        timing: { conditions: { promptTextSource: null } },
      }),
    ).toBeNull();
    expect(
      recordedPromptTextSource({
        timing: { conditions: { promptTextSource: 7 } },
      }),
    ).toBeNull();
    expect(
      recordedPromptTextSource({
        timing: { conditions: { promptTextSource: "current-defaults" } },
      }),
    ).toBe("current-defaults");
  });
});

describe("linked-addition semantic review", () => {
  const retrieval = (): RetrievalBaseline =>
    ({
      records: [
        {
          queryId: "q1",
          query: "a known question",
          rationale: "declared",
          requiredSourceIds: ["required"],
          results: [
            { noteId: "required", origin: "match" },
            { noteId: "added-1", origin: "link" },
            { noteId: "added-2", origin: "link" },
          ],
        },
      ],
    }) as unknown as RetrievalBaseline;

  const review = (entries: LinkedReview["entries"]): LinkedReview => ({
    formatVersion: 1,
    reviewedAt: "2026-10-05T22:00:00Z",
    revision: "test-revision",
    retrievalSha256: "sha256:test",
    entries,
    limits: ["reviewed by hand"],
  });

  it("counts verdicts with the addition total as the assessed-sample denominator", () => {
    expect(linkedAdditionsBeyondExpected(retrieval())).toHaveLength(2);
    const summary = summarizeLinkedReview({
      retrieval: retrieval(),
      review: review([
        {
          queryId: "q1",
          noteId: "added-1",
          verdict: "useful",
          reason: "supports the question",
        },
        {
          queryId: "q1",
          noteId: "added-2",
          verdict: "unrelated",
          reason: "different subject",
        },
      ]),
    });
    expect(summary).toMatchObject({
      assessed: 2,
      denominator: 2,
      unassessed: 0,
      useful: 1,
      unrelated: 1,
      unresolved: 0,
    });
  });

  it("leaves additions the review did not assess explicit and refuses unknown entries", () => {
    const summary = summarizeLinkedReview({
      retrieval: retrieval(),
      review: review([
        {
          queryId: "q1",
          noteId: "added-1",
          verdict: "unresolved",
          reason: "needs more context",
        },
      ]),
    });
    expect(summary).toMatchObject({
      assessed: 1,
      denominator: 2,
      unassessed: 1,
      unresolved: 1,
    });
    expect(() =>
      summarizeLinkedReview({
        retrieval: retrieval(),
        review: review([
          {
            queryId: "q1",
            noteId: "not-an-addition",
            verdict: "useful",
            reason: "wrong identity",
          },
        ]),
      }),
    ).toThrow(/not a captured linked addition/);
    expect(() =>
      summarizeLinkedReview({
        retrieval: retrieval(),
        review: review([
          {
            queryId: "q1",
            noteId: "added-1",
            verdict: "useful",
            reason: "first",
          },
          {
            queryId: "q1",
            noteId: "added-1",
            verdict: "unrelated",
            reason: "second",
          },
        ]),
      }),
    ).toThrow(/more than once/);
  });

  it("reports an absent review as unmeasured instead of zero", async () => {
    const root = await tempDirectory();
    expect(await readLinkedReviewSummary(root)).toBeNull();
  });
});

describe("provider request adjustment", () => {
  it("adjusts a JSON body and propagates a rejected request without retrying", async () => {
    const bodies: unknown[] = [];
    const wrapped = providerFetch({
      mode: "deepseek-json-object",
      fetch: async (_input, init) => {
        bodies.push(init?.body);
        throw new TypeError("network down");
      },
    });
    await expect(
      wrapped("https://provider.example/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "test", messages: [] }),
      }),
    ).rejects.toThrow("network down");
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(String(bodies[0])) as Record<string, unknown>;
    expect(body["thinking"]).toEqual({ type: "disabled" });
    expect(body["response_format"]).toEqual({ type: "json_object" });
  });

  it("forwards a non-JSON body unchanged and an unchanged request as-is", async () => {
    const received: unknown[] = [];
    const wrapped = providerFetch({
      mode: "deepseek-json-object",
      fetch: async (_input, init) => {
        received.push(init?.body);
        return new Response("{}");
      },
    });
    await wrapped("https://provider.example/chat/completions", {
      method: "POST",
      body: "not json",
    });
    expect(received).toEqual(["not json"]);
    const raw = providerFetch({
      mode: "unchanged",
      fetch: async (_input, init) => {
        received.push(init?.body);
        return new Response("{}");
      },
    });
    await raw("https://provider.example/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "test" }),
    });
    expect(received[1]).toBe(JSON.stringify({ model: "test" }));
  });

  it("records the executing revision provenance and prompt source explicitly", () => {
    expect(
      reproductionConditions({
        providerRequestMode: "deepseek-json-object",
        baselineRevision: "task/AMEM-17@67f3d98",
        promptTextSource: "retained-baseline",
      }),
    ).toEqual({
      providerRequestMode: "deepseek-json-object",
      providerAdjustments:
        "thinking disabled and JSON-object response format applied",
      baselineRevision: "task/AMEM-17@67f3d98",
      promptTextSource: "retained-baseline",
    });
    expect(
      reproductionConditions({
        providerRequestMode: "unchanged",
        baselineRevision: "base",
        promptTextSource: "current-defaults",
      }),
    ).toMatchObject({
      providerAdjustments: "request sent unchanged",
      promptTextSource: "current-defaults",
    });
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

describe("matched isolated comparison", () => {
  const note = (id: string, context: string): Note => ({
    id,
    content: `Source of ${id}`,
    timestamp: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:01Z",
    context,
    keywords: ["keyword"],
    tags: ["tag"],
    links: [],
  });

  const result = (
    noteId: string,
    origin: "match" | "link",
    score: number,
  ): RetrievalResultRecord => {
    const searched = note(noteId, `Context of ${noteId}`);
    return {
      noteId,
      sourceId: noteId,
      origin,
      score: origin === "match" ? score : null,
      note: searched,
      characters: { content: 10, attributes: 5, total: 15 },
    };
  };

  const modeSummary = (
    mode: string,
    overrides: Partial<ModeSummary> = {},
  ): ModeSummary => ({
    representation: mode,
    queries: 2,
    queriesWithExpectations: 1,
    firstResultRequired: { recovered: 1, denominator: 1 },
    allRequiredDirectTopK: { recovered: 1, denominator: 1 },
    allRequiredWithLinks: { recovered: 1, denominator: 1 },
    linkRecoveredQueries: 0,
    linkRecoveredSources: 0,
    multiSourceQueries: 0,
    returnedNotes: 3,
    returnedCharacters: { direct: 30, linked: 15, total: 45 },
    latency: { samples: 2, medianMs: 1, p95Ms: 1, minMs: 1, maxMs: 1 },
    ...overrides,
  });

  const record = (
    mode: string,
    queryId: string,
    required: readonly string[],
    results: readonly RetrievalResultRecord[],
    linkedLimit: number,
  ): RetrievalRecord => ({
    mode,
    representation: "amem-note-v1",
    collection: "collection",
    queryId,
    query: `query ${queryId}`,
    scope: null,
    rationale: `rationale ${queryId}`,
    requiredSourceIds: [...required],
    limits: { direct: 5, linked: linkedLimit },
    latencyMs: 1,
    results: [...results],
    recovery: {
      firstResultRequired: true,
      directRequired: [...required],
      linkedOnlyRequired: [],
      missingRequired: [],
    },
  });

  const writeRun = async (
    root: string,
    runId: string,
    overrides: {
      status?: string;
      revision?: string;
      promptTextSource?: string;
      providerRequestMode?: string;
      insertionOrder?: string[];
      excludedSources?: string[];
      modelId?: string;
      memory?: { neighbors: number; directLimit: number; linkedLimit: number };
      additions?: number;
      firstResultRecovered?: number;
      insertionFailures?: number;
      insertions?: number;
    } = {},
  ): Promise<void> => {
    const directory = path.join(baselinePath(root, "runs"), runId);
    await mkdir(directory, { recursive: true });
    const fixtureOrder = overrides.insertionOrder ?? ["source-1", "source-2"];
    const excluded = overrides.excludedSources ?? [];
    const inserted = fixtureOrder.filter((id) => !excluded.includes(id));
    const insertions = overrides.insertions ?? inserted.length;
    const additions = overrides.additions ?? 1;
    const linkedResults = [
      ...inserted.map((sourceId) => result(sourceId, "match", 0.5)),
      ...Array.from({ length: additions }, (_value, index) =>
        result(`linked-${String(index + 1)}`, "link", 0),
      ),
    ];
    await writeJsonFile(path.join(directory, "manifest.json"), {
      runId,
      status: overrides.status ?? "completed",
      revision: overrides.revision ?? "task/test@abc",
      fixture: {
        sourceHash: sha256Text("fixture"),
        queryHash: sha256Text("queries"),
        sourceCount: fixtureOrder.length,
        queryCount: 1,
        insertionOrder: inserted,
      },
      prompts: { ...defaultPrompts },
      encoder: {
        spaceId: "sha256:space",
        dimensions: 4,
        settings: null,
      },
      model: {
        endpoint: "http://127.0.0.1:9/chat",
        id: overrides.modelId ?? "test-model",
      },
      storage: {
        kind: "in-memory",
        endpoint: null,
        schemaVersion: 1,
        representation: "amem-note-v1",
        collections: {},
      },
      memory: overrides.memory ?? {
        neighbors: 5,
        directLimit: 5,
        linkedLimit: 3,
      },
      budget: null,
      timing: {
        startedAt: "2026-10-05T10:00:00Z",
        finishedAt: "2026-10-05T10:01:00Z",
        conditions: {
          promptTextSource: overrides.promptTextSource ?? "current-defaults",
          providerRequestMode: overrides.providerRequestMode ?? "unchanged",
        },
      },
    });
    await writeJsonFile(path.join(directory, "report.json"), {
      runId,
      revision: overrides.revision ?? "task/test@abc",
      status: overrides.status ?? "completed",
      counts: {
        sources: fixtureOrder.length,
        queries: 1,
        insertions,
        insertionFailures: overrides.insertionFailures ?? 0,
        finalNotes: insertions,
        directedLinks: 1,
        embeddingCalls: insertions,
        modelCalls: { construct: insertions, evolve: 1, total: insertions + 1 },
        failedModelCalls: 0,
      },
      retrieval: {
        "evolved-direct": modeSummary("evolved-direct", {
          firstResultRequired: {
            recovered: overrides.firstResultRecovered ?? 1,
            denominator: 1,
          },
        }),
        "evolved-linked": modeSummary("evolved-linked", {
          firstResultRequired: {
            recovered: overrides.firstResultRecovered ?? 1,
            denominator: 1,
          },
          returnedCharacters: {
            direct: 30,
            linked: 15 * additions,
            total: 30 + 15 * additions,
          },
        }),
      },
      exclusions: { sources: [...excluded], queries: [], note: "test" },
    } as unknown as RunReport);
    await writeFile(
      path.join(directory, "retrieval.jsonl"),
      `${[record("evolved-linked", "q1", ["source-1"], linkedResults, 3)]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );
  };

  it("reports linked additions and direct recovery for a matched pair", async () => {
    const root = await tempDirectory();
    await writeRun(root, "before-run", {
      promptTextSource: "retained-baseline",
      additions: 2,
      firstResultRecovered: 1,
    });
    await writeRun(root, "after-run", {
      promptTextSource: "current-defaults",
      additions: 1,
      firstResultRecovered: 0,
    });

    const comparison = await compareMatchedRuns({
      root,
      beforeRunId: "before-run",
      afterRunId: "after-run",
      now: () => new Date("2026-10-05T12:00:00Z"),
    });

    expect(comparison.matched.difference).toBe("prompt text source only");
    expect(comparison.before.additions).toHaveLength(2);
    expect(comparison.after.additions).toHaveLength(1);
    expect(comparison.deltas.linkedAdditions).toBe(-1);
    expect(comparison.deltas.directFirstResultRecovered).toBe(-1);
    expect(comparison.after.additions[0]?.context).toBe("Context of linked-1");
    const written = JSON.parse(
      await readFile(baselinePath(root, "matchedComparison"), "utf8"),
    ) as { after: { runId: string } };
    expect(written.after.runId).toBe("after-run");
  });

  it("refuses a pair that differs in anything but the prompt source", async () => {
    const root = await tempDirectory();
    await writeRun(root, "before-run", {
      promptTextSource: "retained-baseline",
    });
    await writeRun(root, "after-run", {
      promptTextSource: "current-defaults",
    });
    await writeRun(root, "different-order", {
      promptTextSource: "current-defaults",
      insertionOrder: ["source-2", "source-1"],
    });
    await writeRun(root, "different-exclusion", {
      promptTextSource: "current-defaults",
      excludedSources: ["source-2"],
    });
    await writeRun(root, "different-limits", {
      promptTextSource: "current-defaults",
      memory: { neighbors: 5, directLimit: 5, linkedLimit: 2 },
    });
    await writeRun(root, "different-model", {
      promptTextSource: "current-defaults",
      modelId: "another-model",
    });
    await writeRun(root, "failed-run", {
      promptTextSource: "current-defaults",
      status: "failed",
    });

    await expect(
      compareMatchedRuns({
        root,
        beforeRunId: "before-run",
        afterRunId: "different-order",
      }),
    ).rejects.toThrow(MatchedComparisonError);
    await expect(
      compareMatchedRuns({
        root,
        beforeRunId: "before-run",
        afterRunId: "different-exclusion",
      }),
    ).rejects.toThrow(/source membership/);
    await expect(
      compareMatchedRuns({
        root,
        beforeRunId: "before-run",
        afterRunId: "different-limits",
      }),
    ).rejects.toThrow(/limits/);
    await expect(
      compareMatchedRuns({
        root,
        beforeRunId: "before-run",
        afterRunId: "different-model",
      }),
    ).rejects.toThrow(/model transports/);
    await expect(
      compareMatchedRuns({
        root,
        beforeRunId: "before-run",
        afterRunId: "failed-run",
      }),
    ).rejects.toThrow(/not completed/);
  });

  it("binds a run's reviewed verdicts to that run's retrieval evidence", async () => {
    const root = await tempDirectory();
    await writeRun(root, "before-run", {
      promptTextSource: "retained-baseline",
      additions: 1,
    });
    await writeRun(root, "after-run", {
      promptTextSource: "current-defaults",
      additions: 1,
    });
    const afterDirectory = path.join(baselinePath(root, "runs"), "after-run");
    const review = {
      formatVersion: 1,
      reviewedAt: "2026-10-05T12:00:00Z",
      revision: "task/test@abc",
      retrievalSha256: await sha256File(
        path.join(afterDirectory, "retrieval.jsonl"),
      ),
      entries: [
        {
          queryId: "q1",
          noteId: "linked-1",
          verdict: "unrelated",
          reason: "the addition belongs to another mechanism",
        },
      ],
      limits: ["one addition reviewed"],
    };
    await writeJsonFile(path.join(afterDirectory, runLinkedReviewFile), review);

    const evidence = await readMatchedRun(root, "after-run");
    expect(evidence.semanticReview?.assessed).toBe(1);
    expect(evidence.semanticReview?.unrelated).toBe(1);
    expect(evidence.semanticReview?.denominator).toBe(1);

    await writeJsonFile(path.join(afterDirectory, runLinkedReviewFile), {
      ...review,
      retrievalSha256: sha256Text("not this evidence"),
    });
    await expect(readMatchedRun(root, "after-run")).rejects.toThrow(
      /does not belong to this run's retrieval evidence/,
    );
  });
});
