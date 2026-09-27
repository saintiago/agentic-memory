import { afterAll, describe, expect, it } from "vitest";

import {
  AgenticMemory,
  MemoryError,
  type Embedder,
  type LanguageModel,
  type ModelRequest,
  type Note,
} from "../../../src/index.js";
import {
  dropCollection,
  openStore,
  uniqueCollection,
} from "../support/note-store.js";

/**
 * System journeys for note insertion with the assembled library and an isolated real Qdrant. The
 * model and embedding outputs are controlled, so the cases assert wiring and persistence rather
 * than model judgment or retrieval quality.
 *
 * See docs/testing.md#system-journeys.
 */

const NOTE_TIMESTAMP = "2026-09-27T15:44:27.001+02:00";

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

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Let pending microtasks run without relying on timers. */
const flush = async (): Promise<void> => {
  for (let step = 0; step < 20; step += 1) {
    await Promise.resolve();
  }
};

/** Every text maps to one small vector, so the candidate set is deterministic. */
class FixedEmbedder implements Embedder {
  readonly space = {
    id: "amem2-test-space",
    dimensions: 4,
    distance: "Cosine",
  } as const;
  readonly texts: string[] = [];

  async embed(text: string): Promise<number[]> {
    this.texts.push(text);
    return [1, 0, 0, 0];
  }
}

/** A controlled embedding failure for the preparation-failure journey. */
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

interface ScriptedStep {
  readonly stage: ModelRequest["stage"];
  readonly produce: () => unknown;
}

class ScriptedModel implements LanguageModel {
  readonly requests: ModelRequest[] = [];
  readonly #steps: ScriptedStep[] = [];

  queue(stage: ModelRequest["stage"], produce: () => unknown): this {
    this.#steps.push({ stage, produce });
    return this;
  }

  async generate(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    const step = this.#steps.shift();
    if (step === undefined || step.stage !== request.stage) {
      throw new Error(`Unexpected ${request.stage} request.`);
    }
    return await step.produce();
  }
}

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

const idsOf = (notes: readonly Note[]): string[] =>
  notes.map((note) => note.id).sort();

describe("memory insertion journeys", () => {
  it("inserts, evolves a related note and persists both across reopening", async () => {
    const name = collection("insertion");
    const store = await openStore(name);
    const embedder = new FixedEmbedder();
    const firstModel = new ScriptedModel();
    firstModel.queue("construct", () => ({
      context: "Records the first source.",
      keywords: ["first"],
      tags: ["observation"],
    }));

    const first = await new AgenticMemory(store, embedder, firstModel).add({
      content: "The first source.",
      timestamp: NOTE_TIMESTAMP,
      metadata: { origin: "host", nested: { count: 1 } },
    });
    // There is no candidate yet, so the first insertion never calls the model for evolution.
    expect(firstModel.requests.map((request) => request.stage)).toEqual([
      "construct",
    ]);
    expect(await store.get([first.id])).toEqual([first]);

    const reopened = await openStore(name);
    const secondModel = new ScriptedModel();
    secondModel.queue("construct", () => ({
      context: "Records the second source.",
      keywords: ["second"],
      tags: ["observation"],
    }));
    secondModel.queue("evolve", () => ({
      links: [first.id],
      newTags: ["observation", "revision"],
      updates: [
        {
          id: first.id,
          context: "The first source now supports the second account.",
          keywords: ["first", "support"],
          tags: ["observation", "history"],
        },
      ],
    }));

    const second = await new AgenticMemory(reopened, embedder, secondModel).add(
      { content: "The second source." },
    );

    expect(second.links).toEqual([first.id]);
    expect(second.tags).toEqual(["observation", "revision"]);
    const found = await reopened.get([first.id, second.id]);
    expect(idsOf(found)).toEqual(idsOf([first, second]));
    expect(found.find((note) => note.id === second.id)).toEqual(second);
    expect(found.find((note) => note.id === first.id)).toEqual({
      ...first,
      context: "The first source now supports the second account.",
      keywords: ["first", "support"],
      tags: ["observation", "history"],
    });
  });

  it("leaves stored notes unchanged when preparation fails", async () => {
    const name = collection("preparation");
    const store = await openStore(name);
    const embedder = new FixedEmbedder();
    const model = new ScriptedModel();
    model.queue("construct", () => ({
      context: "Records the stored source.",
      keywords: ["stored"],
      tags: ["observation"],
    }));
    const first = await new AgenticMemory(store, embedder, model).add({
      content: "The stored source.",
    });

    // The evolution response is pending, so no construction-only note may be published yet.
    const gate = deferred<unknown>();
    const pendingModel = new ScriptedModel();
    pendingModel.queue("construct", () => ({
      context: "Records the related source.",
      keywords: ["related"],
      tags: ["observation"],
    }));
    pendingModel.queue("evolve", () => gate.promise);
    const pending = new AgenticMemory(store, embedder, pendingModel).add({
      content: "The related source.",
    });
    await flush();

    expect(idsOf((await store.page(10)).notes)).toEqual([first.id]);

    // An unknown link target fails validation before any write.
    gate.resolve({
      links: ["11111111-1111-4111-8111-111111111111"],
      newTags: [],
      updates: [],
    });
    const evolutionFailure = await captureRejection(pending);
    expect(evolutionFailure).toBeInstanceOf(MemoryError);
    expect((evolutionFailure as MemoryError).stage).toBe("evolve");
    expect((evolutionFailure as MemoryError).persistence).toBe("unchanged");
    expect(idsOf((await store.page(10)).notes)).toEqual([first.id]);

    // A failed embedding also leaves the stored state untouched.
    const failingModel = new ScriptedModel();
    failingModel.queue("construct", () => ({
      context: "Records the unembeddable source.",
      keywords: ["unembeddable"],
      tags: ["observation"],
    }));
    const embeddingFailure = await captureRejection(
      new AgenticMemory(store, new FailingEmbedder(), failingModel).add({
        content: "The unembeddable source.",
      }),
    );
    expect(embeddingFailure).toBeInstanceOf(MemoryError);
    expect((embeddingFailure as MemoryError).stage).toBe("embed");
    expect((embeddingFailure as MemoryError).persistence).toBe("unchanged");
    expect(await store.get([first.id])).toEqual([first]);
    expect(idsOf((await store.page(10)).notes)).toEqual([first.id]);
  });
});
