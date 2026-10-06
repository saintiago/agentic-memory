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
  adminClient,
  dropCollection,
  note as makeNote,
  openStore,
  uniqueCollection,
} from "../support/note-store.js";

/**
 * System journey for reviewed link correction with the assembled library and an isolated real
 * Qdrant: Memory reads the current record through the vector-bearing provider read, applies the
 * actual prepared plan and replays it unchanged. The model is never called and the embedding
 * output is controlled, so this asserts wiring, vector preservation and persistence rather than
 * model judgment.
 *
 * See docs/memory.md#existing-link-correction and docs/testing.md#system-journeys.
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

/** Link preparation must never construct or evolve, so any model call fails the case. */
class UnusedModel implements LanguageModel {
  readonly requests: ModelRequest[] = [];

  async generate(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    throw new Error(
      `Unexpected ${request.stage} request during link correction.`,
    );
  }
}

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

const expectVector = (
  actual: readonly number[] | undefined,
  expected: readonly number[],
): void => {
  expect(actual).toHaveLength(expected.length);
  actual?.forEach((component, index) => {
    expect(component).toBeCloseTo(expected[index] ?? Number.NaN, 5);
  });
};

const sourceNote = (links: string[]): Note =>
  makeNote({
    content: "Removing a stale queue entry requires an operator approval.",
    context:
      "Records the approval requirement for removing stale queue entries.",
    keywords: ["queue entry", "approval"],
    tags: ["operations", "policy"],
    links,
    metadata: { origin: "host", nested: { count: 1 } },
  });

