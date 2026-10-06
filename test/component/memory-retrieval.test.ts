import { describe, expect, it } from "vitest";

import {
  AgenticMemory,
  MemoryError,
  type Cursor,
  type Embedder,
  type EmbeddedNote,
  type EmbeddedPage,
  type LanguageModel,
  type Match,
  type ModelRequest,
  type Note,
  type NoteStore,
  type Page,
  type SearchOptions,
} from "../../src/index.js";

/**
 * Component tests for retrieval and inspection through the public Memory contract, with controlled
 * NoteStore, Embedder and LanguageModel outcomes. No network, filesystem or paid model call is
 * involved.
 *
 * See docs/memory.md#retrieval-and-inspection and docs/testing.md#main-risks-and-ownership.
 */

const NOTE_TIMESTAMP = "2026-09-27T15:44:27.001+02:00";
const MATCH_ONE = "11111111-1111-4111-8111-111111111111";
const MATCH_TWO = "22222222-2222-4222-8222-222222222222";
const LINK_ONE = "33333333-3333-4333-8333-333333333333";
const LINK_TWO = "44444444-4444-4444-8444-444444444444";
const LINK_THREE = "55555555-5555-4555-8555-555555555555";
const MISSING_ID = "66666666-6666-4666-8666-666666666666";

/** A deterministic UUID so cases can build larger corpora without random identities. */
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

const note = (id: string, links: string[] = []): Note => ({
  id,
  content: `Source material for ${id}.`,
  timestamp: NOTE_TIMESTAMP,
  context: `Records source material for ${id}.`,
  keywords: ["source"],
  tags: ["observation"],
  links,
});

/** Capture one rejection so a failed promise cannot mask the assertion that follows. */
const captureFailure = async (
  promise: Promise<unknown>,
): Promise<MemoryError> => {
  const cause = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(cause).toBeInstanceOf(MemoryError);
  return cause as MemoryError;
};

/** An in-memory NoteStore that records the reads Memory performs through the contract. */
class ScriptedStore implements NoteStore {
  readonly calls: string[] = [];
  readonly records = new Map<string, Note>();
  readonly fetched: string[][] = [];
  readonly puts: EmbeddedNote[][] = [];
  nearestResults: Match[] = [];
  getResults: Note[] | undefined;
  pageResult: Page = { notes: [] };
  getError: Error | undefined;
  nearestError: Error | undefined;
  pageError: Error | undefined;

  seed(...notes: Note[]): void {
    for (const stored of notes) {
      this.records.set(stored.id.toLowerCase(), stored);
    }
  }

  async put(records: EmbeddedNote[]): Promise<void> {
    this.calls.push("put");
    this.puts.push(structuredClone(records));
  }

  async get(ids: string[]): Promise<Note[]> {
    this.calls.push("get");
    this.fetched.push([...ids]);
    if (this.getError !== undefined) {
      throw this.getError;
    }
    if (this.getResults !== undefined) {
      return this.getResults;
    }
    return ids.flatMap((id) => {
      const stored = this.records.get(id.toLowerCase());
      return stored === undefined ? [] : [stored];
    });
  }

  /** Retrieval cases never read vectors; a vector-bearing read would be a scripting error. */
  async getEmbedded(): Promise<EmbeddedNote[]> {
    this.calls.push("getEmbedded");
    throw new Error("The retrieval script has no vector-bearing read.");
  }

  async nearest(vector: number[], limit: number): Promise<Match[]> {
    this.calls.push(`nearest:${limit}:${vector.length}`);
    if (this.nearestError !== undefined) {
      throw this.nearestError;
    }
    return this.nearestResults;
  }

  async page(limit: number, cursor?: Cursor): Promise<Page> {
    this.calls.push(`page:${limit}:${String(cursor)}`);
    if (this.pageError !== undefined) {
      throw this.pageError;
    }
    return this.pageResult;
  }

  /**
   * The vector-inspection operation of the NoteStore contract. Memory retrieval never calls it;
   * the recorded call makes that observable.
   */
  async pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage> {
    this.calls.push(`pageEmbedded:${limit}:${String(cursor)}`);
    return { records: [] };
  }
}

