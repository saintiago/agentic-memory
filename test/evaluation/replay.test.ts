import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { EmbeddedNote, Note, NoteStore } from "../../src/index.js";
import {
  RunDirectoryError,
  type ChangeRecord,
  type ConstructionRecord,
  type CostRates,
  type ModelCallRecord,
  type RetrievalRecord,
  type RunManifest,
  type RunReport,
  type SourceRecord,
  type FinalNoteRecord,
} from "../../experiments/replay/artifacts.js";
import { createInMemoryEnvironment } from "../../experiments/replay/environment.js";
import type { EvaluationEnvironment } from "../../experiments/replay/environment.js";
import { readEvolutionEnvelope } from "../../experiments/replay/envelope.js";
import { FixtureError, fixtureHash } from "../../experiments/replay/fixture.js";
import type { ModelBudget } from "../../experiments/replay/recorder.js";
import {
  runReplay,
  type ReplayResult,
  type ReplayRunOptions,
} from "../../experiments/replay/runner.js";
import {
  defaultDemoRunsDirectory,
  runDeterministicDemo,
} from "../../experiments/demo/demo-run.js";
import {
  modelDescription,
  ScriptedModel,
  testQueries,
  testSources,
  TokenEmbedder,
} from "./support/harness.js";

/**
 * The replay harness through its own public behavior: fixtures, artifacts, comparison modes,
 * failures and budget stops. The store is the in-memory consumer replacement and the model is
 * scripted, so the cases are deterministic and offline.
 *
 * See docs/evaluation.md and docs/testing.md#test-discipline.
 */

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "amem-eval-"));
  directories.push(directory);
  return directory;
};

afterAll(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
});