describe("link correction journey", () => {
  it("removes only the reviewed links with the stored vector and replays exactly", async () => {
    const name = collection("link-correction");
    const store = await openStore(name);
    const embedder = new TopicEmbedder();
    const model = new UnusedModel();
    const linked = makeNote({ content: "The linked archive account." });
    const kept = makeNote({ content: "The kept archive account." });
    const other = makeNote({ content: "The other archive account." });
    const source = sourceNote([linked.id, kept.id, other.id]);
    await store.put([
      { note: linked, vector: [0, 1, 0, 0] },
      { note: kept, vector: [0, 0, 1, 0] },
      { note: other, vector: [0, 0, 0, 1] },
      { note: source, vector: [1, 0, 0, 0] },
    ]);

    const reopened = await openStore(name);
    const memory = new AgenticMemory(reopened, embedder, model);
    const [inspected] = await reopened.getEmbedded([source.id]);
    expect(inspected?.note).toEqual(source);

    const plan = await memory.prepareLinkCorrection({
      expected: inspected!.note,
      removeTargetIds: [linked.id, other.id],
    });

    expect(plan.noteId).toBe(source.id);
    expect(plan.records).toHaveLength(1);
    const prepared = plan.records[0]!;
    expect(prepared.note).toEqual({
      ...source,
      links: [kept.id],
      updatedAt: expect.any(String),
    });
    expect(prepared.note.content).toBe(source.content);
    expect(prepared.note.timestamp).toBe(source.timestamp);
    expect(prepared.note.metadata).toEqual(source.metadata);
    expect(prepared.vector).toEqual(inspected!.vector);
    expect(embedder.texts).toEqual([]);
    expect(model.requests).toEqual([]);

    const applied = await memory.apply(plan);
    expect(applied).toEqual(prepared.note);

    const afterApply = await reopened.getEmbedded([
      source.id,
      linked.id,
      kept.id,
      other.id,
    ]);
    const byId = new Map(
      afterApply.map((record) => [record.note.id, record] as const),
    );
    expect(byId.get(source.id)?.note).toEqual(prepared.note);
    expectVector(byId.get(source.id)?.vector, inspected!.vector);
    // The endpoints and every relationship outside the removal set stay unchanged.
    expect(byId.get(linked.id)?.note).toEqual(linked);
    expectVector(byId.get(linked.id)?.vector, [0, 1, 0, 0]);
    expect(byId.get(kept.id)?.note).toEqual(kept);
    expect(byId.get(other.id)?.note).toEqual(other);

    // Replaying the exact plan preserves the prepared values, vector and update time.
    const replayed = await memory.apply(plan);
    expect(replayed).toEqual(applied);
    const afterReplay = await reopened.getEmbedded([source.id]);
    expect(afterReplay[0]?.note).toEqual(prepared.note);
    expectVector(afterReplay[0]?.vector, inspected!.vector);

    // The superseded inspection is stale, while an unreadable record is not staleness.
    const stale = await captureRejection(
      memory.prepareLinkCorrection({
        expected: inspected!.note,
        removeTargetIds: [linked.id],
      }),
    );
    expect(stale).toBeInstanceOf(MemoryError);
    expect((stale as MemoryError).stage).toBe("read");
    expect((stale as MemoryError).readOutcome).toBe("stale");
    expect((stale as MemoryError).persistence).toBe("unchanged");

    const absent = sourceNote([kept.id]);
    const missing = await captureRejection(
      memory.prepareLinkCorrection({
        expected: absent,
        removeTargetIds: [kept.id],
      }),
    );
    expect((missing as MemoryError).readOutcome).toBe("stale");

    const broken = sourceNote([kept.id]);
    await adminClient().upsert(name, {
      wait: true,
      points: [{ id: broken.id, vector: {}, payload: broken }],
    });
    const unreadable = await captureRejection(
      memory.prepareLinkCorrection({
        expected: broken,
        removeTargetIds: [kept.id],
      }),
    );
    expect(unreadable).toBeInstanceOf(MemoryError);
    expect((unreadable as MemoryError).stage).toBe("read");
    expect((unreadable as MemoryError).readOutcome).toBe("unknown");
    expect((unreadable as MemoryError).persistence).toBe("unchanged");
    expect(embedder.texts).toEqual([]);
    expect(model.requests).toEqual([]);
  });

  it("keeps a removed target reachable through another valid edge", async () => {
    const name = collection("link-routes");
    const store = await openStore(name);
    const embedder = new TopicEmbedder();
    const model = new UnusedModel();
    const target = makeNote({ content: "The linked queue archive." });
    const further = makeNote({ content: "A further linked queue archive." });
    const source = sourceNote([target.id, further.id]);
    const bridge = makeNote({
      content: "A second queue account linking the same archive.",
      links: [target.id],
    });
    await store.put([
      { note: target, vector: [0, 1, 0, 0] },
      { note: further, vector: [0, 0, 1, 0] },
      { note: source, vector: [1, 0, 0, 0] },
      { note: bridge, vector: [0.6, 0.8, 0, 0] },
    ]);

    const memory = new AgenticMemory(store, embedder, model);
    const before = await memory.search(
      "queue removal needs an operator approval",
      {
        limit: 2,
        linkedLimit: 5,
      },
    );
    expect(before.map((result) => [result.note.id, result.via])).toEqual([
      [source.id, "match"],
      [bridge.id, "match"],
      [target.id, "link"],
      [further.id, "link"],
    ]);

    const embedsBeforeCorrection = embedder.texts.length;
    const [inspected] = await store.getEmbedded([source.id]);
    const plan = await memory.prepareLinkCorrection({
      expected: inspected!.note,
      removeTargetIds: [target.id],
    });
    await memory.apply(plan);
    // Preparation and application never embed, construct or search.
    expect(embedder.texts).toHaveLength(embedsBeforeCorrection);
    expect(model.requests).toEqual([]);

    const [current] = await store.get([source.id]);
    expect(current?.links).toEqual([further.id]);

    // The removed edge is gone; the target still arrives through the bridge's valid edge and the
    // corrected source keeps its remaining link. This limit already returned both linked notes
    // before removal, so the case asserts routes and order, not a newly freed budget slot.
    const after = await memory.search(
      "queue removal needs an operator approval",
      {
        limit: 2,
        linkedLimit: 5,
      },
    );
    expect(after.map((result) => [result.note.id, result.via])).toEqual([
      [source.id, "match"],
      [bridge.id, "match"],
      [further.id, "link"],
      [target.id, "link"],
    ]);
  });
});
