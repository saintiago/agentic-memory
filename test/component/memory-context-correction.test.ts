import { describe, expect, it } from "vitest";

import {
  AgenticMemory,
  embeddingText,
  insertionPlanSchema,
  insertionPlanVersion,
  representationVersion,
  type Attributes,
  type ContextCorrectionInput,
  type Note,
} from "../../src/index.js";
import {
  ControlledEmbedder,
  RecordingStore,
  ScriptedModel,
  expectMemoryError,
  flush,
  rejection,
  vectorFor,
} from "./support/memory-harness.js";

/**
 * Component tests for reviewed context-correction preparation: the proposal is validated and
 * detached before external work, the current note is read and compared completely, a no-op
 * conserves the record and a change returns a frozen one-record plan the existing apply writes.
 *
 * See docs/memory.md#existing-context-correction.
 */

const NOTE_ID = "5c9c1f6e-2f0b-4c3a-9f6d-7a1b2c3d4e05";
const LINK_ID = "6f2bb0d4-1c1e-4a2b-8f43-1c9a3d4c5e02";
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
  links: [LINK_ID],
  metadata: { origin: "host", nested: { count: 1 } },
  ...overrides,
});

const noteAttributes = (note: Note): Attributes => ({
  context: note.context,
  keywords: note.keywords,
  tags: note.tags,
});

const changedAttributes = (): Attributes => ({
  context: "Requires an operator approval before removing a queue entry.",
  keywords: ["queue entry", "approval"],
  tags: ["operations", "policy"],
});

const createMemory = (
  note?: Note,
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
    store.seed({ note, vector: [1, 0, 0, 0] });
  }
  return {
    store,
    embedder,
    model,
    memory: new AgenticMemory(store, embedder, model),
  };
};

