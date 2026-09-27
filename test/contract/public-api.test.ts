import { describe, expect, expectTypeOf, it } from "vitest";
import * as packageExports from "../../src/index.js";
import * as noteStore from "../../src/note-store/index.js";
import { noteSchema } from "../../src/note-store/index.js";
import type {
  AddInput,
  Embedder,
  EmbeddingSpace,
  LanguageModel,
  MemoryOptions,
  ModelRequest,
  Note,
  NoteStore,
  Page,
  SearchOptions,
  SearchResult,
} from "../../src/index.js";

/** docs/development.md#repository-layout-and-public-boundaries */

describe("package root exports", () => {
  it("re-exports the NoteStore contract through the same modules as its component index", () => {
    const exportedNames = [
      "attributesSchema",
      "cursorSchema",
      "embeddedNoteSchema",
      "jsonValueSchema",
      "matchSchema",
      "noteIdSchema",
      "noteSchema",
      "pageSchema",
    ] as const;

    expect(Object.keys(packageExports)).toEqual(
      expect.arrayContaining([...exportedNames]),
    );
    for (const name of exportedNames) {
      expect(packageExports[name]).toBe(noteStore[name]);
    }
  });

  it("keeps the documented contract types usable through the package root", () => {
    expectTypeOf<EmbeddingSpace>().toMatchTypeOf<{
      readonly id: string;
      readonly dimensions: number;
      readonly distance: "Cosine";
    }>();
    expectTypeOf<Embedder["embed"]>().returns.toEqualTypeOf<
      Promise<number[]>
    >();
    expectTypeOf<LanguageModel["generate"]>()
      .parameter(0)
      .toEqualTypeOf<ModelRequest>();
    expectTypeOf<ModelRequest["stage"]>().toEqualTypeOf<
      "construct" | "evolve"
    >();
    expectTypeOf<NoteStore["nearest"]>().parameter(1).toEqualTypeOf<number>();
    expectTypeOf<NoteStore["page"]>().returns.toEqualTypeOf<Promise<Page>>();
    expectTypeOf<AddInput["timestamp"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<MemoryOptions["neighbors"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<SearchOptions["linkedLimit"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<SearchResult>().toMatchTypeOf<
      { note: Note; via: "match"; score: number } | { note: Note; via: "link" }
    >();
  });

  it("uses note records that satisfy both the exported type and the runtime schema", () => {
    const note = {
      id: "b3c1d2e3-4f50-4610-8899-0a1b2c3d4e5f",
      content: "An observed result.",
      timestamp: "2026-09-27T15:44:27Z",
      context: "An observed result reported by a host.",
      keywords: ["result"],
      tags: ["observation"],
      links: [],
      metadata: { origin: "host", nested: { count: 1 } },
    } satisfies Note;
    const results: SearchResult[] = [
      { note, via: "match", score: 0.9 },
      { note, via: "link" },
    ];

    expect(noteSchema.safeParse(note).success).toBe(true);
    expect(results.map((result) => result.via)).toEqual(["match", "link"]);
  });
});
