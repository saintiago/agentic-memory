import { describe, expect, it, vi } from "vitest";

import {
  AgenticMemory,
  embeddingText,
  insertionPlanSchema,
  insertionPlanVersion,
  representationVersion,
  type InsertionPlan,
  type Note,
  type PrepareInput,
} from "../../src/index.js";
import {
  ControlledEmbedder,
  RecordingStore,
  ScriptedModel,
  deferred,
  expectMemoryError,
  flush,
  rejection,
  vectorFor,
} from "./support/memory-harness.js";

/**
 * Component tests for the durable prepare/apply contract of Memory: preparation produces an
 * immutable plan without writing, application validates and writes exactly that plan, and both
 * share the ordinary insertion algorithm and its failure outcomes.
 *
 * See docs/memory.md#durable-preparation-and-application.
 */

const NOTE_ID = "5c9c1f6e-2f0b-4c3a-9f6d-7a1b2c3d4e05";
const CANDIDATE_ID = "6f2bb0d4-1c1e-4a2b-8f43-1c9a3d4c5e02";
const OTHER_ID = "b1c2d3e4-f506-4a7b-8c9d-0e1f2a3b4c05";
const NOTE_TIMESTAMP = "2026-09-27T15:44:27.001+02:00";

const attributes = (
  context: string,
  keywords: string[],
  tags: string[],
): unknown => ({ context, keywords, tags });

const CONSTRUCTED = (): unknown =>
  attributes("Records the incoming account.", ["account"], ["incoming"]);

const candidate = (overrides: Partial<Note> = {}): Note => ({
  id: CANDIDATE_ID,
  content: "An earlier observation.",
  timestamp: NOTE_TIMESTAMP,
  context: "An earlier observation about the same subject.",
  keywords: ["observation"],
  tags: ["history"],
  links: [],
  metadata: { origin: "host" },
  ...overrides,
});

const createMemory = (): {
  store: RecordingStore;
  embedder: ControlledEmbedder;
  model: ScriptedModel;
  memory: AgenticMemory;
} => {
  const store = new RecordingStore();
  const embedder = new ControlledEmbedder();
  const model = new ScriptedModel();
  return {
    store,
    embedder,
    model,
    memory: new AgenticMemory(store, embedder, model),
  };
};

const preparedPlan = async (
  harness: ReturnType<typeof createMemory>,
  content = "The incoming account.",
): Promise<InsertionPlan> => {
  harness.model.queue("construct", CONSTRUCTED);
  return await harness.memory.prepare({
    noteId: NOTE_ID,
    content,
    timestamp: NOTE_TIMESTAMP,
  });
};