const readJsonl = async <T>(directory: string, file: string): Promise<T[]> => {
  const text = await readFile(path.join(directory, file), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
};

const readJson = async <T>(directory: string, file: string): Promise<T> =>
  JSON.parse(await readFile(path.join(directory, file), "utf8")) as T;

const RATES: CostRates = {
  currency: "USD",
  effectiveDate: "2026-09-01",
  uncachedInputPerMillion: 1,
  cachedInputPerMillion: 0.5,
  outputPerMillion: 2,
};

/** The three constructions and two evolutions a full three-source replay issues, in order. */
const scriptedModel = (): ScriptedModel =>
  new ScriptedModel()
    .queue("construct", () => ({
      context: "Records the alpha procedure approval requirement.",
      keywords: ["alpha", "approval"],
      tags: ["procedure"],
    }))
    .queue("construct", () => ({
      context: "Records the granted alpha procedure approval.",
      keywords: ["alpha", "approval", "record"],
      tags: ["procedure"],
    }))
    .queue("evolve", (request) => {
      const { incoming, neighbors } = readEvolutionEnvelope(request.prompt);
      const related = neighbors
        .filter(
          (neighbor) =>
            neighbor.content.includes("alpha") &&
            incoming.content.includes("alpha"),
        )
        .map((neighbor) => neighbor.id);
      return {
        links: related,
        newTags: [...incoming.tags, "linked"],
        updates: [],
      };
    })
    .queue("construct", () => ({
      context: "Records the beta routine result.",
      keywords: ["beta", "routine"],
      tags: ["routine"],
    }))
    .queue("evolve", () => ({ links: [], newTags: [], updates: [] }));

const replayOptions = async (input: {
  model: ScriptedModel;
  runId?: string;
  budget?: ModelBudget | null;
  excludeSources?: string[];
  excludeQueries?: string[];
  costRates?: CostRates | null;
  runsDirectory?: string;
}): Promise<ReplayRunOptions> => {
  const runsDirectory = input.runsDirectory ?? (await temporaryDirectory());
  const embedder = new TokenEmbedder();
  const options: ReplayRunOptions = {
    runId: input.runId ?? "replay-case",
    revision: "test-revision",
    runsDirectory,
    sources: testSources,
    queries: testQueries,
    sourceHash: fixtureHash("sources-fixture"),
    queryHash: fixtureHash("queries-fixture"),
    environment: createInMemoryEnvironment({
      embedder,
      model: input.model,
      exchangeLog: input.model.exchanges,
      encoderSettings: { kind: "test-token-embedder", dimensions: 4 },
      modelDescription,
    }),
    recordRawExchanges: true,
  };
  if (input.budget != null) {
    options.budget = input.budget;
  }
  if (input.costRates != null) {
    options.costRates = input.costRates;
  }
  if (input.excludeSources !== undefined) {
    options.excludeSources = input.excludeSources;
  }
  if (input.excludeQueries !== undefined) {
    options.excludeQueries = input.excludeQueries;
  }
  return options;
};

/** Wrap one environment so its first writes succeed and a later one is rejected by the store. */
const failingWriteEnvironment = (
  base: EvaluationEnvironment,
  successfulWrites: number,
): EvaluationEnvironment => ({
  ...base,
  async openCollection(request) {
    const opened = await base.openCollection(request);
    let writes = 0;
    const store: NoteStore = {
      async put(records: EmbeddedNote[]): Promise<void> {
        writes += 1;
        if (writes > successfulWrites) {
          throw new Error("the store rejected the batch");
        }
        await opened.store.put(records);
      },
      get: (ids) => opened.store.get(ids),
      nearest: (vector, limit) => opened.store.nearest(vector, limit),
      page: (limit, cursor) => opened.store.page(limit, cursor),
    };
    return { store, collection: opened.collection };
  },
});

describe("replay runner", () => {
  it("writes the documented artifacts for a completed run", async () => {
    const result = await runReplay(
      await replayOptions({ model: scriptedModel() }),
    );

    expect(result.status).toBe("completed");
    expect(result.failure).toBeNull();
    expect(result.stoppingReason).toBeNull();
    const files = await Promise.all(
      result.report.artifacts.map((file) =>
        stat(path.join(result.directory, file)).then(() => file),
      ),
    );
    expect(files).toEqual(result.report.artifacts);

    const sources = await readJsonl<SourceRecord>(
      result.directory,
      "sources.jsonl",
    );
    expect(sources.map((record) => record.sourceId)).toEqual(
      testSources.map((source) => source.sourceId),
    );
    for (const record of sources) {
      expect(record.content).toBe(
        testSources.find((source) => source.sourceId === record.sourceId)
          ?.content,
      );
      expect(record.noteId).toMatch(/^[0-9a-f-]{36}$/);
    }

    const construction = await readJsonl<ConstructionRecord>(
      result.directory,
      "construction.jsonl",
    );
    expect(construction.map((record) => record.sourceId)).toEqual(
      testSources.map((source) => source.sourceId),
    );
    expect(construction[0]?.attributes).toEqual({
      context: "Records the alpha procedure approval requirement.",
      keywords: ["alpha", "approval"],
      tags: ["procedure"],
    });
    expect(construction[0]?.noteId).toBe(sources[0]?.noteId);

    const calls = await readJsonl<ModelCallRecord>(
      result.directory,
      "calls.jsonl",
    );
    expect(calls.map((call) => call.stage)).toEqual([
      "construct",
      "construct",
      "evolve",
      "construct",
      "evolve",
    ]);
    expect(calls.every((call) => call.error === null)).toBe(true);
    expect(calls.every((call) => call.request !== null)).toBe(true);
    expect(calls[0]?.sourceId).toBe("alpha-requirement");
    // Every call is correlated with the note its insertion allocated.
    for (const call of calls) {
      const source = sources.find(
        (record) => record.sourceId === call.sourceId,
      );
      expect(call.noteId).toBe(source?.noteId);
    }

    const changes = await readJsonl<ChangeRecord>(
      result.directory,
      "changes.jsonl",
    );
    expect(changes).toHaveLength(3);
    const [first, second] = changes;
    expect(first?.kind).toBe("insertion");
    if (first?.kind !== "insertion") {
      throw new Error("expected the first insertion change");
    }
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]?.before).toBeNull();
    expect(first.changes[0]?.after.links).toEqual([]);
    if (second?.kind !== "insertion") {
      throw new Error("expected the second insertion change");
    }
    // The second insertion links the first note and changes only the incoming note.
    expect(second.changes).toHaveLength(1);
    expect(second.changes[0]?.before).toBeNull();
    expect(second.changes[0]?.after.links).toHaveLength(1);

    const notes = await readJsonl<FinalNoteRecord>(
      result.directory,
      "notes.jsonl",
    );
    expect(notes).toHaveLength(3);
    for (const record of notes) {
      expect(record.note.content).toBe(
        testSources.find((source) => source.sourceId === record.sourceId)
          ?.content,
      );
    }

    const retrieval = await readJsonl<RetrievalRecord>(
      result.directory,
      "retrieval.jsonl",
    );
    expect(retrieval).toHaveLength(4 * testQueries.length);
    expect(new Set(retrieval.map((record) => record.mode))).toEqual(
      new Set([
        "original-content",
        "constructed",
        "evolved-direct",
        "evolved-linked",
      ]),
    );
    for (const record of retrieval) {
      for (const result of record.results) {
        if (result.origin === "match") {
          expect(typeof result.score).toBe("number");
        } else {
          expect(result.score).toBeNull();
        }
      }
    }

    const report = await readJson<RunReport>(result.directory, "report.json");
    expect(report.status).toBe("completed");
    expect(report.counts).toMatchObject({
      sources: 3,
      queries: 2,
      insertions: 3,
      insertionFailures: 0,
      finalNotes: 3,
      modelCalls: { construct: 3, evolve: 2, total: 5 },
      failedModelCalls: 0,
    });
    expect(report.generation).toMatchObject({
      totalSuccessful: 5,
      upperBound: 5,
      withinBound: true,
    });
    expect(report.retrieval["original-content"]).toMatchObject({
      queries: 2,
      queriesWithExpectations: 2,
      firstResultRequired: { denominator: 2 },
      allRequiredDirectTopK: { denominator: 2 },
    });
    expect(report.retrieval["evolved-linked"]?.multiSourceQueries).toBe(1);
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(report.counts.embeddingCalls).toBeGreaterThanOrEqual(3);
    expect(report.context).toMatchObject({
      corpusNotes: 3,
      encoderDimensions: 4,
      limits: { neighbors: 5, direct: 5, linked: 5 },
      concurrency: 1,
    });
    expect(report.context.sourceCharacters.max).toBeGreaterThan(0);
    expect(report.storage).toEqual({
      notes: 3,
      dimensions: 4,
      rawVectorBytes: 48,
      note:
        "Raw float32 vectors only; payloads, indexes, WAL, replicas, allocator overhead and " +
        "backups are excluded.",
    });
    expect(report.timings.search["evolved-linked"]?.all.samples).toBe(2);
    expect(report.timings.search["evolved-linked"]?.coldMs).not.toBeNull();
    expect(report.limits).toEqual([]);
    expect(report.extrapolations).toEqual([]);

    const manifest = await readJson<RunManifest>(
      result.directory,
      "manifest.json",
    );
    expect(manifest.status).toBe("completed");
    expect(manifest.fixture.insertionOrder).toEqual(
      testSources.map((source) => source.sourceId),
    );
    expect(manifest.storage.collections["runtime"]).toContain("amem-note-v1");
    expect(manifest.storage.collections["original-content"]).toContain(
      "amem-eval-raw-content-v1",
    );
    expect(manifest.timing.finishedAt).not.toBeNull();
  });

  it("produces the same notes and measures on a second run of the same fixture", async () => {
    const first = await runReplay(
      await replayOptions({ model: scriptedModel(), runId: "first" }),
    );
    const second = await runReplay(
      await replayOptions({ model: scriptedModel(), runId: "second" }),
    );
    const notesOf = async (result: ReplayResult): Promise<Note[]> =>
      (await readJsonl<FinalNoteRecord>(result.directory, "notes.jsonl")).map(
        (record) => record.note,
      );
    /** Compare the decisions a run made, not the fresh UUIDs it allocated. */
    const decisions = (note: Note): unknown => ({
      content: note.content,
      timestamp: note.timestamp,
      context: note.context,
      keywords: note.keywords,
      tags: note.tags,
      metadata: note.metadata ?? null,
      linkCount: note.links.length,
    });
    expect((await notesOf(second)).map(decisions)).toEqual(
      (await notesOf(first)).map(decisions),
    );
    const withoutLatency = (report: RunReport): unknown => ({
      counts: report.counts,
      generation: report.generation,
      retrieval: Object.fromEntries(
        Object.entries(report.retrieval).map(([mode, summary]) => [
          mode,
          { ...summary, latency: undefined },
        ]),
      ),
      checks: report.checks.map((check) => [check.name, check.ok]),
    });
    expect(withoutLatency(second.report)).toEqual(withoutLatency(first.report));
  });

  it("refuses to reuse an existing run directory", async () => {
    const runsDirectory = await temporaryDirectory();
    await runReplay(
      await replayOptions({
        model: scriptedModel(),
        runId: "kept",
        runsDirectory,
      }),
    );
    await expect(
      runReplay(
        await replayOptions({
          model: scriptedModel(),
          runId: "kept",
          runsDirectory,
        }),
      ),
    ).rejects.toBeInstanceOf(RunDirectoryError);
    const report = await readJson<RunReport>(
      path.join(runsDirectory, "kept"),
      "report.json",
    );
    expect(report.status).toBe("completed");
  });

  it("refuses a run ID that is not a directory name", async () => {
    await expect(
      runReplay(
        await replayOptions({ model: scriptedModel(), runId: "bad:id" }),
      ),
    ).rejects.toBeInstanceOf(RunDirectoryError);
  });

  it("rejects an impossible search limit before creating a run", async () => {
    const model = scriptedModel();
    const options = await replayOptions({ model, runId: "bad-limits" });
    options.directLimit = 0;
    await expect(runReplay(options)).rejects.toBeInstanceOf(FixtureError);
    expect(model.requests).toHaveLength(0);
  });

  it("rejects an invalid fixture before any run directory or model call", async () => {
    const runsDirectory = await temporaryDirectory();
    const model = scriptedModel();
    const options = await replayOptions({
      model,
      runId: "invalid",
      runsDirectory,
    });
    options.sources = [
      ...testSources,
      {
        sourceId: "alpha-requirement",
        content: "A duplicate source ID.",
        timestamp: "2026-09-04T10:00:00Z",
      },
    ];
    await expect(runReplay(options)).rejects.toBeInstanceOf(FixtureError);
    expect(model.requests).toHaveLength(0);
    await expect(stat(path.join(runsDirectory, "invalid"))).rejects.toThrow();
  });

  it("records a failed insertion and skips comparison retrieval", async () => {
    const model = new ScriptedModel()
      .queue("construct", () => ({
        context: "The first note is constructed.",
        keywords: ["alpha"],
        tags: [],
      }))
      .queue("construct", () => ({ context: 42 }));
    const result = await runReplay(
      await replayOptions({ model, runId: "failed" }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({
      sourceId: "alpha-record",
      operation: "add",
      stage: "construct",
      persistence: "unchanged",
    });
    const changes = await readJsonl<ChangeRecord>(
      result.directory,
      "changes.jsonl",
    );
    expect(changes.map((change) => change.kind)).toEqual([
      "insertion",
      "failure",
    ]);
    const failed = changes[1];
    if (failed?.kind !== "failure") {
      throw new Error("expected a failure change");
    }
    expect(failed.persistence).toBe("unchanged");
    expect(failed.noteId).not.toBeNull();
    expect(await readJsonl(result.directory, "retrieval.jsonl")).toHaveLength(
      0,
    );
    expect(
      await readJsonl<SourceRecord>(result.directory, "sources.jsonl"),
    ).toHaveLength(1);
    expect(
      await readJsonl<FinalNoteRecord>(result.directory, "notes.jsonl"),
    ).toHaveLength(1);
    expect(result.report.counts).toMatchObject({
      insertions: 1,
      insertionFailures: 1,
      // The transport returned a value; Memory rejected it, so the call itself did not fail.
      failedModelCalls: 0,
    });
    const calls = await readJsonl<ModelCallRecord>(
      result.directory,
      "calls.jsonl",
    );
    expect(calls[1]?.error).toBeNull();
    expect(calls[1]?.response).toEqual({ context: 42 });
    expect(result.report.failures[0]?.stage).toBe("construct");
    expect(result.report.retrieval["original-content"]?.queries).toBe(0);
  });

  it("records a transport failure and leaves the run totals unknown", async () => {
    const model = new ScriptedModel()
      .queue("construct", () => ({
        context: "The first note is constructed.",
        keywords: ["alpha"],
        tags: [],
      }))
      .queue("construct", () => {
        throw new Error("the provider did not answer");
      });
    const result = await runReplay(
      await replayOptions({ model, runId: "transport-failure" }),
    );
    expect(result.status).toBe("failed");
    expect(result.report.counts.failedModelCalls).toBe(1);
    expect(result.report.usage).toMatchObject({
      known: false,
      uncachedInputTokens: null,
    });
    expect(result.report.cost).toMatchObject({ known: false, total: null });
    const calls = await readJsonl<ModelCallRecord>(
      result.directory,
      "calls.jsonl",
    );
    expect(calls[1]?.error?.message).toBe("the provider did not answer");
  });

  it("keeps the prepared batch of a rejected write reviewable", async () => {
    const options = await replayOptions({
      model: scriptedModel(),
      runId: "uncertain",
    });
    // The first batch acknowledges; the second write attempt is rejected by the store.
    options.environment = failingWriteEnvironment(options.environment, 1);
    const result = await runReplay(options);

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({
      sourceId: "alpha-record",
      operation: "add",
      stage: "persist",
      persistence: "uncertain",
    });
    expect(result.failure?.affectedNoteIds.length).toBeGreaterThan(0);
    const changes = await readJsonl<ChangeRecord>(
      result.directory,
      "changes.jsonl",
    );
    const failed = changes[1];
    if (failed?.kind !== "failure") {
      throw new Error("expected a failure change");
    }
    expect(failed.persistence).toBe("uncertain");
    expect(failed.prepared.length).toBeGreaterThan(0);
    expect(failed.prepared.map((entry) => entry.note.content)).toContain(
      "An operator granted the alpha procedure approval.",
    );
    expect(result.report.counts.insertions).toBe(1);
  });

  it("honours an explicit insertion order and rejects a non-permutation", async () => {
    const runsDirectory = await temporaryDirectory();
    const options = await replayOptions({
      model: scriptedModel(),
      runId: "ordered",
      runsDirectory,
    });
    const order = ["beta-observation", "alpha-record", "alpha-requirement"];
    const result = await runReplay({ ...options, insertionOrder: order });
    expect(result.manifest.fixture.insertionOrder).toEqual(order);
    const sources = await readJsonl<SourceRecord>(
      result.directory,
      "sources.jsonl",
    );
    expect(sources.map((record) => record.sourceId)).toEqual(order);

    const model = scriptedModel();
    await expect(
      runReplay({
        ...(await replayOptions({
          model,
          runId: "bad-order",
          runsDirectory,
        })),
        insertionOrder: ["beta-observation", "beta-observation"],
      }),
    ).rejects.toBeInstanceOf(FixtureError);
    expect(model.requests).toHaveLength(0);
  });

  it("stops on the declared call budget and records the reason", async () => {
    const result = await runReplay(
      await replayOptions({
        model: scriptedModel(),
        runId: "budget",
        budget: { callBudget: 2, tokenBudget: 1_000_000 },
      }),
    );
    expect(result.status).toBe("stopped");
    expect(result.stoppingReason).toBe("call-budget");
    expect(result.report.stoppingReason).toBe("call-budget");
    const changes = await readJsonl<ChangeRecord>(
      result.directory,
      "changes.jsonl",
    );
    expect(changes.map((change) => change.kind)).toEqual([
      "insertion",
      "budget",
    ]);
    expect(result.report.counts.modelCalls.total).toBe(2);
    // A stopped run still evaluates the comparisons over the notes it did insert.
    expect(await readJsonl(result.directory, "retrieval.jsonl")).toHaveLength(
      4 * testQueries.length,
    );
  });

  it("stops on the declared token budget and keeps unknown usage unknown", async () => {
    const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 };
    const model = new ScriptedModel()
      .queue(
        "construct",
        () => ({
          context: "Records the alpha procedure approval requirement.",
          keywords: ["alpha"],
          tags: [],
        }),
        usage,
      )
      .queue(
        "construct",
        () => ({
          context: "Records the granted alpha procedure approval.",
          keywords: ["alpha"],
          tags: [],
        }),
        usage,
      );
    const result = await runReplay(
      await replayOptions({
        model,
        runId: "token-budget",
        budget: { callBudget: 100, tokenBudget: 20 },
        costRates: RATES,
      }),
    );
    expect(result.status).toBe("stopped");
    expect(result.stoppingReason).toBe("token-budget");
    expect(result.report.counts.modelCalls.total).toBe(2);
    expect(result.report.usage).toMatchObject({
      known: true,
      uncachedInputTokens: 20,
      outputTokens: 10,
    });
    // (20 * 1 + 0 * 0.5 + 10 * 2) / 1_000_000
    expect(result.report.cost.total).toBeCloseTo(0.00004, 10);
    expect(result.report.cost.known).toBe(true);
  });

  it("records excluded sources and queries as input exclusions", async () => {
    const options = await replayOptions({
      model: scriptedModel(),
      runId: "exclusions",
      excludeSources: ["beta-observation"],
      excludeQueries: ["beta-observation"],
    });
    options.semanticReview = [
      {
        id: "review-1",
        queryId: "alpha-approval",
        noteId: null,
        finding: "The second result preserved the record's historical tense.",
      },
    ];
    const result = await runReplay(options);
    expect(result.status).toBe("completed");
    expect(result.report.exclusions.sources).toEqual(["beta-observation"]);
    expect(result.report.exclusions.queries).toEqual(["beta-observation"]);
    expect(result.report.semanticReview).toEqual([
      {
        id: "review-1",
        queryId: "alpha-approval",
        noteId: null,
        finding: "The second result preserved the record's historical tense.",
      },
    ]);
    expect(
      await readJsonl<SourceRecord>(result.directory, "sources.jsonl"),
    ).toHaveLength(2);
    expect(
      await readJsonl<RetrievalRecord>(result.directory, "retrieval.jsonl"),
    ).toHaveLength(4 * 1);
  });
});

