import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  openQdrantNoteStore,
  QdrantCollectionCompatibilityError,
} from "../../../src/index.js";
import {
  evaluationMetadataKey,
  EvaluationBaselineCompatibilityError,
  openEvaluationBaselineStore,
} from "../../../experiments/live/baseline-store.js";
import { createLiveEnvironment } from "../../../experiments/live/environment.js";
import { fixtureHash } from "../../../experiments/replay/fixture.js";
import { runReplay } from "../../../experiments/replay/runner.js";
import {
  modelDescription,
  ScriptedModel,
  testQueries,
  testSources,
  TokenEmbedder,
} from "../../evaluation/support/harness.js";
import { readEvolutionEnvelope } from "../../../experiments/replay/envelope.js";
import {
  adminClient,
  dropCollection,
  pointCount,
  qdrantUrl,
  uniqueCollection,
} from "../support/note-store.js";

/**
 * The evaluation collections against real Qdrant: the runtime collection stays `amem-note-v1`, each
 * comparison baseline declares its own representation, and neither the runtime store nor another
 * baseline accepts the wrong collection.
 *
 * See docs/evaluation.md#comparison-modes and docs/testing.md#contracts-and-cooperation.
 */

const created: string[] = [];
const directories: string[] = [];

afterAll(async () => {
  for (const collection of created) {
    await dropCollection(collection);
  }
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "amem-eval-integration-"),
  );
  directories.push(directory);
  return directory;
};

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
      return { links: related, newTags: incoming.tags, updates: [] };
    })
    .queue("construct", () => ({
      context: "Records the beta routine result.",
      keywords: ["beta", "routine"],
      tags: ["routine"],
    }))
    .queue("evolve", () => ({ links: [], newTags: [], updates: [] }));

const metadataOf = async (
  collection: string,
): Promise<Record<string, unknown>> => {
  const info = await adminClient().getCollection(collection);
  const metadata = info.config.metadata;
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error(`Collection ${collection} has no metadata.`);
  }
  return metadata as Record<string, unknown>;
};

describe("live evaluation collections", () => {
  it("keeps runtime and baseline representations distinct and inspects them", async () => {
    const baseName = uniqueCollection("evaluation");
    const runsDirectory = await temporaryDirectory();
    const embedder = new TokenEmbedder();
    const model = scriptedModel();
    const environment = createLiveEnvironment({
      url: qdrantUrl(),
      baseName,
      space: {
        id: embedder.space.id,
        dimensions: embedder.space.dimensions,
        distance: embedder.space.distance,
      },
      embedder,
      model,
      exchanges: model.exchanges,
      encoderSettings: { kind: "test-token-embedder", dimensions: 4 },
      modelDescription,
      cleanup: false,
    });
    const result = await runReplay({
      runId: "qdrant-evaluation",
      revision: "integration",
      runsDirectory,
      sources: testSources,
      queries: testQueries,
      sourceHash: fixtureHash("sources"),
      queryHash: fixtureHash("queries"),
      environment,
      directLimit: 3,
      linkedLimit: 3,
    });

    const runtime = result.manifest.storage.collections["runtime"];
    const raw = result.manifest.storage.collections["original-content"];
    const constructed = result.manifest.storage.collections["constructed"];
    for (const collection of [runtime, raw, constructed]) {
      expect(collection).toBeDefined();
      created.push(collection!);
    }

    expect(result.status).toBe("completed");
    expect(result.report.checks.every((check) => check.ok)).toBe(true);
    expect(await pointCount(runtime!)).toBe(testSources.length);
    // The live environment reports the collection's real indexed-vector count and configuration.
    const runtimeInfo = await adminClient().getCollection(runtime!);
    expect(result.report.storage.indexedVectors).toBe(
      runtimeInfo.indexed_vectors_count,
    );
    // This tiny collection is populated but below Qdrant's indexing threshold.
    expect(result.report.storage.indexedVectors).toBe(0);
    expect(result.report.storage.configuration).toMatchObject({
      vectors: { size: 4, distance: "Cosine" },
      metadata: { agenticMemory: { representation: "amem-note-v1" } },
    });

    const runtimeMetadata = await metadataOf(runtime!);
    expect(runtimeMetadata["agenticMemory"]).toMatchObject({
      representation: "amem-note-v1",
      embeddingSpace: { id: "amem-eval-test-space", dimensions: 4 },
    });
    const rawMetadata = await metadataOf(raw!);
    expect(rawMetadata[evaluationMetadataKey]).toMatchObject({
      representation: "amem-eval-raw-content-v1",
      schemaVersion: 1,
    });
    const constructedMetadata = await metadataOf(constructed!);
    expect(constructedMetadata[evaluationMetadataKey]).toMatchObject({
      representation: "amem-eval-constructed-v1",
    });

    // The runtime store refuses a baseline collection, and a baseline refuses another identity.
    await expect(
      openQdrantNoteStore({
        url: qdrantUrl(),
        collection: raw!,
        space: {
          id: embedder.space.id,
          dimensions: embedder.space.dimensions,
          distance: embedder.space.distance,
        },
      }),
    ).rejects.toBeInstanceOf(QdrantCollectionCompatibilityError);
    await expect(
      openEvaluationBaselineStore({
        url: qdrantUrl(),
        collection: raw!,
        representation: "amem-eval-constructed-v1",
        space: {
          id: embedder.space.id,
          dimensions: embedder.space.dimensions,
          distance: embedder.space.distance,
        },
      }),
    ).rejects.toBeInstanceOf(EvaluationBaselineCompatibilityError);

    const retrieval = await readFile(
      path.join(result.directory, "retrieval.jsonl"),
      "utf8",
    );
    expect(retrieval.trim().split("\n")).toHaveLength(4 * testQueries.length);
    expect(retrieval).toContain('"origin":"match"');
  });

  it("removes only the disposable collections the run created", async () => {
    const baseName = uniqueCollection("evaluation-cleanup");
    const embedder = new TokenEmbedder();
    const model = scriptedModel();
    const environment = createLiveEnvironment({
      url: qdrantUrl(),
      baseName,
      space: {
        id: embedder.space.id,
        dimensions: embedder.space.dimensions,
        distance: embedder.space.distance,
      },
      embedder,
      model,
      exchanges: model.exchanges,
      encoderSettings: null,
      modelDescription,
    });
    const opened = await environment.openCollection({
      representation: "amem-eval-raw-content-v1",
      label: "original-content",
    });
    expect(
      (await adminClient().collectionExists(opened.collection)).exists,
    ).toBe(true);
    await environment.dispose();
    expect(
      (await adminClient().collectionExists(opened.collection)).exists,
    ).toBe(false);
  });
});