describe("durable insertion preparation", () => {
  it("produces a versioned immutable plan without writing any note", async () => {
    const harness = createMemory();

    const plan = await preparedPlan(harness);

    expect(harness.store.writes).toEqual([]);
    expect(harness.store.calls).toEqual(["nearest:5:4"]);
    expect(plan.version).toBe(insertionPlanVersion);
    expect(plan.representation).toBe(representationVersion);
    expect(plan.embeddingSpace).toEqual(harness.embedder.space);
    expect(plan.noteId).toBe(NOTE_ID);
    expect(insertionPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.records).toHaveLength(1);
    const record = plan.records[0]!;
    expect(record.note).toMatchObject({
      id: NOTE_ID,
      content: "The incoming account.",
      timestamp: NOTE_TIMESTAMP,
      context: "Records the incoming account.",
      keywords: ["account"],
      tags: ["incoming"],
      links: [],
    });
    expect(record.note.updatedAt).toEqual(expect.any(String));
    expect(record.vector).toEqual(vectorFor(embeddingText(record.note)));
  });

  it("freezes the plan and its records so pending work cannot change", async () => {
    const harness = createMemory();

    const plan = await preparedPlan(harness);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.records)).toBe(true);
    expect(Object.isFrozen(plan.records[0])).toBe(true);
    expect(() => (plan.records as unknown as unknown[]).push({})).toThrow(
      TypeError,
    );
    expect(() => {
      (plan.records[0]!.note as { context: string }).context = "Rewritten.";
    }).toThrow(TypeError);
  });

  it("prepares the changed neighbor and the incoming note in one batch", async () => {
    const harness = createMemory();
    const current = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", () => ({
      links: [current.id],
      newTags: ["incoming"],
      updates: [
        {
          id: current.id,
          context: "The earlier observation now supports the incoming account.",
          keywords: ["observation"],
          tags: ["history"],
        },
      ],
    }));

    const plan = await harness.memory.prepare({
      noteId: NOTE_ID,
      content: "The incoming account.",
      timestamp: NOTE_TIMESTAMP,
    });

    expect(planIds(plan)).toEqual([current.id, NOTE_ID]);
    const neighbor = plan.records[0]!;
    const incoming = plan.records[1]!;
    expect(neighbor.note.updatedAt).toBe(incoming.note.updatedAt);
    expect(incoming.note.links).toEqual([current.id]);
    expect(neighbor.vector).toEqual(vectorFor(embeddingText(neighbor.note)));

    await harness.memory.apply(plan);

    expect(harness.store.stored(current.id)).toEqual(neighbor.note);
    expect(harness.store.stored(NOTE_ID)).toEqual(incoming.note);
  });

  it("validates preparation input before any provider work", async () => {
    const cases: ReadonlyArray<[string, () => unknown]> = [
      [
        "a note identity that is not a UUID",
        () => ({
          noteId: "not-a-uuid",
          content: "Text.",
          timestamp: NOTE_TIMESTAMP,
        }),
      ],
      [
        "whitespace-only content",
        () => ({
          noteId: NOTE_ID,
          content: " \n\t ",
          timestamp: NOTE_TIMESTAMP,
        }),
      ],
      [
        "a timestamp without a timezone",
        () => ({
          noteId: NOTE_ID,
          content: "Text.",
          timestamp: "2026-09-27T15:44:27",
        }),
      ],
      [
        "non-JSON metadata",
        () => ({
          noteId: NOTE_ID,
          content: "Text.",
          timestamp: NOTE_TIMESTAMP,
          metadata: { when: new Date() },
        }),
      ],
      [
        "an extra input field",
        () => ({
          noteId: NOTE_ID,
          content: "Text.",
          timestamp: NOTE_TIMESTAMP,
          links: [],
        }),
      ],
    ];

    for (const [description, build] of cases) {
      const harness = createMemory();
      const error = expectMemoryError(
        await rejection(harness.memory.prepare(build() as PrepareInput)),
      );
      expect(error.operation, description).toBe("prepare");
      expect(error.stage, description).toBe("input");
      expect(error.persistence, description).toBe("unchanged");
      expect(harness.model.requests, description).toEqual([]);
      expect(harness.store.calls, description).toEqual([]);
    }
  });

  it("is serialized with add on one instance, in invocation order", async () => {
    const harness = createMemory();
    const gate = deferred<void>();
    harness.model.queue("construct", async () => {
      await gate.promise;
      return attributes("Records the source.", ["source"], ["observation"]);
    });
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", () => ({
      links: [],
      newTags: ["incoming"],
      updates: [],
    }));

    const insertion = harness.memory.add({ content: "The source text." });
    const preparation = harness.memory.prepare({
      noteId: NOTE_ID,
      content: "The incoming account.",
      timestamp: NOTE_TIMESTAMP,
    });
    await flush();

    // Preparation must not select candidates while the earlier insertion is still pending.
    expect(harness.model.requests.map((request) => request.stage)).toEqual([
      "construct",
    ]);
    gate.resolve();
    const [note, plan] = await Promise.all([insertion, preparation]);

    expect(note.content).toBe("The source text.");
    expect(note.id).not.toBe(NOTE_ID);
    expect(plan.noteId).toBe(NOTE_ID);
    expect(harness.model.requests.map((request) => request.stage)).toEqual([
      "construct",
      "construct",
      "evolve",
    ]);
  });
});