describe("reviewed context correction preparation", () => {
  it("rejects an invalid proposal at the input stage before any store read", async () => {
    const harness = createMemory();
    const validExpected = storedNote();
    const validAttributes = noteAttributes(validExpected);
    const invalidProposals: unknown[] = [
      undefined,
      {},
      { expected: validExpected },
      { attributes: validAttributes },
      {
        expected: { ...validExpected, content: "   " },
        attributes: validAttributes,
      },
      {
        expected: { ...validExpected, links: [LINK_ID, LINK_ID] },
        attributes: validAttributes,
      },
      {
        expected: validExpected,
        attributes: { context: "x", keywords: [""], tags: [] },
      },
      { expected: validExpected, attributes: validAttributes, extra: true },
    ];

    for (const proposal of invalidProposals) {
      const failure = await rejection(
        harness.memory.prepareContextCorrection(
          proposal as ContextCorrectionInput,
        ),
      );
      const error = expectMemoryError(failure);
      expect(error.operation).toBe("prepareContextCorrection");
      expect(error.stage).toBe("input");
      expect(error.persistence).toBe("unchanged");
    }
    expect(harness.store.calls).toEqual([]);
    expect(harness.embedder.texts).toEqual([]);
    expect(harness.store.writes).toEqual([]);
  });

  it("rejects a missing inspected note as an unchanged read failure without writing", async () => {
    const harness = createMemory();

    const failure = await rejection(
      harness.memory.prepareContextCorrection({
        expected: storedNote(),
        attributes: changedAttributes(),
      }),
    );

    const error = expectMemoryError(failure);
    expect(error.operation).toBe("prepareContextCorrection");
    expect(error.stage).toBe("read");
    expect(error.persistence).toBe("unchanged");
    expect(error.noteId).toBe(NOTE_ID);
    expect(error.readOutcome).toBe("stale");
    expect(harness.store.calls).toEqual(["get"]);
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
      { links: [] },
      { metadata: { origin: "host", nested: { count: 2 } } },
    ];

    for (const difference of differences) {
      const failure = await rejection(
        harness.memory.prepareContextCorrection({
          expected: { ...note, ...difference },
          attributes: changedAttributes(),
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

  it("compares complete values independent of JSON object key order", async () => {
    const note = storedNote({
      metadata: { origin: "host", nested: { count: 1 } },
    });
    const harness = createMemory(note);
    // The same values in another insertion order must not look stale.
    const expected = {
      ...note,
      metadata: { nested: { count: 1 }, origin: "host" },
    };

    const preparation = await harness.memory.prepareContextCorrection({
      expected,
      attributes: noteAttributes(note),
    });

    expect(preparation.plan).toBeUndefined();
    expect(preparation.note).toEqual(note);
  });

  it("reports a store read failure as an unchanged read failure", async () => {
    const harness = createMemory(storedNote());
    harness.store.getError = new Error("the collection is unavailable");

    const failure = await rejection(
      harness.memory.prepareContextCorrection({
        expected: storedNote(),
        attributes: changedAttributes(),
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

  it("returns the detached current note without embedding or a new update time on a no-op", async () => {
    const note = storedNote();
    const harness = createMemory(note);
    const before = harness.store.stored(NOTE_ID);
    const recordBefore = harness.store.records.get(NOTE_ID)!.vector;

    const preparation = await harness.memory.prepareContextCorrection({
      expected: note,
      attributes: noteAttributes(note),
    });

    expect("plan" in preparation).toBe(false);
    expect(preparation.note).toEqual(note);
    expect(preparation.note.updatedAt).toBe(NOTE_UPDATED_AT);
    expect(harness.store.calls).toEqual(["get"]);
    expect(harness.store.writes).toEqual([]);
    expect(harness.embedder.texts).toEqual([]);
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.stored(NOTE_ID)).toEqual(before);
    expect(harness.store.storedVector(NOTE_ID)).toEqual(recordBefore);
  });

  it("preserves an unknown legacy update time on a no-op", async () => {
    const legacy: Note = {
      id: NOTE_ID,
      content: "A legacy record without an update time.",
      timestamp: NOTE_TIMESTAMP,
      context: "Records the legacy record.",
      keywords: ["legacy"],
      tags: ["history"],
      links: [],
    };
    const harness = createMemory(legacy);

    const preparation = await harness.memory.prepareContextCorrection({
      expected: legacy,
      attributes: noteAttributes(legacy),
    });

    expect(preparation.plan).toBeUndefined();
    expect("updatedAt" in preparation.note).toBe(false);
    expect(harness.embedder.texts).toEqual([]);
    expect(harness.store.stored(NOTE_ID)).toEqual(legacy);
  });

  it("returns a frozen one-record plan replacing only the semantic attributes", async () => {
    const note = storedNote();
    const harness = createMemory(note);
    const attributes = changedAttributes();

    const preparation = await harness.memory.prepareContextCorrection({
      expected: note,
      attributes,
    });

    const plan = preparation.plan;
    expect(plan).toBeDefined();
    if (plan === undefined) {
      return;
    }
    expect(insertionPlanSchema.safeParse(plan).success).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.version).toBe(insertionPlanVersion);
    expect(plan.representation).toBe(representationVersion);
    expect(plan.embeddingSpace).toEqual(harness.embedder.space);
    expect(plan.noteId).toBe(NOTE_ID);
    expect(plan.records).toHaveLength(1);
    const record = plan.records[0]!;
    expect(preparation.note).toEqual(record.note);
    expect(record.note).toEqual({
      ...note,
      ...attributes,
      updatedAt: expect.any(String),
    });
    expect(record.note.updatedAt).not.toBe(NOTE_UPDATED_AT);
    expect(record.vector).toEqual(vectorFor(embeddingText(record.note)));
    expect(harness.embedder.texts).toEqual([embeddingText(record.note)]);
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.writes).toEqual([]);

    // The returned note is detached from the frozen plan a caller may hold for a long time.
    preparation.note.context = "Mutated after preparation.";
    expect(plan.records[0]!.note.context).toBe(attributes.context);
  });

  it("applies and replays the prepared plan without regenerating the record", async () => {
    const harness = createMemory(storedNote());
    const preparation = await harness.memory.prepareContextCorrection({
      expected: storedNote(),
      attributes: changedAttributes(),
    });
    const plan = preparation.plan!;

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
    expect(harness.embedder.texts).toHaveLength(1);
    expect(harness.store.writes).toHaveLength(2);
  });

  it("reports a failed embedding as an unchanged failure before any write", async () => {
    const note = storedNote();
    const harness = createMemory(note);
    const before = harness.store.stored(NOTE_ID);
    harness.embedder.failNext = new Error("the encoder runtime is unavailable");

    const failure = await rejection(
      harness.memory.prepareContextCorrection({
        expected: note,
        attributes: changedAttributes(),
      }),
    );

    const error = expectMemoryError(failure);
    expect(error.operation).toBe("prepareContextCorrection");
    expect(error.stage).toBe("embed");
    expect(error.persistence).toBe("unchanged");
    expect(error.noteId).toBe(NOTE_ID);
    expect(error.cause).toBeInstanceOf(Error);
    expect(harness.store.writes).toEqual([]);
    expect(harness.store.stored(NOTE_ID)).toEqual(before);
  });

  it("rejects an unusable provider vector before any write", async () => {
    const note = storedNote();
    const harness = createMemory(note);
    harness.embedder.source = () => [1, 2, 3];

    const wrongLength = await rejection(
      harness.memory.prepareContextCorrection({
        expected: note,
        attributes: changedAttributes(),
      }),
    );
    expect(expectMemoryError(wrongLength).stage).toBe("embed");
    expect(expectMemoryError(wrongLength).persistence).toBe("unchanged");

    harness.embedder.source = () => [0, 0, 0, 0];
    const zeroNorm = await rejection(
      harness.memory.prepareContextCorrection({
        expected: note,
        attributes: changedAttributes(),
      }),
    );
    expect(expectMemoryError(zeroNorm).stage).toBe("embed");
    expect(harness.store.writes).toEqual([]);
    expect(harness.store.stored(NOTE_ID)).toEqual(note);
  });

  it("serializes with insertions and uses the proposal detached at the call boundary", async () => {
    const note = storedNote();
    const pristine = structuredClone(note);
    const harness = createMemory(note);
    // Hold the earlier insertion's write so the correction stays queued.
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

    const proposal: ContextCorrectionInput = {
      expected: note,
      attributes: changedAttributes(),
    };
    const correction = harness.memory.prepareContextCorrection(proposal);
    // Mutating every supplied value after the call must not alter the accepted proposal.
    proposal.expected.context = "Mutated expected context.";
    proposal.expected.metadata = { mutated: true };
    proposal.attributes.context = "Mutated replacement.";
    proposal.attributes.keywords.push("mutated");
    proposal.attributes.tags.length = 0;
    await flush();

    // The correction read waits for the earlier insertion; only its held write is outstanding.
    expect(harness.store.calls).toEqual(["nearest:5:4", "put"]);

    gate.resolve();
    await pending;
    const preparation = await correction;

    expect(harness.store.calls).toEqual(["nearest:5:4", "put", "get"]);
    expect(preparation.note.context).toBe(changedAttributes().context);
    expect(preparation.note.keywords).toEqual(changedAttributes().keywords);
    expect(preparation.note.tags).toEqual(changedAttributes().tags);
    expect(preparation.note.metadata).toEqual(pristine.metadata);
    expect(preparation.plan).toBeDefined();
  });

  it("does not poison later operations after a stale rejection", async () => {
    const note = storedNote();
    const harness = createMemory(note);
    const attributes = changedAttributes();

    const stale = await rejection(
      harness.memory.prepareContextCorrection({
        expected: { ...note, context: "A stale inspection." },
        attributes,
      }),
    );
    expect(expectMemoryError(stale).stage).toBe("read");

    const preparation = await harness.memory.prepareContextCorrection({
      expected: note,
      attributes,
    });
    expect(preparation.plan).toBeDefined();
    expect(harness.store.writes).toEqual([]);
  });
});
