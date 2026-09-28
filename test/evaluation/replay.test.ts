import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  embeddingText,
  type EmbeddedNote,
  type Note,
  type NoteStore,
} from "../../src/index.js";
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
  type TokenUsage,
} from "../../experiments/replay/artifacts.js";
import {
  createInMemoryEnvironment,
  EvaluationEndpointError,
  type EvaluationEnvironment,
} from "../../experiments/replay/environment.js";
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

/** The declared canonical character serialization a retrieval record must reproduce. */
const charactersOf = (
  note: Note,
): { content: number; attributes: number; total: number } => {
  const total = embeddingText(note).length;
  return {
    content: note.content.length,
    attributes: total - note.content.length,
    total,
  };
};

const RATES: CostRates = {
  currency: "USD",
  effectiveDate: "2026-09-01",
  uncachedInputPerMillion: 1,
  cachedInputPerMillion: 0.5,
  outputPerMillion: 2,
};

/** The three constructions and two evolutions a full three-source replay issues, in order. */
const scriptedModel = (usage: TokenUsage | null = null): ScriptedModel =>
  new ScriptedModel()
    .queue(
      "construct",
      () => ({
        context: "Records the alpha procedure approval requirement.",
        keywords: ["alpha", "approval"],
        tags: ["procedure"],
      }),
      usage,
    )
    .queue(
      "construct",
      () => ({
        context: "Records the granted alpha procedure approval.",
        keywords: ["alpha", "approval", "record"],
        tags: ["procedure"],
      }),
      usage,
    )
    .queue(
      "evolve",
      (request) => {
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
      },
      usage,
    )
    .queue(
      "construct",
      () => ({
        context: "Records the beta routine result.",
        keywords: ["beta", "routine"],
        tags: ["routine"],
      }),
      usage,
    )
    .queue("evolve", () => ({ links: [], newTags: [], updates: [] }), usage);

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
      pageEmbedded: (limit, cursor) => opened.store.pageEmbedded(limit, cursor),
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
      expect(record.outcome).toBe("inserted");
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
        // Every ordered result carries the complete note snapshot the mode returned.
        expect(result.note.id).toBe(result.noteId);
        expect(result.note.content.length).toBeGreaterThan(0);
        expect(charactersOf(result.note)).toEqual(result.characters);
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
    // The candidate neighbors the insertion phase selected stay measured, not just counted.
    expect(report.context.neighbors.insertionsWithCandidates).toBe(2);
    expect(report.context.neighbors.count).toMatchObject({
      samples: 2,
      total: 3,
      max: 2,
    });
    expect(report.context.neighbors.characters.total).toBeGreaterThan(0);
    expect(report.storage).toEqual({
      notes: 3,
      dimensions: 4,
      rawVectorBytes: 48,
      indexedVectors: null,
      configuration: null,
      note:
        "Raw float32 vectors only; payloads, indexes, WAL, replicas, allocator overhead and " +
        "backups are excluded. This environment did not report the collection's indexed-vector " +
        "count or configuration.",
    });
    expect(report.timings.startup).toMatchObject({
      encoderLoadMs: null,
      modelSetupMs: null,
    });
    expect(report.timings.startup.runtimeCollectionMs).toBeGreaterThanOrEqual(
      0,
    );
    expect(
      report.timings.startup.baselineMaterializationMs,
    ).toBeGreaterThanOrEqual(0);
    expect(report.timings.insertions.firstMs).not.toBeNull();
    expect(report.timings.search["evolved-linked"]?.all.samples).toBe(2);
    expect(report.timings.search["evolved-linked"]?.firstMs).not.toBeNull();
    expect(report.budget).toBeNull();
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
    // The transport sends no thinking parameter, so the manifest records the setting as external.
    expect(manifest.model.thinking).toBe("disabled-external");
    expect(manifest.timing.finishedAt).not.toBeNull();
  });

  it("applies supplied prompts to both stages and records the ones it used", async () => {
    const model = scriptedModel();
    const options = await replayOptions({ model, runId: "custom-prompts" });
    options.prompts = {
      construction: "Custom construction instructions.",
      evolution: "Custom evolution instructions.",
    };
    const result = await runReplay(options);

    expect(result.status).toBe("completed");
    expect(result.manifest.prompts).toEqual({
      construction: "Custom construction instructions.",
      evolution: "Custom evolution instructions.",
    });
    const [construct, , evolve] = model.requests;
    expect(construct?.prompt).toContain("Custom construction instructions.");
    expect(construct?.prompt).not.toContain(
      "Describe this memory for later retrieval.",
    );
    expect(evolve?.prompt).toContain("Custom evolution instructions.");
    expect(evolve?.prompt).not.toContain(
      "Consider the incoming memory alongside its nearest existing memories.",
    );
  });

  it("records host-measured startup separately from the first operation", async () => {
    const options = await replayOptions({
      model: scriptedModel(),
      runId: "startup",
    });
    options.startup = { encoderLoadMs: 1_234.5, modelSetupMs: 12.5 };
    const result = await runReplay(options);

    expect(result.report.timings.startup).toMatchObject({
      encoderLoadMs: 1_234.5,
      modelSetupMs: 12.5,
    });
    expect(
      result.report.timings.startup.runtimeCollectionMs,
    ).toBeGreaterThanOrEqual(0);
    // The first insertion is a first-operation timing, not the encoder's cold load.
    expect(result.report.timings.insertions.firstMs).not.toBeNull();
    expect(result.report.context.neighbors.insertionsWithCandidates).toBe(2);
  });

  it("reports the stored state the environment can observe", async () => {
    const options = await replayOptions({
      model: scriptedModel(),
      runId: "observed-storage",
    });
    const base = options.environment;
    options.environment = {
      ...base,
      async observe() {
        return {
          indexedVectors: 3,
          configuration: { kind: "test-store" },
        };
      },
    };
    const result = await runReplay(options);

    expect(result.report.storage).toMatchObject({
      indexedVectors: 3,
      configuration: { kind: "test-store" },
    });
    expect(result.report.storage.note).not.toContain("did not report");
  });

  it("rejects a credential-bearing storage endpoint before the run directory exists", async () => {
    const runsDirectory = await temporaryDirectory();
    const model = scriptedModel();
    const options = await replayOptions({
      model,
      runId: "credential-url",
      runsDirectory,
    });
    const base = options.environment;
    options.environment = {
      ...base,
      describe: () => ({
        ...base.describe(),
        storage: {
          kind: "qdrant",
          endpoint:
            "https://synthetic-user:synthetic-secret@qdrant.example:16333",
          schemaVersion: 1,
        },
      }),
    };

    const failure: unknown = await runReplay(options).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(EvaluationEndpointError);
    expect((failure as Error).message).not.toContain("synthetic-secret");
    expect(model.requests).toHaveLength(0);
    await expect(
      stat(path.join(runsDirectory, "credential-url")),
    ).rejects.toThrow();
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
    // Every supplied entry is recorded, with the identity the failed attempt allocated.
    const sources = await readJsonl<SourceRecord>(
      result.directory,
      "sources.jsonl",
    );
    expect(sources.map((record) => [record.sourceId, record.outcome])).toEqual([
      ["alpha-requirement", "inserted"],
      ["alpha-record", "failed"],
      ["beta-observation", "unattempted"],
    ]);
    expect(sources[1]?.noteId).toBe(result.failure?.noteId);
    expect(
      await readJsonl<FinalNoteRecord>(result.directory, "notes.jsonl"),
    ).toHaveLength(1);
    // A construction that succeeded before the response validation failed is still evidence.
    expect(
      await readJsonl<ConstructionRecord>(
        result.directory,
        "construction.jsonl",
      ),
    ).toHaveLength(1);
    expect(result.report.counts).toMatchObject({
      insertions: 1,
      insertionFailures: 1,
      // The transport returned a value; Memory rejected it, so the call itself did not fail.
      failedModelCalls: 0,
    });
    // The uninterrupted-run bound does not describe a failed run.
    expect(result.report.generation).toMatchObject({
      successfulConstruct: 1,
      totalSuccessful: 1,
      upperBound: null,
      withinBound: null,
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
    // The failed attempt is not counted as a successful generation call.
    expect(result.report.generation).toMatchObject({
      successfulConstruct: 1,
      successfulEvolve: 0,
      totalSuccessful: 1,
      upperBound: null,
      withinBound: null,
    });
    expect(result.report.counts.modelCalls).toMatchObject({
      construct: 2,
      total: 2,
    });
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

  it("keeps the construction of an insertion that fails during evolution", async () => {
    const model = new ScriptedModel()
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
      // Missing newTags and updates: the response contract rejects the evolution response.
      .queue("evolve", () => ({ links: [] }));
    const result = await runReplay(
      await replayOptions({ model, runId: "evolution-failure" }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({
      sourceId: "alpha-record",
      stage: "evolve",
      persistence: "unchanged",
    });
    const construction = await readJsonl<ConstructionRecord>(
      result.directory,
      "construction.jsonl",
    );
    expect(construction.map((record) => record.sourceId)).toEqual([
      "alpha-requirement",
      "alpha-record",
    ]);
    const sources = await readJsonl<SourceRecord>(
      result.directory,
      "sources.jsonl",
    );
    expect(sources[1]).toMatchObject({
      sourceId: "alpha-record",
      outcome: "failed",
      noteId: construction[1]?.noteId,
    });
    expect(
      await readJsonl<FinalNoteRecord>(result.directory, "notes.jsonl"),
    ).toHaveLength(1);
    expect(result.report.generation).toMatchObject({
      successfulConstruct: 2,
      successfulEvolve: 0,
      totalSuccessful: 2,
    });
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

  it("exports the notes and construction of a write the store applied but did not acknowledge", async () => {
    const options = await replayOptions({
      model: scriptedModel(),
      runId: "uncertain-applied",
    });
    const base = options.environment;
    options.environment = {
      ...base,
      async openCollection(request) {
        const opened = await base.openCollection(request);
        let writes = 0;
        const store: NoteStore = {
          async put(records: EmbeddedNote[]): Promise<void> {
            writes += 1;
            await opened.store.put(records);
            if (writes > 1) {
              // The batch is persisted, but the acknowledgment never reaches Memory.
              throw new Error("the acknowledgment was lost");
            }
          },
          get: (ids) => opened.store.get(ids),
          nearest: (vector, limit) => opened.store.nearest(vector, limit),
          page: (limit, cursor) => opened.store.page(limit, cursor),
          pageEmbedded: (limit, cursor) =>
            opened.store.pageEmbedded(limit, cursor),
        };
        return { store, collection: opened.collection };
      },
    };
    const result = await runReplay(options);

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({
      sourceId: "alpha-record",
      stage: "persist",
      persistence: "uncertain",
    });
    // Every supplied source is recorded with the identity the rejected attempt allocated.
    const sources = await readJsonl<SourceRecord>(
      result.directory,
      "sources.jsonl",
    );
    expect(sources.map((record) => [record.sourceId, record.outcome])).toEqual([
      ["alpha-requirement", "inserted"],
      ["alpha-record", "failed"],
      ["beta-observation", "unattempted"],
    ]);
    expect(sources[1]?.noteId).toBe(result.failure?.noteId);
    // The applied batch is exported through pagination even though it was never acknowledged.
    const notes = await readJsonl<FinalNoteRecord>(
      result.directory,
      "notes.jsonl",
    );
    expect(notes.map((record) => record.sourceId)).toEqual([
      "alpha-requirement",
      "alpha-record",
    ]);
    expect(result.report.counts).toMatchObject({
      insertions: 1,
      finalNotes: 2,
      insertionFailures: 1,
    });
    expect(result.report.storage).toMatchObject({
      notes: 2,
      rawVectorBytes: 32,
    });
    expect(result.report.context.corpusNotes).toBe(2);
    // The construction that succeeded before the lost acknowledgment stays recorded.
    const construction = await readJsonl<ConstructionRecord>(
      result.directory,
      "construction.jsonl",
    );
    expect(construction.map((record) => record.sourceId)).toEqual([
      "alpha-requirement",
      "alpha-record",
    ]);
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
    expect(sources.every((record) => record.outcome === "inserted")).toBe(true);
    // The recorded calls show the insertion actually followed the explicit order.
    const calls = await readJsonl<ModelCallRecord>(
      result.directory,
      "calls.jsonl",
    );
    expect([...new Set(calls.map((call) => call.sourceId))]).toEqual(order);

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
        // The provider reports usage, so the declared token budget stays enforceable and the call
        // budget is what stops the run.
        model: scriptedModel({
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
        }),
        runId: "budget",
        budget: { callBudget: 2, tokenBudget: 1_000_000 },
      }),
    );
    expect(result.status).toBe("stopped");
    expect(result.stoppingReason).toBe("call-budget");
    expect(result.report.stoppingReason).toBe("call-budget");
    expect(result.report.budget).toEqual({
      callBudget: 2,
      tokenBudget: 1_000_000,
      modelCalls: 2,
      tokensUsed: 30,
      usageComplete: true,
    });
    expect(result.manifest.budget).toEqual({
      callBudget: 2,
      tokenBudget: 1_000_000,
    });
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

  it.each([1, 5])(
    "records a call budget reached on the final call (%i calls)",
    async (callBudget) => {
      const options = await replayOptions({
        model: scriptedModel({
          inputTokens: 2,
          cachedInputTokens: 0,
          outputTokens: 1,
        }),
        budget: { callBudget, tokenBudget: 1000 },
      });
      if (callBudget === 1) {
        options.sources = testSources.slice(0, 1);
        options.queries = [];
      }
      const result = await runReplay(options);
      expect(result.status).toBe("stopped");
      expect(result.stoppingReason).toBe("call-budget");
      expect(result.report.budget).toMatchObject({
        modelCalls: callBudget,
        usageComplete: true,
      });
      expect(result.report.counts.insertions).toBe(options.sources.length);
      const changes = await readJsonl<ChangeRecord>(
        result.directory,
        "changes.jsonl",
      );
      expect(changes.at(-1)).toMatchObject({
        kind: "budget",
        sourceId: null,
        budgetReason: "call-budget",
      });
    },
  );

  it("preserves the token stopping reason when the call limit is reached at the same time", async () => {
    const result = await runReplay(
      await replayOptions({
        model: scriptedModel({
          inputTokens: 2,
          cachedInputTokens: 0,
          outputTokens: 1,
        }),
        budget: { callBudget: 1, tokenBudget: 3 },
      }),
    );
    expect(result.stoppingReason).toBe("token-budget");
    expect(result.report.counts.modelCalls.total).toBe(1);
  });

  it("stops when the last call reaches the declared token budget", async () => {
    const usage = { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 };
    const result = await runReplay(
      await replayOptions({
        // Five calls of three tokens reach the declared fifteen exactly on the final call.
        model: scriptedModel(usage),
        runId: "token-budget-end",
        budget: { callBudget: 100, tokenBudget: 15 },
      }),
    );

    expect(result.status).toBe("stopped");
    expect(result.stoppingReason).toBe("token-budget");
    expect(result.report.stoppingReason).toBe("token-budget");
    expect(result.report.budget).toEqual({
      callBudget: 100,
      tokenBudget: 15,
      modelCalls: 5,
      tokensUsed: 15,
      usageComplete: true,
    });
    const changes = await readJsonl<ChangeRecord>(
      result.directory,
      "changes.jsonl",
    );
    expect(changes.map((change) => change.kind)).toEqual([
      "insertion",
      "insertion",
      "insertion",
      "budget",
    ]);
    const budget = changes[3];
    if (budget?.kind !== "budget") {
      throw new Error("expected the recorded budget stop");
    }
    // The stop happened after the last insertion, not inside a new attempt.
    expect(budget.sourceId).toBeNull();
    expect(budget.budgetReason).toBe("token-budget");
  });

  it("stops instead of continuing when a declared token budget has no usage to check", async () => {
    const result = await runReplay(
      await replayOptions({
        model: scriptedModel(),
        runId: "token-budget-unknown",
        budget: { callBudget: 100, tokenBudget: 1_000 },
      }),
    );

    expect(result.status).toBe("stopped");
    expect(result.stoppingReason).toBe("token-budget");
    expect(result.report.budget).toEqual({
      callBudget: 100,
      tokenBudget: 1_000,
      modelCalls: 1,
      tokensUsed: null,
      usageComplete: false,
    });
    const enforceability = result.report.checks.find(
      (check) => check.name === "declared token budget enforceable",
    );
    expect(enforceability?.ok).toBe(false);
    const budget = await readJsonl<ChangeRecord>(
      result.directory,
      "changes.jsonl",
    );
    expect(budget.map((change) => change.kind)).toEqual([
      "insertion",
      "budget",
    ]);
  });

  it("refuses the next call once reported usage reaches the declared token budget", async () => {
    const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 };
    const model = scriptedModel(usage);
    const result = await runReplay(
      await replayOptions({
        model,
        runId: "token-budget-refused",
        budget: { callBudget: 100, tokenBudget: 15 },
      }),
    );

    expect(result.status).toBe("stopped");
    expect(result.stoppingReason).toBe("token-budget");
    // The first call reported fifteen tokens, so the second call was never invoked.
    expect(result.report.counts.modelCalls.total).toBe(1);
    expect(model.requests).toHaveLength(1);
    expect(result.report.budget).toEqual({
      callBudget: 100,
      tokenBudget: 15,
      modelCalls: 1,
      tokensUsed: 15,
      usageComplete: true,
    });
  });

  it("keeps an unreported cache split out of the measured cost", async () => {
    const usage = { inputTokens: 10, cachedInputTokens: null, outputTokens: 5 };
    const result = await runReplay(
      await replayOptions({
        model: scriptedModel(usage),
        runId: "cache-unknown",
        costRates: RATES,
      }),
    );

    expect(result.report.usage).toMatchObject({
      known: true,
      inputTokens: 50,
      cachedInputTokens: null,
      uncachedInputTokens: null,
      outputTokens: 25,
    });
    expect(result.report.cost.known).toBe(false);
    expect(result.report.cost.total).toBeNull();
    // The bound assumes every input token was uncached: (50 * 1 + 25 * 2) / 1_000_000.
    expect(result.report.cost.upperBound).toBeCloseTo(0.0001, 10);
    expect(result.report.cost.note).toContain(
      "upperBound prices every input token at the higher input rate",
    );
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
    // The excluded entry stays in the record, marked as excluded rather than dropped.
    const sources = await readJsonl<SourceRecord>(
      result.directory,
      "sources.jsonl",
    );
    expect(sources.map((record) => [record.sourceId, record.outcome])).toEqual([
      ["alpha-requirement", "inserted"],
      ["alpha-record", "inserted"],
      ["beta-observation", "excluded"],
    ]);
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
      sources: 10,
      queries: 8,
      insertions: 10,
      modelCalls: { construct: 10, evolve: 9, total: 19 },
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