describe("durable insertion application", () => {
  it("writes exactly the prepared records and returns a detached incoming note", async () => {
    const harness = createMemory();
    const plan = await preparedPlan(harness);

    const note = await harness.memory.apply(plan);

    expect(note).toEqual(plan.records[0]!.note);
    expect(harness.store.writes).toEqual([plan.records]);
    expect(harness.store.stored(note.id)).toEqual(note);

    note.tags.push("appended-through-the-returned-note");
    expect(harness.store.stored(note.id)).toEqual(plan.records[0]!.note);
  });

  it("reapplies the same plan without regenerating anything", async () => {
    const harness = createMemory();
    const plan = await preparedPlan(harness);
    const first = await harness.memory.apply(plan);
    const embeddedTexts = [...harness.embedder.texts];
    const modelRequests = [...harness.model.requests];

    const second = await harness.memory.apply(plan);

    expect(second).toEqual(first);
    expect(harness.embedder.texts).toEqual(embeddedTexts);
    expect(harness.model.requests).toEqual(modelRequests);
    expect(harness.store.writes).toEqual([plan.records, plan.records]);
  });

  it("applies a plan prepared by another instance of the same configuration", async () => {
    const harness = createMemory();
    const plan = await preparedPlan(harness);
    const other = new AgenticMemory(
      harness.store,
      harness.embedder,
      harness.model,
    );

    const note = await other.apply(plan);

    expect(note.id).toBe(NOTE_ID);
    expect(harness.store.stored(NOTE_ID)).toEqual(plan.records[0]!.note);
  });

  it("rejects plans of another version, representation or embedding space before writing", async () => {
    const harness = createMemory();
    const plan = await preparedPlan(harness);
    const cases: ReadonlyArray<[string, (valid: InsertionPlan) => unknown]> = [
      ["a version", (valid) => ({ ...valid, version: 2 })],
      [
        "a representation",
        (valid) => ({ ...valid, representation: "amem-note-v0" }),
      ],
      [
        "an embedding space",
        (valid) => ({
          ...valid,
          embeddingSpace: { ...valid.embeddingSpace, id: "another-space" },
        }),
      ],
      [
        "a repeated note identity",
        (valid) => ({
          ...valid,
          records: [valid.records[0], valid.records[0]],
        }),
      ],
      [
        "a missing incoming record",
        (valid) => ({ ...valid, noteId: OTHER_ID }),
      ],
      [
        "a vector of the wrong size",
        (valid) => ({
          ...valid,
          records: [
            { ...valid.records[0]!, vector: [...valid.records[0]!.vector, 1] },
          ],
        }),
      ],
      [
        "an unknown plan field",
        (valid) => ({ ...valid, appliedAt: NOTE_TIMESTAMP }),
      ],
    ];

    for (const [description, build] of cases) {
      const error = expectMemoryError(
        await rejection(harness.memory.apply(build(plan) as InsertionPlan)),
      );
      expect(error.operation, description).toBe("apply");
      expect(error.stage, description).toBe("input");
      expect(error.persistence, description).toBe("unchanged");
      expect(harness.store.writes, description).toEqual([]);
    }
  });

  it("rejects a plan of another embedding space for this instance", async () => {
    const harness = createMemory();
    const plan = await preparedPlan(harness);
    const otherStore = new RecordingStore();
    const otherEmbedder = new ControlledEmbedder({
      id: "amem-test-space",
      dimensions: 8,
      distance: "Cosine",
    });
    const other = new AgenticMemory(otherStore, otherEmbedder, harness.model);

    const error = expectMemoryError(await rejection(other.apply(plan)));

    expect(error.operation).toBe("apply");
    expect(error.stage).toBe("input");
    expect(otherStore.writes).toEqual([]);
    expect(otherEmbedder.texts).toEqual([]);
  });

  it("reports a rejected application as uncertain with the prepared batch", async () => {
    const harness = createMemory();
    const plan = await preparedPlan(harness);
    const failure = new Error("the connection was reset");
    harness.store.putError = failure;

    const error = expectMemoryError(
      await rejection(harness.memory.apply(plan)),
    );

    expect(error.operation).toBe("apply");
    expect(error.stage).toBe("persist");
    expect(error.persistence).toBe("uncertain");
    expect(error.noteId).toBe(NOTE_ID);
    expect(error.affectedNoteIds).toEqual([NOTE_ID]);
    expect(error.cause).toBe(failure);
    expect(harness.store.writes).toEqual([]);
  });
});

const planIds = (plan: InsertionPlan): string[] =>
  plan.records.map((record) => record.note.id);

/** The update time is runtime bookkeeping; it is never supplied by the caller. */
describe("durable insertion update time", () => {
  it("samples the batch preparation time once during preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T09:00:00.000Z"));
    const harness = createMemory();
    const current = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", () => {
      vi.setSystemTime(new Date("2026-09-28T09:05:00.000Z"));
      return {
        links: [current.id],
        newTags: ["incoming"],
        updates: [
          {
            id: current.id,
            context:
              "The earlier observation now supports the incoming account.",
            keywords: ["observation"],
            tags: ["history"],
          },
        ],
      };
    });

    const plan = await harness.memory.prepare({
      noteId: NOTE_ID,
      content: "The incoming account.",
      timestamp: NOTE_TIMESTAMP,
    });

    expect(plan.records.map((record) => record.note.updatedAt)).toEqual([
      "2026-09-28T09:05:00.000Z",
      "2026-09-28T09:05:00.000Z",
    ]);
    expect(plan.records[1]!.note.timestamp).toBe(NOTE_TIMESTAMP);
    vi.useRealTimers();
  });
});
