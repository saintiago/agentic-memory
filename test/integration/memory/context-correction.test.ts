import { afterAll, describe, expect, it } from "vitest";

import {
  AgenticMemory,
  MemoryError,
  embeddingText,
  type Attributes,
  type Embedder,
  type LanguageModel,
  type ModelRequest,
  type Note,
} from "../../../src/index.js";
import {
  dropCollection,
  note as makeNote,
  openStore,
  uniqueCollection,
} from "../support/note-store.js";

/**
 * System journey for reviewed context correction with the assembled library and an isolated real
 * Qdrant: the actual prepared plan is applied, replayed unchanged and the corrected semantics stay
 * searchable after reopening the storage. The model is never called and the embedding output is
 * controlled, so this asserts wiring and persistence rather than model judgment.
 *
 * See docs/memory.md#existing-context-correction and docs/testing.md#system-journeys.
 */

const created: string[] = [];

const collection = (label: string): string => {
  const name = uniqueCollection(label);
  created.push(name);
  return name;
};

afterAll(async () => {
  for (const name of created) {
    await dropCollection(name);
  }
});

/** One topic vector for text mentioning the queue, another for everything else. */
class TopicEmbedder implements Embedder {
  readonly space = {
    id: "amem2-test-space",
    dimensions: 4,
    distance: "Cosine",
  } as const;
  readonly texts: string[] = [];

  async embed(text: string): Promise<number[]> {
    this.texts.push(text);
    return text.includes("queue") ? [1, 0, 0, 0] : [0, 1, 0, 0];
  }
}

/** A controlled embedding failure for the before-any-write check. */
class FailingEmbedder implements Embedder {
  readonly space = {
    id: "amem2-test-space",
    dimensions: 4,
    distance: "Cosine",
  } as const;

  async embed(): Promise<number[]> {
    throw new Error("the encoder runtime is unavailable");
  }
}

/** Correction preparation must never construct or evolve, so any model call fails the case. */
class UnusedModel implements LanguageModel {
  readonly requests: ModelRequest[] = [];

  async generate(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    throw new Error(`Unexpected ${request.stage} request during correction.`);
  }
}

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

const corrected: Attributes = {
  context: "Requires an operator approval before a queue entry is removed.",
  keywords: ["queue entry", "approval"],
  tags: ["operations", "policy"],
};

const original = (): Note =>
  makeNote({
    content: "The archive copy is stored on the primary volume.",
    context: "Records where the archive copy lives.",
    keywords: ["archive"],
    tags: ["storage"],
  });

describe("context correction journey", () => {
  it("applies the prepared plan, preserves the source and stays searchable after reopening", async () => {
    const name = collection("correction");
    const store = await openStore(name);
    const embedder = new TopicEmbedder();
    const model = new UnusedModel();
    const seed = original();
    await store.put([
      { note: seed, vector: await embedder.embed(embeddingText(seed)) },
    ]);
    const [inspected] = await store.get([seed.id]);
    expect(inspected).toEqual(seed);

    const memory = new AgenticMemory(store, embedder, model);
    const preparation = await memory.prepareContextCorrection({
      expected: inspected!,
      attributes: corrected,
    });
    const plan = preparation.plan;
    expect(plan).toBeDefined();
    if (plan === undefined) {
      return;
    }
    expect(plan.noteId).toBe(seed.id);
    expect(plan.records).toHaveLength(1);
    expect(model.requests).toEqual([]);

    const applied = await memory.apply(plan);

    expect(applied).toEqual({
      ...seed,
      ...corrected,
      updatedAt: expect.any(String),
    });
    expect(applied.content).toBe(seed.content);
    expect(applied.timestamp).toBe(seed.timestamp);
    expect(applied.links).toEqual(seed.links);

    const reopened = await openStore(name);
    const reopenedMemory = new AgenticMemory(
      reopened,
      embedder,
      new UnusedModel(),
    );
    const [recordAfterReopen] = (await reopened.pageEmbedded(10)).records;
    expect(recordAfterReopen?.note).toEqual(applied);
    expect(recordAfterReopen?.vector).toEqual([1, 0, 0, 0]);

    // The corrected semantics are searchable through the stored vector after reopening.
    const results = await reopenedMemory.search(
      "queue entry removal needs an operator approval",
    );
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.via).toBe("match");
    expect(result?.note).toEqual(applied);
    if (result?.via === "match") {
      expect(result.score).toBeCloseTo(1, 5);
    }

    // Replaying the exact plan preserves the prepared values, vector and update time.
    const replayed = await reopenedMemory.apply(plan);
    expect(replayed).toEqual(applied);
    const [recordAfterReplay] = (await reopened.pageEmbedded(10)).records;
    expect(recordAfterReplay).toEqual(recordAfterReopen);

    // A proposal matching the corrected note is a no-op: no plan and no new embedding.
    const embedsBeforeNoop = embedder.texts.length;
    const noop = await reopenedMemory.prepareContextCorrection({
      expected: applied,
      attributes: corrected,
    });
    expect(noop.plan).toBeUndefined();
    expect(noop.note).toEqual(applied);
    expect(embedder.texts).toHaveLength(embedsBeforeNoop);

    // The superseded inspection is stale and rejects without touching the corrected record.
    const stale = await captureRejection(
      reopenedMemory.prepareContextCorrection({
        expected: seed,
        attributes: corrected,
      }),
    );
    expect(stale).toBeInstanceOf(MemoryError);
    expect((stale as MemoryError).stage).toBe("read");
    expect((stale as MemoryError).persistence).toBe("unchanged");
    expect((stale as MemoryError).readOutcome).toBe("stale");
    const [recordAfterStale] = (await reopened.pageEmbedded(10)).records;
    expect(recordAfterStale).toEqual(recordAfterReopen);
  });

  it("rejects a failed embedding before any write to the real collection", async () => {
    const name = collection("correction-embedding");
    const store = await openStore(name);
    const seed = original();
    await store.put([{ note: seed, vector: [0, 1, 0, 0] }]);

    const failure = await captureRejection(
      new AgenticMemory(
        store,
        new FailingEmbedder(),
        new UnusedModel(),
      ).prepareContextCorrection({
        expected: seed,
        attributes: corrected,
      }),
    );

    expect(failure).toBeInstanceOf(MemoryError);
    expect((failure as MemoryError).stage).toBe("embed");
    expect((failure as MemoryError).persistence).toBe("unchanged");
    const [record] = (await store.pageEmbedded(10)).records;
    expect(record).toEqual({ note: seed, vector: [0, 1, 0, 0] });
  });
});
