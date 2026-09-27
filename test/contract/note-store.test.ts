import { describe, expect, it } from "vitest";
import {
  embeddedNoteSchema,
  jsonValueSchema,
  matchSchema,
  noteIdSchema,
  noteSchema,
  pageSchema,
} from "../../src/note-store/index.js";

/** docs/note-store.md#record-validation */

const noteId = "b3c1d2e3-4f50-4610-8899-0a1b2c3d4e5f";
const otherId = "1a2b3c4d-5e6f-4708-9a0b-c1d2e3f40516";
const thirdId = "9f8e7d6c-5b4a-4321-8765-0fedcba98765";

/** Objects and arrays that contain themselves are not JSON. */
const cyclicMetadata: Record<string, unknown> = {};
cyclicMetadata.self = cyclicMetadata;
const cyclicList: unknown[] = [];
cyclicList.push(cyclicList);

const validNote = {
  id: noteId,
  content: "Removing a stale queue entry requires an operator approval.",
  timestamp: "2026-09-27T15:44:27.001+02:00",
  context: "Records the approval requirement for removing stale queue entries.",
  keywords: ["queue entry", "approval"],
  tags: ["operations", "policy"],
  links: [otherId],
};

describe("note records", () => {
  it("accepts a complete note and preserves its strings and array order", () => {
    const note = {
      ...validNote,
      content: "  Keep  spacing  ",
      keywords: ["b", "a", "B"],
    };

    expect(noteSchema.parse(note)).toEqual(note);
  });

  it("accepts empty keyword and tag arrays and omitted metadata", () => {
    expect(
      noteSchema.safeParse({ ...validNote, keywords: [], tags: [] }).success,
    ).toBe(true);
    expect(noteSchema.safeParse({ ...validNote, links: [] }).success).toBe(
      true,
    );
  });

  it("accepts JSON metadata including nested objects, arrays and null", () => {
    const metadata = {
      nested: { list: [1, 2.5, null, true, "text"] },
      empty: {},
    };

    expect(noteSchema.parse({ ...validNote, metadata }).metadata).toEqual(
      metadata,
    );
  });

  it("compares link identity case-insensitively and preserves supplied spellings", () => {
    const links = [otherId.toUpperCase(), thirdId];

    expect(noteSchema.parse({ ...validNote, links }).links).toEqual(links);
  });

  it("accepts metadata that shares an acyclic value and preserves own __proto__ keys", () => {
    const shared = { origin: "host" };
    const metadata = JSON.parse(
      '{"__proto__":{"source":"host"},"nested":{"__proto__":{"deep":true}}}',
    ) as Record<string, unknown>;
    metadata.first = shared;
    metadata.second = shared;

    const { metadata: parsed } = noteSchema.parse({ ...validNote, metadata });

    expect(JSON.parse(JSON.stringify(parsed))).toEqual(metadata);
    expect(Object.getOwnPropertyNames(parsed)).toContain("__proto__");
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  const invalidNotes: Array<{
    description: string;
    value: unknown;
    message?: string;
  }> = [
    { description: "a missing id", value: { ...validNote, id: undefined } },
    { description: "a non-UUID id", value: { ...validNote, id: "note-1" } },
    {
      description: "whitespace-only content",
      value: { ...validNote, content: " \n\t " },
    },
    {
      description: "an empty content string",
      value: { ...validNote, content: "" },
    },
    {
      description: "whitespace-only context",
      value: { ...validNote, context: "  " },
    },
    {
      description: "an empty keyword",
      value: { ...validNote, keywords: ["queue", ""] },
    },
    { description: "an empty tag", value: { ...validNote, tags: [""] } },
    {
      description: "a non-array keywords value",
      value: { ...validNote, keywords: "queue" },
    },
    {
      description: "a non-UUID link",
      value: { ...validNote, links: ["other-note"] },
    },
    {
      description: "a self link",
      value: { ...validNote, links: [noteId] },
      message: "A note must not link to itself.",
    },
    {
      description: "a self link spelled in another case",
      value: { ...validNote, links: [noteId.toUpperCase()] },
      message: "A note must not link to itself.",
    },
    {
      description: "duplicate links",
      value: { ...validNote, links: [otherId, thirdId, otherId] },
      message: "Links must be distinct.",
    },
    {
      description: "duplicate links that differ only in case",
      value: { ...validNote, links: [otherId, otherId.toUpperCase()] },
      message: "Links must be distinct.",
    },
    {
      description: "a timestamp without a timezone",
      value: { ...validNote, timestamp: "2026-09-27T15:44:27" },
    },
    {
      description: "a non-ISO timestamp",
      value: { ...validNote, timestamp: "27/09/2026 15:44" },
    },
    {
      description: "an array metadata value",
      value: { ...validNote, metadata: [{ id: noteId }] },
    },
    {
      description: "a non-finite metadata number",
      value: { ...validNote, metadata: { score: Infinity } },
    },
    {
      description: "a nested non-finite metadata number",
      value: { ...validNote, metadata: { nested: [NaN] } },
    },
    {
      description: "an undefined metadata value",
      value: { ...validNote, metadata: { note: undefined } },
    },
    {
      description: "metadata with an object cycle",
      value: { ...validNote, metadata: cyclicMetadata },
      message: "JSON values must not contain cycles.",
    },
    {
      description: "metadata with an array cycle",
      value: { ...validNote, metadata: { list: cyclicList } },
      message: "JSON values must not contain cycles.",
    },
    {
      description: "a function metadata value",
      value: { ...validNote, metadata: { helper: () => 1 } },
    },
    { description: "an unknown field", value: { ...validNote, score: 0.5 } },
    {
      description: "a missing context",
      value: { ...validNote, context: undefined },
    },
  ];

  it.each(invalidNotes)("rejects $description", ({ value, message }) => {
    const result = noteSchema.safeParse(value);

    expect(result.success).toBe(false);
    if (message !== undefined) {
      expect(result.error?.issues[0]?.message).toBe(message);
    }
  });
});

describe("note identifiers", () => {
  it("accepts a UUID and rejects other text", () => {
    expect(noteIdSchema.safeParse(noteId).success).toBe(true);
    expect(
      noteIdSchema.safeParse("b3c1d2e3-4f50-4610-8899-0a1b2c3d4e5").success,
    ).toBe(false);
    expect(noteIdSchema.safeParse("").success).toBe(false);
  });
});

describe("embedded notes", () => {
  it("accepts a note with a finite vector", () => {
    expect(
      embeddedNoteSchema.parse({ note: validNote, vector: [1, -0.5, 0] })
        .vector,
    ).toEqual([1, -0.5, 0]);
  });

  it.each([
    { description: "NaN", vector: [1, Number.NaN] },
    { description: "Infinity", vector: [Number.POSITIVE_INFINITY] },
    { description: "non-numbers", vector: ["1", 2] },
    { description: "no components", vector: [] },
    { description: "only zero components", vector: [0, 0] },
  ])("rejects a vector containing $description", ({ vector }) => {
    expect(
      embeddedNoteSchema.safeParse({ note: validNote, vector }).success,
    ).toBe(false);
  });

  it("rejects a vector whose norm is zero", () => {
    const result = embeddedNoteSchema.safeParse({
      note: validNote,
      vector: [0, 0],
    });

    expect(result.error?.issues[0]?.message).toBe(
      "A vector must have nonzero norm.",
    );
  });

  it("rejects a record that is not a note/vector pair", () => {
    expect(
      embeddedNoteSchema.safeParse({
        note: validNote,
        vector: [1],
        extra: true,
      }).success,
    ).toBe(false);
    expect(embeddedNoteSchema.safeParse({ note: validNote }).success).toBe(
      false,
    );
  });
});

describe("matches", () => {
  it("accepts a finite score and rejects non-finite scores", () => {
    expect(
      matchSchema.safeParse({ note: validNote, score: 0.93 }).success,
    ).toBe(true);
    expect(
      matchSchema.safeParse({ note: validNote, score: Number.NaN }).success,
    ).toBe(false);
    expect(
      matchSchema.safeParse({
        note: validNote,
        score: Number.NEGATIVE_INFINITY,
      }).success,
    ).toBe(false);
  });
});

describe("pages", () => {
  it("accepts a page without a cursor and with string or numeric cursors", () => {
    expect(pageSchema.parse({ notes: [validNote] })).toEqual({
      notes: [validNote],
    });
    expect(
      pageSchema.safeParse({ notes: [], cursor: "opaque-cursor" }).success,
    ).toBe(true);
    expect(pageSchema.safeParse({ notes: [], cursor: 42 }).success).toBe(true);
  });

  it("rejects a null cursor and unknown fields", () => {
    expect(pageSchema.safeParse({ notes: [], cursor: null }).success).toBe(
      false,
    );
    expect(pageSchema.safeParse({ notes: [], total: 1 }).success).toBe(false);
  });
});

describe("JSON values", () => {
  it("accepts nested JSON and rejects values JSON cannot carry", () => {
    expect(
      jsonValueSchema.safeParse({ a: [1, "b", null, { c: false }] }).success,
    ).toBe(true);
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(
      jsonValueSchema.safeParse(new Date("2026-09-27T00:00:00Z")).success,
    ).toBe(false);
  });

  it("rejects cycles through objects and arrays but keeps shared values valid", () => {
    const shared = { origin: "host" };
    const input = { first: shared, second: shared, list: [shared] };
    const parsed = jsonValueSchema.parse(input) as {
      first: unknown;
      second: unknown;
    };

    expect(jsonValueSchema.safeParse(cyclicMetadata).success).toBe(false);
    expect(jsonValueSchema.safeParse(cyclicList).success).toBe(false);
    expect(
      jsonValueSchema.safeParse({ nested: [{ cycle: cyclicMetadata }] })
        .success,
    ).toBe(false);
    expect(parsed).toEqual(input);
    expect(parsed.first).not.toBe(shared);
  });
});

describe("note-bearing records", () => {
  it("rejects a case-variant self link or cyclic metadata in every schema", () => {
    const selfLinked = { ...validNote, links: [noteId.toUpperCase()] };
    const cyclic = { ...validNote, metadata: cyclicMetadata };

    for (const note of [selfLinked, cyclic]) {
      expect(embeddedNoteSchema.safeParse({ note, vector: [1] }).success).toBe(
        false,
      );
      expect(matchSchema.safeParse({ note, score: 0.9 }).success).toBe(false);
      expect(pageSchema.safeParse({ notes: [note] }).success).toBe(false);
    }
  });
});