describe("deterministic demonstration", () => {
  it("runs the committed fixtures twice with the same decisions", async () => {
    const firstDirectory = await temporaryDirectory();
    const secondDirectory = await temporaryDirectory();
    const first = await runDeterministicDemo({
      runsDirectory: firstDirectory,
      runId: "demo-first",
      revision: "test-revision",
    });
    const second = await runDeterministicDemo({
      runsDirectory: secondDirectory,
      runId: "demo-second",
      revision: "test-revision",
    });
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(first.report.checks.every((check) => check.ok)).toBe(true);
    expect(first.report.counts).toMatchObject({
      sources: 7,
      queries: 6,
      insertions: 7,
      modelCalls: { construct: 7, evolve: 6, total: 13 },
    });
    // The audit note is expected through one link rather than a direct match.
    expect(
      first.report.retrieval["evolved-linked"]?.allRequiredWithLinks.recovered,
    ).toBeGreaterThan(
      first.report.retrieval["evolved-direct"]?.allRequiredDirectTopK
        .recovered ?? 0,
    );
    expect(
      first.report.retrieval["evolved-linked"]?.returnedCharacters.linked,
    ).toBeGreaterThan(0);
    expect(
      await readFile(
        path.join(firstDirectory, "demo-first", "notes.jsonl"),
        "utf8",
      ),
    ).not.toBe(
      await readFile(
        path.join(secondDirectory, "demo-second", "notes.jsonl"),
        "utf8",
      ),
    );
    const measures = (result: ReplayResult): unknown => ({
      counts: result.report.counts,
      generation: result.report.generation,
      retrieval: Object.fromEntries(
        Object.entries(result.report.retrieval).map(([mode, summary]) => [
          mode,
          { ...summary, latency: undefined },
        ]),
      ),
      checks: result.report.checks.map((check) => [check.name, check.ok]),
    });
    expect(measures(second)).toEqual(measures(first));
  }, 60_000);

  it("writes demonstration artifacts under the repository-local data directory by default", () => {
    expect(
      defaultDemoRunsDirectory.endsWith(path.join(".data", "evaluations")),
    ).toBe(true);
  });
});