/** A deterministic embedder whose output a case can replace or fail. */
class ControlledEmbedder implements Embedder {
  readonly space = {
    id: "amem-test-space",
    dimensions: 4,
    distance: "Cosine",
  } as const;
  readonly texts: string[] = [];
  failNext: Error | undefined;
  source: (text: string) => number[] = (text) => [text.length, 1, 0, 0];

  async embed(text: string): Promise<number[]> {
    this.texts.push(text);
    const failure = this.failNext;
    if (failure !== undefined) {
      this.failNext = undefined;
      throw failure;
    }
    return this.source(text);
  }
}

/** A LanguageModel that never succeeds: retrieval must not invoke one. */
class UnusedModel implements LanguageModel {
  readonly requests: ModelRequest[] = [];

  async generate(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    throw new Error("retrieval must not call the language model");
  }
}

const createMemory = (): {
  store: ScriptedStore;
  embedder: ControlledEmbedder;
  model: UnusedModel;
  memory: AgenticMemory;
} => {
  const store = new ScriptedStore();
  const embedder = new ControlledEmbedder();
  const model = new UnusedModel();
  return {
    store,
    embedder,
    model,
    memory: new AgenticMemory(store, embedder, model),
  };
};

describe("search", () => {
  it("keeps ranked direct matches and appends one-hop links in stored order", async () => {
    const { store, memory } = createMemory();
    const first = note(LINK_TWO);
    const second = note(LINK_ONE);
    store.seed(first, second);
    store.nearestResults = [
      { note: note(MATCH_ONE, [LINK_TWO, LINK_ONE]), score: 0.9 },
      { note: note(MATCH_TWO), score: 0.4 },
    ];
    // The store makes no ordering promise for identity reads; results follow the selection order.
    store.getResults = [second, first];

    const results = await memory.search("a query", {
      limit: 2,
      linkedLimit: 2,
    });

    expect(store.calls).toEqual(["nearest:2:4", "get"]);
    expect(store.fetched).toEqual([[LINK_TWO, LINK_ONE]]);
    expect(results).toEqual([
      {
        note: note(MATCH_ONE, [LINK_TWO, LINK_ONE]),
        via: "match",
        score: 0.9,
      },
      { note: note(MATCH_TWO), via: "match", score: 0.4 },
      { note: first, via: "link" },
      { note: second, via: "link" },
    ]);
  });

  it("skips direct matches and never follows a link of a linked addition", async () => {
    const { store, memory } = createMemory();
    store.seed(note(LINK_ONE, [LINK_THREE]), note(LINK_THREE));
    store.nearestResults = [
      { note: note(MATCH_ONE, [MATCH_TWO, LINK_ONE]), score: 1 },
      { note: note(MATCH_TWO), score: 0.5 },
    ];

    const results = await memory.search("a query");

    expect(store.fetched).toEqual([[LINK_ONE]]);
    expect(results.map((result) => [result.via, result.note.id])).toEqual([
      ["match", MATCH_ONE],
      ["match", MATCH_TWO],
      ["link", LINK_ONE],
    ]);
  });

  it("deduplicates targets case-insensitively across matches", async () => {
    const { store, memory } = createMemory();
    store.seed(note(LINK_ONE));
    store.nearestResults = [
      { note: note(MATCH_ONE, [LINK_ONE.toUpperCase()]), score: 0.9 },
      {
        note: note(MATCH_TWO, [
          LINK_ONE.toLowerCase(),
          MATCH_ONE.toUpperCase(),
        ]),
        score: 0.8,
      },
    ];

    const results = await memory.search("a query");

    expect(store.fetched).toEqual([[LINK_ONE.toUpperCase()]]);
    expect(results.map((result) => result.note.id)).toEqual([
      MATCH_ONE,
      MATCH_TWO,
      LINK_ONE,
    ]);
  });

  it("stops at the linked budget and does not replace a missing target", async () => {
    const { store, memory } = createMemory();
    store.seed(note(LINK_ONE), note(LINK_TWO));
    store.nearestResults = [
      { note: note(MATCH_ONE, [MISSING_ID, LINK_ONE, LINK_TWO]), score: 1 },
    ];

    const results = await memory.search("a query", { linkedLimit: 2 });

    expect(store.fetched).toEqual([[MISSING_ID, LINK_ONE]]);
    expect(results.map((result) => [result.via, result.note.id])).toEqual([
      ["match", MATCH_ONE],
      ["link", LINK_ONE],
    ]);
  });

  it("defaults to five direct matches and five linked additions", async () => {
    const { store, memory } = createMemory();
    const targets = [1, 2, 3, 4, 5].map((value) => uuid(100 + value));
    store.seed(...targets.map((id) => note(id)));
    store.nearestResults = [1, 2, 3, 4, 5].map((value, index) => ({
      note: note(uuid(value), [uuid(100 + value)]),
      score: 1 - index * 0.1,
    }));

    const results = await memory.search("a query");

    expect(store.calls).toEqual(["nearest:5:4", "get"]);
    expect(store.fetched).toEqual([targets]);
    expect(results.map((result) => result.via)).toEqual([
      "match",
      "match",
      "match",
      "match",
      "match",
      "link",
      "link",
      "link",
      "link",
      "link",
    ]);
  });

  it("disables linked expansion when the linked limit is zero", async () => {
    const { store, memory } = createMemory();
    store.seed(note(LINK_ONE));
    store.nearestResults = [{ note: note(MATCH_ONE, [LINK_ONE]), score: 1 }];

    const results = await memory.search("a query", { linkedLimit: 0 });

    expect(store.calls).toEqual(["nearest:5:4"]);
    expect(results).toEqual([
      { note: note(MATCH_ONE, [LINK_ONE]), via: "match", score: 1 },
    ]);
  });

  it("returns no results and fetches nothing when nothing matches", async () => {
    const { store, memory } = createMemory();

    expect(await memory.search("a query")).toEqual([]);
    expect(store.calls).toEqual(["nearest:5:4"]);
  });

  it("embeds the query as supplied, including surrounding whitespace", async () => {
    const { embedder, memory } = createMemory();
    const query = "  spaced   query  ";

    await memory.search(query);

    expect(embedder.texts).toEqual([query]);
  });

  const invalidSearchCases: ReadonlyArray<
    [string, (memory: AgenticMemory) => Promise<unknown>]
  > = [
    ["an empty query", (memory) => memory.search("")],
    ["a whitespace-only query", (memory) => memory.search(" \n\t ")],
    ["a non-string query", (memory) => memory.search(42 as unknown as string)],
    ["a zero direct limit", (memory) => memory.search("query", { limit: 0 })],
    [
      "a fractional direct limit",
      (memory) => memory.search("query", { limit: 1.5 }),
    ],
    [
      "an unsafe direct limit",
      (memory) =>
        memory.search("query", { limit: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    [
      "a negative linked limit",
      (memory) => memory.search("query", { linkedLimit: -1 }),
    ],
    [
      "a fractional linked limit",
      (memory) => memory.search("query", { linkedLimit: 0.5 }),
    ],
    [
      "an unknown option",
      (memory) =>
        memory.search("query", {
          prompt: "ignored",
        } as unknown as SearchOptions),
    ],
    [
      "a non-object option",
      (memory) => memory.search("query", "wide" as unknown as SearchOptions),
    ],
  ];

  it.each(invalidSearchCases)(
    "rejects %s before any provider call",
    async (_description, run) => {
      const { store, embedder, model, memory } = createMemory();

      const error = await captureFailure(run(memory));

      expect(error.operation).toBe("search");
      expect(error.stage).toBe("input");
      expect(error.persistence).toBe("unchanged");
      expect(model.requests).toEqual([]);
      expect(embedder.texts).toEqual([]);
      expect(store.calls).toEqual([]);
    },
  );
});

describe("retrieval failures", () => {
  it("reports an embedding failure before the direct match call", async () => {
    const { store, embedder, memory } = createMemory();
    const failure = new Error("the encoder runtime is unavailable");
    embedder.failNext = failure;

    const error = await captureFailure(memory.search("a query"));

    expect(error.operation).toBe("search");
    expect(error.stage).toBe("embed");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
    expect(store.calls).toEqual([]);
  });

  it("reports a query vector that violates the declared space", async () => {
    const { store, embedder, memory } = createMemory();
    embedder.source = () => [0, 0, 0, 0];

    const error = await captureFailure(memory.search("a query"));

    expect(error.stage).toBe("embed");
    expect(error.persistence).toBe("unchanged");
    expect(error.message).toContain("4-dimensional");
    expect(store.calls).toEqual([]);
  });

  it("reports a failed direct match call", async () => {
    const { store, memory } = createMemory();
    const failure = new Error("the search request failed");
    store.nearestError = failure;

    const error = await captureFailure(memory.search("a query"));

    expect(error.stage).toBe("candidates");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
  });

  it("reports a failed linked-note fetch as an operation error", async () => {
    const { store, memory } = createMemory();
    const failure = new Error("the retrieve request failed");
    store.getError = failure;
    store.nearestResults = [{ note: note(MATCH_ONE, [LINK_ONE]), score: 1 }];

    const error = await captureFailure(memory.search("a query"));

    expect(error.operation).toBe("search");
    expect(error.stage).toBe("read");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
  });
});

describe("get", () => {
  it("returns the current note or undefined for a missing one", async () => {
    const { store, memory } = createMemory();
    store.seed(note(MATCH_ONE));

    expect(await memory.get(MATCH_ONE)).toEqual(note(MATCH_ONE));
    expect(await memory.get(LINK_ONE)).toBeUndefined();
    expect(store.calls).toEqual(["get", "get"]);
  });

  it("accepts an identity spelled with different case", async () => {
    const { store, memory } = createMemory();
    store.seed(note(MATCH_ONE));

    expect(await memory.get(MATCH_ONE.toUpperCase())).toEqual(note(MATCH_ONE));
  });

  it("rejects an invalid identity before the store call", async () => {
    const { store, memory } = createMemory();

    const error = await captureFailure(memory.get("note-1"));
    expect(error.operation).toBe("get");
    expect(error.stage).toBe("input");
    expect(error.persistence).toBe("unchanged");
    await captureFailure(memory.get(7 as unknown as string));
    expect(store.calls).toEqual([]);
  });

  it("reports a failed note read", async () => {
    const { store, memory } = createMemory();
    const failure = new Error("the retrieve request failed");
    store.getError = failure;

    const error = await captureFailure(memory.get(MATCH_ONE));

    expect(error.operation).toBe("get");
    expect(error.stage).toBe("read");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
  });
});

describe("page", () => {
  it("defaults to 100 notes and forwards an opaque cursor unchanged", async () => {
    const { store, memory } = createMemory();
    const page: Page = { notes: [note(MATCH_ONE)], cursor: "next-page" };
    store.pageResult = page;

    expect(await memory.page()).toEqual(page);
    expect(await memory.page(25, 7)).toEqual(page);
    expect(store.calls).toEqual(["page:100:undefined", "page:25:7"]);
  });

  const invalidPageCases: ReadonlyArray<
    [string, (memory: AgenticMemory) => Promise<unknown>]
  > = [
    ["a zero limit", (memory) => memory.page(0)],
    ["a negative limit", (memory) => memory.page(-1)],
    ["a fractional limit", (memory) => memory.page(1.5)],
    ["an unsafe limit", (memory) => memory.page(Number.MAX_SAFE_INTEGER + 1)],
    ["a non-number limit", (memory) => memory.page("10" as unknown as number)],
    ["an object cursor", (memory) => memory.page(10, {} as Cursor)],
    [
      "a boolean cursor",
      (memory) => memory.page(10, true as unknown as Cursor),
    ],
    ["a null cursor", (memory) => memory.page(10, null as unknown as Cursor)],
  ];

  it.each(invalidPageCases)(
    "rejects %s before the store call",
    async (_description, run) => {
      const { store, memory } = createMemory();

      const error = await captureFailure(run(memory));

      expect(error.operation).toBe("page");
      expect(error.stage).toBe("input");
      expect(error.persistence).toBe("unchanged");
      expect(store.calls).toEqual([]);
    },
  );

  it("reports a failed page read", async () => {
    const { store, memory } = createMemory();
    const failure = new Error("the scroll request failed");
    store.pageError = failure;

    const error = await captureFailure(memory.page());

    expect(error.operation).toBe("page");
    expect(error.stage).toBe("read");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
  });
});

describe("detached records", () => {
  /** A stored note whose nested metadata and arrays a shared reference would expose. */
  const storedNote = (id: string, links: string[] = []): Note => ({
    ...note(id, links),
    metadata: { origin: { sources: ["stored"] } },
  });

  /** Mutate every container of a read result, so a shared reference changes the store. */
  const mutateEveryField = (value: Note): void => {
    value.content = "rewritten through the read result";
    value.context = "Rewritten through the read result.";
    value.keywords.push("appended");
    value.tags.length = 0;
    value.links.push(LINK_TWO);
    const metadata = value.metadata as { origin: { sources: string[] } };
    metadata.origin.sources.push("mutated");
  };

  const required = (value: Note | undefined): Note => {
    if (value === undefined) {
      throw new Error("the stored note must be readable");
    }
    return value;
  };

  it("returns a detached note from get", async () => {
    const { store, memory } = createMemory();
    const stored = storedNote(MATCH_ONE, [LINK_ONE]);
    store.seed(stored);

    const returned = required(await memory.get(MATCH_ONE));
    expect(returned).toEqual(stored);
    expect(returned).not.toBe(stored);

    mutateEveryField(returned);

    expect(await memory.get(MATCH_ONE)).toEqual(stored);
    expect(store.records.get(MATCH_ONE.toLowerCase())).toEqual(stored);
  });

  it("returns a detached page of notes", async () => {
    const { store, memory } = createMemory();
    const stored = storedNote(MATCH_ONE);
    const page: Page = { notes: [stored], cursor: "next-page" };
    store.pageResult = page;

    const returned = await memory.page(10, "cursor");
    expect(returned).toEqual(page);
    expect(returned).not.toBe(page);
    expect(returned.notes).not.toBe(page.notes);
    expect(returned.notes[0]).not.toBe(stored);

    mutateEveryField(required(returned.notes[0]));

    expect(await memory.page(10, "cursor")).toEqual(page);
    expect(store.pageResult).toEqual(page);
  });

  it("returns detached direct matches", async () => {
    const { store, memory } = createMemory();
    const stored = storedNote(MATCH_ONE, [LINK_ONE]);
    store.nearestResults = [{ note: stored, score: 0.75 }];

    const results = await memory.search("a query", { linkedLimit: 0 });
    expect(results).toEqual([{ note: stored, via: "match", score: 0.75 }]);
    expect(results[0]?.note).not.toBe(stored);

    mutateEveryField(required(results[0]?.note));

    expect(await memory.search("a query", { linkedLimit: 0 })).toEqual([
      { note: stored, via: "match", score: 0.75 },
    ]);
    expect(store.nearestResults[0]?.note).toEqual(stored);
  });

  it("returns detached linked additions", async () => {
    const { store, memory } = createMemory();
    const stored = storedNote(LINK_ONE);
    store.seed(stored);
    store.nearestResults = [{ note: note(MATCH_ONE, [LINK_ONE]), score: 1 }];

    const results = await memory.search("a query");
    const addition = results.find((result) => result.via === "link");
    expect(addition?.note).not.toBe(stored);

    mutateEveryField(required(addition?.note));

    expect(await memory.get(LINK_ONE)).toEqual(stored);
    expect(store.records.get(LINK_ONE.toLowerCase())).toEqual(stored);
  });
});

describe("read-only guarantees", () => {
  it("returns the persisted update time unchanged and never requests stored vectors", async () => {
    const { store, model, memory } = createMemory();
    const updatedAt = "2026-09-27T08:00:00.000Z";
    const stored = note(MATCH_ONE);
    stored.updatedAt = updatedAt;
    store.seed(stored);
    store.pageResult = { notes: [stored] };
    store.nearestResults = [{ note: stored, score: 0.9 }];

    expect((await memory.get(MATCH_ONE))?.updatedAt).toBe(updatedAt);
    expect((await memory.page(10))?.notes[0]?.updatedAt).toBe(updatedAt);
    const results = await memory.search("a query", { linkedLimit: 0 });
    expect(results[0]?.note.updatedAt).toBe(updatedAt);

    expect(store.calls.some((call) => call.startsWith("pageEmbedded"))).toBe(
      false,
    );
    expect(model.requests).toEqual([]);
  });

  it("never invokes the language model or writes during retrieval", async () => {
    const { store, model, memory } = createMemory();
    store.seed(note(LINK_ONE));
    store.nearestResults = [{ note: note(MATCH_ONE, [LINK_ONE]), score: 1 }];

    await memory.search("a query");
    await memory.get(MATCH_ONE);
    await memory.page();

    expect(model.requests).toEqual([]);
    expect(store.puts).toEqual([]);
    expect(store.calls).toEqual([
      "nearest:5:4",
      "get",
      "get",
      "page:100:undefined",
    ]);
  });
});
