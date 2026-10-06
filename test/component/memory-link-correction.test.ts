import { describe, expect, it } from "vitest";

import {
  AgenticMemory,
  insertionPlanSchema,
  insertionPlanVersion,
  representationVersion,
  type LinkCorrectionInput,
  type Note,
} from "../../src/index.js";
import {
  ControlledEmbedder,
  RecordingStore,
  ScriptedModel,
  expectMemoryError,
  flush,
  rejection,
} from "./support/memory-harness.js";

/**
 * Component tests for reviewed link-correction preparation: the proposal is validated and detached
 * before external work, the current record is read with its stored vector and compared completely,
 * and every valid removal returns a frozen one-record plan the existing apply writes unchanged.
 *
 * See docs/memory.md#existing-link-correction.
 */

const NOTE_ID = "5c9c1f6e-2f0b-4c3a-9f6d-7a1b2c3d4e05";
const TARGET_A = "6f2bb0d4-1c1e-4a2b-8f43-1c9a3d4c5e02";
const TARGET_B = "7a3cc1e5-2d2f-4b3c-9a54-2dab4e5d6f03";
const TARGET_C = "8b4dd2f6-3e30-4c4d-ab65-3ebc5f6e7a04";
const TARGET_D = "9c5ee307-4f41-4d5e-bc76-4fcd60718b05";
const MISSING_ID = "ad6ff418-5052-4e6f-cd87-50de71829c06";
const NOTE_TIMESTAMP = "2026-09-27T15:44:27.001+02:00";
const NOTE_UPDATED_AT = "2026-09-30T08:10:11.000Z";

const storedNote = (overrides: Partial<Note> = {}): Note => ({
  id: NOTE_ID,
  content: "An existing observation about the stored subject.",
  timestamp: NOTE_TIMESTAMP,
  updatedAt: NOTE_UPDATED_AT,
  context: "Records the existing observation.",
  keywords: ["observation"],
  tags: ["history"],
  links: [TARGET_A, TARGET_B, TARGET_C],
  metadata: { origin: "host", nested: { count: 1 } },
  ...overrides,
});

const createMemory = (
  note?: Note,
  vector: number[] = [1, 0, 0, 0],
): {
  store: RecordingStore;
  embedder: ControlledEmbedder;
  model: ScriptedModel;
  memory: AgenticMemory;
} => {
  const store = new RecordingStore();
  const embedder = new ControlledEmbedder();
  const model = new ScriptedModel();
  if (note !== undefined) {
    store.seed({ note, vector });
  }
  return {
    store,
    embedder,
    model,
    memory: new AgenticMemory(store, embedder, model),
  };
};

