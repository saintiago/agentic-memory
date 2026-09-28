import { afterAll, describe, expect, it } from "vitest";
import type {
  Cursor,
  EmbeddedNote,
  Note,
} from "../../../src/note-store/index.js";
import {
  SENTINEL_ID,
  adminClient,
  dropCollection,
  embedded,
  note,
  openStore,
  orderedNoteId,
  pointCount,
  uniqueCollection,
} from "../support/note-store.js";

/** docs/note-store.md and docs/testing.md#contracts-and-cooperation */

const created: string[] = [];

const collection = (label: string): string => {
  const name = uniqueCollection(label);
  created.push(name);
  return name;
};

const idsOf = (notes: readonly Note[]): string[] =>
  notes.map((note) => note.id).sort();

/**
 * The vector Qdrant actually stores for cosine distance: the prepared vector normalized. The
 * component comparison keeps float32 and server-side normalization rounding out of the assertion.
 */
const storedVector = (vector: readonly number[]): number[] => {
  const norm = Math.sqrt(
    vector.reduce((total, component) => total + component * component, 0),
  );
  return vector.map((component) => component / norm);
};

afterAll(async () => {
  for (const name of created) {
    await dropCollection(name);
  }
});

describe("Qdrant note store contract", () => {
  it("stores complete records that survive reopening", async () => {
    const name = collection("reopen");
    const store = await openStore(name);
    const linked = embedded({ content: "The linked note." }, [1, 0, 0, 0]);
    const other = embedded({ content: "Another linked note." }, [0, 1, 0, 0]);
    const rich = embedded(
      {
        content: "  Keep  the  supplied  spacing  ",
        keywords: ["b", "a", "B"],
        tags: [],
        links: [linked.note.id.toUpperCase(), other.note.id],
        metadata: {
          origin: "host",
          nested: { list: [1, 2.5, null, true, "text"], empty: {} },
        },
      },
      [0.5, -0.5, 0.25, 0.75],
    );
    const records = [linked, other, rich];

    await store.put(records);
    const reopened = await openStore(name);

    const found = await reopened.get(records.map((record) => record.note.id));

    expect(idsOf(found)).toEqual(idsOf(records.map((record) => record.note)));
    for (const record of records) {
      expect(found).toContainEqual(record.note);
    }
  });

  it("replaces records so updates change search results", async () => {
    const name = collection("update");
    const store = await openStore(name);
    const first = embedded({ content: "The original account." }, [1, 0, 0, 0]);
    const second = embedded({ content: "An unrelated account." }, [1, 0, 0, 0]);

    await store.put([first, second]);
    const before = await store.nearest([1, 0, 0, 0], 2);
    expect(idsOf(before.map((match) => match.note))).toEqual(
      idsOf([first.note, second.note]),
    );
    for (const match of before) {
      expect(match.score).toBeCloseTo(1, 6);
    }

    const updated: EmbeddedNote = {
      note: {
        ...first.note,
        content: "The revised account.",
        context: "Records the revised account.",
      },
      vector: [0, 1, 0, 0],
    };
    await store.put([updated]);

    const after = await store.nearest([1, 0, 0, 0], 2);
    expect(after.map((match) => match.note.id)).toEqual([
      second.note.id,
      first.note.id,
    ]);
    expect(after[0]?.score).toBeCloseTo(1, 6);
    expect(after[1]?.score).toBeCloseTo(0, 6);
    expect(await store.get([first.note.id])).toEqual([updated.note]);
  });

  it("omits missing IDs and returns each found ID at most once", async () => {
    const name = collection("identity");
    const store = await openStore(name);
    const stored = embedded();
    await store.put([stored]);

    const found = await store.get([
      stored.note.id,
      SENTINEL_ID,
      stored.note.id.toUpperCase(),
    ]);

    expect(found).toEqual([stored.note]);
    await expect(store.get(["note-1"])).rejects.toThrow(/UUID/);
  });

  it("returns bounded matches ordered by descending similarity", async () => {
    const name = collection("ranked");
    const store = await openStore(name);
    const close = embedded(
      { content: "The closest account." },
      [0.9, 0.1, 0, 0],
    );
    const middle = embedded({ content: "A middle account." }, [0.7, 0.7, 0, 0]);
    const orthogonal = embedded(
      { content: "An orthogonal account." },
      [0, 1, 0, 0],
    );
    await store.put([orthogonal, close, middle]);

    const matches = await store.nearest([1, 0, 0, 0], 5);

    expect(matches.map((match) => match.note.id)).toEqual([
      close.note.id,
      middle.note.id,
      orthogonal.note.id,
    ]);
    expect(matches[0]?.score).toBeGreaterThan(0.99);
    expect(matches[0]?.score).toBeLessThanOrEqual(1);
    expect(matches[1]?.score).toBeGreaterThan(matches[2]?.score ?? 0);
    expect(await store.nearest([1, 0, 0, 0], 1)).toHaveLength(1);
  });

  it("rejects invalid search and paging inputs without dispatching them", async () => {
    const name = collection("inputs");
    const store = await openStore(name);
    await store.put([embedded()]);

    await expect(store.nearest([1, 0, 0, 0], 0)).rejects.toThrow(/limit/);
    await expect(store.nearest([1, 0, 0, 0], 1.5)).rejects.toThrow(/limit/);
    await expect(store.nearest([1, 0, 0], 1)).rejects.toThrow(/dimensions/);
    await expect(store.nearest([0, 0, 0, 0], 1)).rejects.toThrow(
      /nonzero norm/,
    );
    await expect(store.nearest([Number.NaN, 0, 0, 0], 1)).rejects.toThrow();
    await expect(store.page(0)).rejects.toThrow(/limit/);
    await expect(
      store.page(1, { offset: 1 } as unknown as Cursor),
    ).rejects.toThrow();
    await expect(store.pageEmbedded(0)).rejects.toThrow(/limit/);
    await expect(
      store.pageEmbedded(1, true as unknown as Cursor),
    ).rejects.toThrow();
  });

  it("pages an unchanged collection to completion without duplicates", async () => {
    const name = collection("paging");
    const store = await openStore(name);
    const stored = Array.from({ length: 5 }, (_, index) =>
      embedded({ content: `Stored note ${index}.` }, [0, 1, 0, 0]),
    );
    await store.put(stored);

    const seen: Note[] = [];
    let cursor: Cursor | undefined;
    let pages = 0;
    do {
      const page = await store.page(2, cursor);
      expect(page.notes.length).toBeLessThanOrEqual(2);
      seen.push(...page.notes);
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== undefined);

    expect(pages).toBe(3);
    expect(idsOf(seen)).toEqual(idsOf(stored.map((record) => record.note)));
    expect(new Set(idsOf(seen)).size).toBe(5);
    const complete = await store.page(50);
    expect(complete.notes).toHaveLength(5);
    expect(complete.cursor).toBeUndefined();
  });

  it("exports complete records with their actual stored vectors across pages", async () => {
    const name = collection("embedded");
    const store = await openStore(name);
    const stored = [
      embedded(
        { content: "The first exported record." },
        [1, -0.5, 0.25, 0.75],
      ),
      embedded({ content: "The second exported record." }, [0.125, 2, -3, 0.5]),
      embedded({ content: "The third exported record." }, [0, 1, 0, 0]),
      embedded({ content: "The fourth exported record." }, [-1, -1, 0.5, 0]),
      embedded({ content: "The fifth exported record." }, [0.5, 0, 0, -0.5]),
    ];
    await store.put(stored);
    const reopened = await openStore(name);

    const seen: EmbeddedNote[] = [];
    let cursor: Cursor | undefined;
    let pages = 0;
    do {
      const page = await reopened.pageEmbedded(2, cursor);
      expect(page.records.length).toBeLessThanOrEqual(2);
      seen.push(...page.records);
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== undefined);

    expect(pages).toBe(3);
    expect(idsOf(seen.map((record) => record.note))).toEqual(
      idsOf(stored.map((record) => record.note)),
    );
    for (const record of stored) {
      const exported = seen.find((entry) => entry.note.id === record.note.id);
      expect(exported?.note).toEqual(record.note);
      const expected = storedVector(record.vector);
      expect(exported?.vector).toHaveLength(expected.length);
      exported?.vector.forEach((component, index) => {
        expect(component).toBeCloseTo(expected[index] ?? Number.NaN, 6);
      });
    }

    const complete = await reopened.pageEmbedded(50);
    expect(complete.records).toHaveLength(5);
    expect(complete.cursor).toBeUndefined();
  });

  it("returns detached embedded records", async () => {
    const name = collection("embedded_detach");
    const store = await openStore(name);
    const record = embedded(
      { content: "A detached export." },
      [1, 0.5, -0.5, 0],
    );
    await store.put([record]);

    const page = await store.pageEmbedded(1);
    const exported = page.records[0];
    if (exported === undefined) {
      throw new Error("the stored record must be exported");
    }
    exported.note.content = "rewritten through the export";
    exported.note.tags.push("appended");
    exported.vector[0] = 42;

    const again = await store.pageEmbedded(1);
    expect(again.records[0]?.note).toEqual(record.note);
    const expected = storedVector(record.vector);
    again.records[0]?.vector.forEach((component, index) => {
      expect(component).toBeCloseTo(expected[index] ?? Number.NaN, 6);
    });
  });

  it("round-trips update times and leaves legacy records unbackfilled", async () => {
    const name = collection("update_time");
    const store = await openStore(name);
    const updatedAt = "2026-09-28T09:15:30.500+02:00";
    const current = embedded(
      { content: "A record with a known update time.", updatedAt },
      [1, 0, 0, 0],
    );
    const legacy = embedded(
      { content: "A record with an unknown update time." },
      [0, 1, 0, 0],
    );
    await store.put([current, legacy]);

    const reopened = await openStore(name);
    const found = await reopened.get([current.note.id, legacy.note.id]);
    expect(found.find((note) => note.id === current.note.id)).toEqual(
      current.note,
    );
    const legacyFound = found.find((note) => note.id === legacy.note.id);
    expect(legacyFound).toEqual(legacy.note);
    expect(legacyFound !== undefined && "updatedAt" in legacyFound).toBe(false);

    const exported = await reopened.pageEmbedded(50);
    expect(
      exported.records.find((entry) => entry.note.id === current.note.id)?.note,
    ).toEqual(current.note);
    const legacyExported = exported.records.find(
      (entry) => entry.note.id === legacy.note.id,
    );
    expect(legacyExported?.note).toEqual(legacy.note);
    expect(
      legacyExported !== undefined && "updatedAt" in legacyExported.note,
    ).toBe(false);

    // Opening and reading never backfill the legacy payload.
    const raw = await adminClient().scroll(name, {
      limit: 10,
      with_payload: true,
      with_vector: false,
    });
    const rawLegacy = raw.points.find((point) => point.id === legacy.note.id);
    expect(rawLegacy?.payload).toEqual(legacy.note);
  });

  it("fails the embedded export for a stored record without a vector", async () => {
    const name = collection("missing_vector");
    const store = await openStore(name);
    const record = embedded({ content: "A record with a missing vector." });
    await adminClient().upsert(name, {
      wait: true,
      points: [{ id: record.note.id, vector: {}, payload: record.note }],
    });

    // A vector-free read still returns the note; the explicit export must fail instead of
    // silently skipping the unusable record.
    expect(await store.get([record.note.id])).toEqual([record.note]);
    await expect(store.pageEmbedded(5)).rejects.toThrow(/vector/);
  });

  it("fails the embedded export for a stored zero-norm vector", async () => {
    const name = collection("zero_vector");
    const store = await openStore(name);
    const record = embedded({
      content: "A record without a usable direction.",
    });
    await adminClient().upsert(name, {
      wait: true,
      points: [
        { id: record.note.id, vector: [0, 0, 0, 0], payload: record.note },
      ],
    });

    expect((await store.page(5)).notes).toEqual([record.note]);
    await expect(store.pageEmbedded(5)).rejects.toThrow(/vector/);
  });

  it("rejects malformed stored payloads instead of manufacturing records", async () => {
    const name = collection("malformed");
    const store = await openStore(name);
    const readable = embedded();
    const disagreeing = embedded();
    const incomplete = embedded();
    const unknown = embedded();
    const stale = embedded();
    await adminClient().upsert(name, {
      wait: true,
      points: [
        { id: readable.note.id, vector: [1, 0, 0, 0], payload: readable.note },
        {
          id: disagreeing.note.id,
          vector: [0, 1, 0, 0],
          payload: { ...disagreeing.note, id: incomplete.note.id },
        },
        {
          id: incomplete.note.id,
          vector: [0, 0, 1, 0],
          payload: { id: incomplete.note.id, content: "No context." },
        },
        {
          id: unknown.note.id,
          vector: [0, 0, 0, 1],
          payload: { ...unknown.note, score: 0.5 },
        },
        {
          id: stale.note.id,
          vector: [0.5, 0.5, 0, 0],
          payload: { ...stale.note, updatedAt: "yesterday" },
        },
      ],
    });

    expect(await store.get([readable.note.id])).toEqual([readable.note]);
    await expect(store.get([disagreeing.note.id])).rejects.toThrow(
      /does not agree/,
    );
    await expect(store.get([incomplete.note.id])).rejects.toThrow(
      /complete note/,
    );
    await expect(store.get([unknown.note.id])).rejects.toThrow(/complete note/);
    await expect(store.get([stale.note.id])).rejects.toThrow(/complete note/);
    const malformedPayload = /complete note|does not agree/;
    await expect(store.nearest([1, 0, 0, 0], 4)).rejects.toThrow(
      malformedPayload,
    );
    await expect(store.page(4)).rejects.toThrow(malformedPayload);
    await expect(store.pageEmbedded(5)).rejects.toThrow(malformedPayload);
  });

  it("validates a whole write batch before dispatching it", async () => {
    const name = collection("batch");
    const store = await openStore(name);
    const duplicate = embedded();
    const other = note();
    const valid: EmbeddedNote = {
      note: {
        ...other,
        content: "A valid record after failed batches.",
      },
      vector: [1, 0, 0, 0],
    };

    await expect(
      store.put([duplicate, { ...duplicate, note: { ...duplicate.note } }]),
    ).rejects.toThrow(/more than once/);
    await expect(store.put([embedded({}, [1, 0, 0])])).rejects.toThrow(
      /dimensions/,
    );
    await expect(
      store.put([
        {
          note: { ...duplicate.note, context: "   " },
          vector: [1, 0, 0, 0],
        },
      ]),
    ).rejects.toThrow(/context/i);
    await expect(
      store.put([
        valid,
        {
          note: { ...duplicate.note, id: "not-a-uuid" },
          vector: [1, 0, 0, 0],
        },
      ]),
    ).rejects.toThrow();
    expect(await pointCount(name)).toBe(0);

    await store.put([valid]);

    expect(await pointCount(name)).toBe(1);
    expect(await store.get([valid.note.id])).toEqual([valid.note]);
  });

  it(
    "reaches a sentinel past 10,000 records with paging and direct reads",
    { timeout: 300_000 },
    async () => {
      const name = collection("large");
      const store = await openStore(name);
      const total = 10_050;
      const fillers = Array.from({ length: total - 1 }, (_, index) =>
        embedded(
          { id: orderedNoteId(index + 1), content: `Filler note ${index}.` },
          [0, 1, 0, 0],
        ),
      );
      const sentinel: EmbeddedNote = {
        note: note({
          id: SENTINEL_ID,
          content: "The sentinel past ten thousand records.",
        }),
        vector: [1, 0, 0, 0],
      };

      await store.put([...fillers, sentinel]);

      const seen = new Set<string>();
      let cursor: Cursor | undefined;
      let pages = 0;
      do {
        const page = await store.page(100, cursor);
        for (const found of page.notes) {
          expect(seen.has(found.id)).toBe(false);
          seen.add(found.id);
        }
        cursor = page.cursor;
        pages += 1;
      } while (cursor !== undefined);

      expect(pages).toBeGreaterThan(100);
      expect(seen.size).toBe(total);
      expect(seen.has(SENTINEL_ID)).toBe(true);
      expect(await store.get([SENTINEL_ID])).toEqual([sentinel.note]);
      expect((await store.nearest([1, 0, 0, 0], 5))[0]?.note.id).toBe(
        SENTINEL_ID,
      );

      // The explicit export also reaches the sentinel, with the actual stored vectors.
      const vectors = new Map<string, number[]>();
      let embeddedCursor: Cursor | undefined;
      do {
        const page = await store.pageEmbedded(1_000, embeddedCursor);
        for (const record of page.records) {
          expect(vectors.has(record.note.id)).toBe(false);
          vectors.set(record.note.id, record.vector);
        }
        embeddedCursor = page.cursor;
      } while (embeddedCursor !== undefined);

      expect(vectors.size).toBe(total);
      expect(vectors.get(SENTINEL_ID)).toEqual([1, 0, 0, 0]);
      expect(vectors.get(orderedNoteId(1))).toEqual([0, 1, 0, 0]);
    },
  );
});