describe("reviewed link correction preparation", () => {
  it("rejects an invalid removal set at the input stage before any store read", async () => {
    const harness = createMemory();
    const validExpected = storedNote();
    const invalidProposals: unknown[] = [
      undefined,
      {},
      { expected: validExpected },
      { removeTargetIds: [TARGET_A] },
      { expected: validExpected, removeTargetIds: [] },
      { expected: validExpected, removeTargetIds: [TARGET_A, TARGET_A] },
      {
        expected: validExpected,
        removeTargetIds: [TARGET_A, TARGET_A.toUpperCase()],
      },
      { expected: validExpected, removeTargetIds: [MISSING_ID] },
      { expected: validExpected, removeTargetIds: ["not-a-uuid"] },
      {
        expected: { ...validExpected, links: [TARGET_A, TARGET_A] },
        removeTargetIds: [TARGET_A],
      },
      {
        expected: validExpected,
        removeTargetIds: [TARGET_A],
        attributes: { context: "Not accepted.", keywords: [], tags: [] },
      },
      {
        expected: validExpected,
        removeTargetIds: [TARGET_A],
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      { expected: validExpected, removeTargetIds: [TARGET_A], extra: true },
    ];

    for (const proposal of invalidProposals) {
      const failure = await rejection(
        harness.memory.prepareLinkCorrection(proposal as LinkCorrectionInput),
      );
      const error = expectMemoryError(failure);
      expect(error.operation).toBe("prepareLinkCorrection");
      expect(error.stage).toBe("input");
      expect(error.persistence).toBe("unchanged");
    }
    expect(harness.store.calls).toEqual([]);
    expect(harness.embedder.texts).toEqual([]);
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.writes).toEqual([]);
  });

  it("rejects a missing inspected note as an unchanged read failure without writing", async () => {
    const harness = createMemory();

    const failure = await rejection(
      harness.memory.prepareLinkCorrection({
        expected: storedNote(),
        removeTargetIds: [TARGET_A],
      }),
    );

    const error = expectMemoryError(failure);
    expect(error.operation).toBe("prepareLinkCorrection");
    expect(error.stage).toBe("read");
    expect(error.persistence).toBe("unchanged");
    expect(error.noteId).toBe(NOTE_ID);
    expect(error.readOutcome).toBe("stale");
    expect(harness.store.calls).toEqual(["getEmbedded"]);
    expect(harness.store.writes).toEqual([]);
    expect(harness.embedder.texts).toEqual([]);
  });

  it("rejects a stale proposal whenever any inspected value differs", async () => {
    const note = storedNote();
    const harness = createMemory(note);
    const differences: Partial<Note>[] = [
      { content: "Different source content." },
      { timestamp: "2026-09-28T00:00:00.000Z" },
      { updatedAt: "2026-10-01T00:00:00.000Z" },
      { context: "A different current context." },
      { keywords: ["changed"] },
      { tags: [] },
      { links: [TARGET_A, TARGET_B] },
      { metadata: { origin: "host", nested: { count: 2 } } },
    ];

    for (const difference of differences) {
      const failure = await rejection(
        harness.memory.prepareLinkCorrection({
          expected: { ...note, ...difference },
          removeTargetIds: [TARGET_A],
        }),
      );
      const error = expectMemoryError(failure);
      expect(error.stage).toBe("read");
      expect(error.persistence).toBe("unchanged");
      expect(error.noteId).toBe(NOTE_ID);
      expect(error.readOutcome).toBe("stale");
    }
    expect(harness.store.writes).toEqual([]);
    expect(harness.embedder.texts).toEqual([]);
  });

  it("reports a vector-bearing store read failure as an unobserved read", async () => {
    const harness = createMemory(storedNote());
    harness.store.getEmbeddedError = new Error("the collection is unavailable");

    const failure = await rejection(
      harness.memory.prepareLinkCorrection({
        expected: storedNote(),
        removeTargetIds: [TARGET_A],
      }),
    );

    const error = expectMemoryError(failure);
    expect(error.stage).toBe("read");
    expect(error.persistence).toBe("unchanged");
    expect(error.noteId).toBe(NOTE_ID);
    // A failed read leaves storage unobserved; it is not a confirmed stale proposal.
    expect(error.readOutcome).toBe("unknown");
    expect(error.cause).toBeInstanceOf(Error);
    expect(harness.store.writes).toEqual([]);
  });

  it("rejects an unusable stored vector as an unobserved read", async () => {
    const note = storedNote();
    const zeroNorm = createMemory(note, [0, 0, 0, 0]);

    const zeroNormFailure = await rejection(
      zeroNorm.memory.prepareLinkCorrection({
        expected: note,
        removeTargetIds: [TARGET_A],
      }),
    );
    expect(expectMemoryError(zeroNormFailure).readOutcome).toBe("unknown");
    expect(expectMemoryError(zeroNormFailure).stage).toBe("read");
    expect(zeroNorm.store.writes).toEqual([]);

    const wrongDimensions = createMemory(note, [1, 0, 0]);
    const dimensionFailure = await rejection(
      wrongDimensions.memory.prepareLinkCorrection({
        expected: note,
        removeTargetIds: [TARGET_A],
      }),
    );
    expect(expectMemoryError(dimensionFailure).readOutcome).toBe("unknown");
    expect(expectMemoryError(dimensionFailure).persistence).toBe("unchanged");
  });

  it("returns a detached frozen one-record plan removing only the selected links", async () => {
    const note = storedNote({
      links: [TARGET_A, TARGET_B.toUpperCase(), TARGET_C, TARGET_D],
    });
    const harness = createMemory(note);
    const storedVector = harness.store.storedVector(NOTE_ID)!;
    const sourceNote = harness.store.stored(NOTE_ID)!;

    const plan = await harness.memory.prepareLinkCorrection({
      expected: note,
      // Target identity is case-insensitive, so the lower-case request removes the upper-case link.
      removeTargetIds: [TARGET_B, TARGET_D],
    });

    expect(insertionPlanSchema.safeParse(plan).success).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.version).toBe(insertionPlanVersion);
    expect(plan.representation).toBe(representationVersion);
    expect(plan.embeddingSpace).toEqual(harness.embedder.space);
    expect(plan.noteId).toBe(NOTE_ID);
    expect(plan.records).toHaveLength(1);
    const record = plan.records[0]!;
    expect(record.note).toEqual({
      ...note,
      links: [TARGET_A, TARGET_C],
      updatedAt: expect.any(String),
    });
    expect(record.note.updatedAt).not.toBe(NOTE_UPDATED_AT);
    expect(record.note.content).toBe(note.content);
    expect(record.note.timestamp).toBe(note.timestamp);
    expect(record.note.metadata).toEqual(note.metadata);
    // The actual stored vector is reused unchanged; preparation never encodes.
    expect(record.vector).toEqual(storedVector);
    expect(record.vector).not.toBe(storedVector);
    expect(harness.store.calls).toEqual(["getEmbedded"]);
    expect(harness.store.writes).toEqual([]);
    expect(harness.embedder.texts).toEqual([]);
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.stored(NOTE_ID)).toEqual(sourceNote);
    expect(harness.store.storedVector(NOTE_ID)).toEqual(storedVector);
  });

  it("removes every link and establishes an update time on a legacy note", async () => {
    const legacy: Note = {
      id: NOTE_ID,
      content: "A legacy record without an update time.",
      timestamp: NOTE_TIMESTAMP,
      context: "Records the legacy record.",
      keywords: ["legacy"],
      tags: ["history"],
      links: [TARGET_A],
    };
    const harness = createMemory(legacy);

    const plan = await harness.memory.prepareLinkCorrection({
      expected: legacy,
      removeTargetIds: [TARGET_A],
    });

    const record = plan.records[0]!;
    expect(record.note.links).toEqual([]);
    expect(record.note.updatedAt).toEqual(expect.any(String));
    expect(record.vector).toEqual([1, 0, 0, 0]);
    expect(harness.store.writes).toEqual([]);
  });

  it("applies and replays the prepared plan without regenerating the record", async () => {
    const note = storedNote();
    const harness = createMemory(note);
    const plan = await harness.memory.prepareLinkCorrection({
      expected: note,
      removeTargetIds: [TARGET_B],
    });

    const applied = await harness.memory.apply(plan);
    const afterFirst = harness.store.stored(NOTE_ID);
    const vectorAfterFirst = harness.store.storedVector(NOTE_ID);
    expect(applied).toEqual(plan.records[0]!.note);
    expect(afterFirst).toEqual(plan.records[0]!.note);
    expect(vectorAfterFirst).toEqual(plan.records[0]!.vector);

    const replayed = await harness.memory.apply(plan);
    expect(replayed).toEqual(applied);
    expect(harness.store.stored(NOTE_ID)).toEqual(afterFirst);
    expect(harness.store.storedVector(NOTE_ID)).toEqual(vectorAfterFirst);
    // Application never embeds or regenerates; the plan carries its prepared vector.
    expect(harness.embedder.texts).toEqual([]);
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.writes).toHaveLength(2);
  });

  it("serializes with insertions and uses the proposal detached at the call boundary", async () => {
    const note = storedNote();
    const pristine = structuredClone(note);
    const harness = createMemory(note);
    // Hold the earlier insertion's write so the link correction stays queued.
    const gate = harness.store.holdWrites();
    harness.model.queue("construct", () => ({
      context: "Records the pending source.",
      keywords: ["pending"],
      tags: [],
    }));
    // The stored note is the nearest candidate, so the insertion needs one evolution decision.
    harness.model.queue("evolve", () => ({
      links: [],
      newTags: [],
      updates: [],
    }));
    const pending = harness.memory.add({ content: "The pending source." });
    await flush();

    const proposal: LinkCorrectionInput = {
      expected: note,
      removeTargetIds: [TARGET_C],
    };
    const embedsBefore = harness.embedder.texts.length;
    const correction = harness.memory.prepareLinkCorrection(proposal);
    // Mutating every supplied value after the call must not alter the accepted proposal.
    proposal.expected.links = [];
    proposal.expected.metadata = { mutated: true };
    proposal.removeTargetIds.push(MISSING_ID);
    await flush();

    // The correction read waits for the earlier insertion; only its held write is outstanding.
    expect(harness.store.calls).toEqual(["nearest:5:4", "put"]);

    gate.resolve();
    await pending;
    const plan = await correction;

    expect(harness.store.calls).toEqual(["nearest:5:4", "put", "getEmbedded"]);
    expect(plan.records[0]!.note.links).toEqual([TARGET_A, TARGET_B]);
    expect(plan.records[0]!.note.metadata).toEqual(pristine.metadata);
    expect(plan.records[0]!.note.updatedAt).not.toBe(NOTE_UPDATED_AT);
    // The pending insertion embedded its own source; the link correction added none.
    expect(harness.embedder.texts).toHaveLength(embedsBefore);
  });

  it("does not poison later operations after a stale rejection", async () => {
    const note = storedNote();
    const harness = createMemory(note);

    const stale = await rejection(
      harness.memory.prepareLinkCorrection({
        expected: { ...note, context: "A stale inspection." },
        removeTargetIds: [TARGET_A],
      }),
    );
    expect(expectMemoryError(stale).stage).toBe("read");
    expect(expectMemoryError(stale).readOutcome).toBe("stale");

    const plan = await harness.memory.prepareLinkCorrection({
      expected: note,
      removeTargetIds: [TARGET_A],
    });
    expect(plan.records[0]!.note.links).toEqual([TARGET_B, TARGET_C]);
    expect(harness.store.writes).toEqual([]);
  });
});
