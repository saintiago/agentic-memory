import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgenticMemory,
  defaultPrompts,
  embeddingText,
  MemoryError,
  ModelResponseError,
  type AddInput,
  type Cursor,
  type Embedder,
  type EmbeddedNote,
  type EmbeddedPage,
  type JsonValue,
  type LanguageModel,
  type Match,
  type MemoryOptions,
  type ModelRequest,
  type Note,
  type NoteStore,
  type Page,
} from "../../src/index.js";

/**
 * Component tests for note insertion, linking and evolution through the public Memory contract,
 * with controlled NoteStore, Embedder and LanguageModel outputs. No network, filesystem or paid
 * model call is involved.
 *
 * See docs/memory.md#insertion-decisions and docs/testing.md#main-risks-and-ownership.
 */

const NOTE_TIMESTAMP = "2026-09-27T15:44:27.001+02:00";
const CANDIDATE_ID = "6f2bb0d4-1c1e-4a2b-8f43-1c9a3d4c5e02";
const OTHER_ID = "b1c2d3e4-f506-4a7b-8c9d-0e1f2a3b4c05";
/** A credential-shaped marker that public failure messages must never repeat. */
const CREDENTIAL_MARKER = "sk-live-CREDENTIAL-MARKER-0123456789";

/** The deterministic vector a text maps to in the controlled embedder. */
const vectorFor = (text: string): number[] => [text.length, 1, 0, 0];

const attributes = (
  context: string,
  keywords: string[],
  tags: string[],
): unknown => ({ context, keywords, tags });

/** The construction response most cases use, with the documented attribute shape. */
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

/** Capture one rejection so a failed promise cannot mask the assertion that follows. */
const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

/** An in-memory NoteStore that records the interactions Memory performs through the contract. */
class RecordingStore implements NoteStore {
  readonly records = new Map<string, EmbeddedNote>();
  readonly calls: string[] = [];
  readonly writes: EmbeddedNote[][] = [];
  putError: Error | undefined;
  nearestError: Error | undefined;
  /** Retain the references handed to `put`, as a replacement store is allowed to do. */
  retainWrites = false;
  #putGate: Deferred<void> | undefined;

  /** Hold the next put until the returned gate resolves, to observe write acknowledgment. */
  holdWrites(): Deferred<void> {
    const gate = deferred<void>();
    this.#putGate = gate;
    return gate;
  }

  seed(record: EmbeddedNote): Note {
    this.records.set(record.note.id.toLowerCase(), structuredClone(record));
    return record.note;
  }

  stored(id: string): Note | undefined {
    const record = this.records.get(id.toLowerCase());
    return record === undefined ? undefined : structuredClone(record.note);
  }

  storedVector(id: string): number[] | undefined {
    return this.records.get(id.toLowerCase())?.vector;
  }

  async put(records: EmbeddedNote[]): Promise<void> {
    this.calls.push("put");
    const gate = this.#putGate;
    if (this.putError !== undefined) {
      throw this.putError;
    }
    if (gate !== undefined) {
      this.#putGate = undefined;
      await gate.promise;
    }
    this.writes.push(structuredClone(records));
    for (const record of records) {
      this.records.set(
        record.note.id.toLowerCase(),
        this.retainWrites ? record : structuredClone(record),
      );
    }
  }

  async get(ids: string[]): Promise<Note[]> {
    this.calls.push("get");
    return ids.flatMap((id) => {
      const record = this.records.get(id.toLowerCase());
      return record === undefined ? [] : [structuredClone(record.note)];
    });
  }

  async nearest(vector: number[], limit: number): Promise<Match[]> {
    this.calls.push(`nearest:${limit}:${vector.length}`);
    if (this.nearestError !== undefined) {
      throw this.nearestError;
    }
    return [...this.records.values()]
      .slice(0, limit)
      .map((record) => ({ note: structuredClone(record.note), score: 1 }));
  }

  async page(limit: number): Promise<Page> {
    this.calls.push("page");
    return {
      notes: [...this.records.values()]
        .slice(0, limit)
        .map((record) => structuredClone(record.note)),
    };
  }

  async pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage> {
    this.calls.push(`pageEmbedded:${limit}:${String(cursor)}`);
    return {
      records: [...this.records.values()].slice(0, limit).map((record) => ({
        note: structuredClone(record.note),
        vector: [...record.vector],
      })),
    };
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
  source: (text: string) => number[] = vectorFor;

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

interface ScriptedStep {
  readonly stage: ModelRequest["stage"];
  readonly produce: () => unknown;
}

/** A LanguageModel that answers scripted steps in order and records every request. */
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
    if (step === undefined) {
      throw new Error(`Unexpected ${request.stage} request.`);
    }
    if (step.stage !== request.stage) {
      throw new Error(
        `The script expected a ${step.stage} request but received ${request.stage}.`,
      );
    }
    return await step.produce();
  }
}

const createMemory = (
  options?: MemoryOptions,
): {
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
    memory: new AgenticMemory(store, embedder, model, options),
  };
};

const expectMemoryError = (cause: unknown): MemoryError => {
  expect(cause).toBeInstanceOf(MemoryError);
  return cause as MemoryError;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("canonical representation", () => {
  it("produces the documented text with LF separators and no prefix or final newline", () => {
    expect(
      embeddingText({
        content: "Keep the source.",
        context: "Records the source.",
        keywords: ["first", "second"],
        tags: [],
      }),
    ).toBe(
      "Keep the source.\nKeywords: first, second\nTags: \nContext: Records the source.",
    );
  });

  it("excludes identity, timestamps, links and provenance from the represented text", () => {
    const represented = {
      content: "Keep the source.",
      context: "Records the source.",
      keywords: ["first"],
      tags: ["observation"],
    };
    const decorated: Note = {
      ...represented,
      id: CANDIDATE_ID,
      timestamp: NOTE_TIMESTAMP,
      updatedAt: "2026-09-28T09:15:30.500Z",
      links: [OTHER_ID],
      metadata: { origin: "host" },
    };

    expect(embeddingText(decorated)).toBe(embeddingText(represented));
  });
});

describe("add input validation", () => {
  const cyclicMetadata = (): Record<string, unknown> => {
    const metadata: Record<string, unknown> = { origin: "host" };
    metadata.self = metadata;
    return metadata;
  };

  it.each([
    ["a non-string content", () => ({ content: 42 })],
    ["empty content", () => ({ content: "" })],
    ["whitespace-only content", () => ({ content: " \n\t " })],
    [
      "a timestamp without a timezone",
      () => ({ content: "Text.", timestamp: "2026-09-27T15:44:27" }),
    ],
    [
      "a date-only timestamp",
      () => ({ content: "Text.", timestamp: "2026-09-27" }),
    ],
    [
      "a non-finite metadata number",
      () => ({ content: "Text.", metadata: { count: Number.NaN } }),
    ],
    [
      "a metadata cycle",
      () => ({ content: "Text.", metadata: cyclicMetadata() }),
    ],
    [
      "a non-JSON metadata value",
      () => ({ content: "Text.", metadata: { when: new Date() } }),
    ],
    [
      "a supplied update time",
      () => ({ content: "Text.", updatedAt: NOTE_TIMESTAMP }),
    ],
    ["an extra input field", () => ({ content: "Text.", id: CANDIDATE_ID })],
    ["a bare string input", () => "Text."],
  ])("rejects %s before any provider work", async (_description, build) => {
    const { store, embedder, model, memory } = createMemory();

    const error = expectMemoryError(
      await rejection(memory.add(build() as AddInput)),
    );

    expect(error.operation).toBe("add");
    expect(error.stage).toBe("input");
    expect(error.persistence).toBe("unchanged");
    expect(error.noteId).toBeUndefined();
    expect("noteId" in error).toBe(false);
    expect("affectedNoteIds" in error).toBe(false);
    expect(model.requests).toEqual([]);
    expect(embedder.texts).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it.each([
    [
      "an unexpected input key",
      () => ({ content: "Text.", [CREDENTIAL_MARKER]: "leaked" }),
    ],
    [
      "a metadata path",
      () => ({
        content: "Text.",
        metadata: { [CREDENTIAL_MARKER]: Number.NaN },
      }),
    ],
  ])(
    "keeps %s out of the public message and preserves the parse issues as the cause",
    async (_description, build) => {
      const { memory } = createMemory();

      const error = expectMemoryError(
        await rejection(memory.add(build() as AddInput)),
      );

      expect(error.message).toBe(
        "The add operation failed at the input stage: The input is not a valid add request.",
      );
      expect(error.message).not.toContain(CREDENTIAL_MARKER);
      const cause = error.cause as {
        issues: ReadonlyArray<{
          readonly path: ReadonlyArray<PropertyKey>;
          readonly message: string;
        }>;
      };
      expect(cause).toBeInstanceOf(Error);
      expect(cause.issues.length).toBeGreaterThan(0);
      const diagnostics = cause.issues
        .flatMap((issue) => [...issue.path.map(String), issue.message])
        .join("; ");
      expect(diagnostics).toContain(CREDENTIAL_MARKER);
    },
  );

  it("keeps accepted content exactly as supplied", async () => {
    const { store, model, memory } = createMemory();
    const content = "  Keep  the  supplied  spacing \n";
    model.queue("construct", () =>
      attributes("Records the source.", ["source"], ["observation"]),
    );

    const note = await memory.add({ content });

    expect(note.content).toBe(content);
    expect(store.stored(note.id)?.content).toBe(content);
    expect(model.requests[0]?.prompt).toContain(
      JSON.stringify({ content, timestamp: note.timestamp }),
    );
  });

  it("preserves own __proto__ metadata keys in a detached copy", async () => {
    const { store, model, memory } = createMemory();
    const metadata = JSON.parse(
      '{"__proto__":{"origin":"host"},"nested":{"__proto__":{"deep":true}}}',
    ) as Record<string, JsonValue>;
    model.queue("construct", () =>
      attributes("Records the source.", ["source"], ["observation"]),
    );

    const note = await memory.add({ content: "The source text.", metadata });
    metadata.nested = "mutated after the call";

    const storedMetadata = store.stored(note.id)?.metadata ?? {};
    expect(Object.getOwnPropertyNames(storedMetadata)).toEqual([
      "__proto__",
      "nested",
    ]);
    expect(Object.getPrototypeOf(storedMetadata)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyNames(storedMetadata["nested"] as object),
    ).toEqual(["__proto__"]);
  });

  it.each([
    ["a zero neighbor limit", { neighbors: 0 }],
    ["a negative neighbor limit", { neighbors: -1 }],
    ["a fractional neighbor limit", { neighbors: 1.5 }],
    ["an unsafe neighbor limit", { neighbors: Number.MAX_SAFE_INTEGER + 1 }],
    ["an empty construction prompt", { prompts: { construction: "" } }],
    ["an empty evolution prompt", { prompts: { evolution: "" } }],
    ["an unknown option", { prompt: { construction: "Describe it." } }],
  ])("rejects %s at construction", (_description, options) => {
    expect(() => createMemory(options as MemoryOptions)).toThrow();
  });
});

describe("identity and timestamp", () => {
  it("allocates a fresh identity for identical content and stores both notes", async () => {
    const { store, model, memory } = createMemory();
    model.queue("construct", () =>
      attributes("Records the source.", ["source"], ["observation"]),
    );
    model.queue("construct", () =>
      attributes("Records the source.", ["source"], ["observation"]),
    );
    model.queue("evolve", () => ({
      links: [],
      newTags: ["observation"],
      updates: [],
    }));

    const first = await memory.add({ content: "The same source text." });
    const second = await memory.add({ content: "The same source text." });

    expect(first.id).not.toBe(second.id);
    expect(store.records.size).toBe(2);
    expect(store.stored(first.id)).toEqual(first);
    expect(store.stored(second.id)).toEqual(second);
  });

  it("preserves a supplied timestamp verbatim", async () => {
    const { model, memory } = createMemory();
    model.queue("construct", () =>
      attributes("Records the source.", ["source"], ["observation"]),
    );

    const note = await memory.add({
      content: "The source text.",
      timestamp: NOTE_TIMESTAMP,
    });

    expect(note.timestamp).toBe(NOTE_TIMESTAMP);
  });

  it("resolves an omitted timestamp when the queued insertion starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T15:00:00.000Z"));
    const { model, memory } = createMemory();
    const gate = deferred<void>();
    model.queue("construct", async () => {
      await gate.promise;
      return attributes("Records the first source.", ["source"], ["first"]);
    });
    model.queue("construct", () =>
      attributes("Records the second source.", ["source"], ["second"]),
    );
    model.queue("evolve", () => ({
      links: [],
      newTags: ["second"],
      updates: [],
    }));

    const first = memory.add({ content: "The first source." });
    await flush();
    vi.setSystemTime(new Date("2026-09-27T15:00:05.000Z"));
    const second = memory.add({ content: "The second source." });
    gate.resolve();

    expect((await first).timestamp).toBe("2026-09-27T15:00:00.000Z");
    expect((await second).timestamp).toBe("2026-09-27T15:00:05.000Z");
  });
});

describe("update time", () => {
  it("records one batch preparation time on the insertion and each changed neighbor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T09:00:00.000Z"));
    const { store, model, memory } = createMemory();
    model.queue("construct", () =>
      attributes("Records the first source.", ["source"], ["first"]),
    );

    const first = await memory.add({ content: "The first source." });

    expect(first.updatedAt).toBe("2026-09-28T09:00:00.000Z");

    const changed = store.seed({
      note: candidate({ content: "A changed neighbor." }),
      vector: [1, 0, 0, 0],
    });
    const untouched = store.seed({
      note: candidate({
        id: OTHER_ID,
        content: "An unchanged neighbor.",
        updatedAt: "2026-09-20T08:00:00.000Z",
      }),
      vector: [0, 1, 0, 0],
    });
    expect("updatedAt" in changed).toBe(false);
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => {
      vi.setSystemTime(new Date("2026-09-28T09:05:00.000Z"));
      return {
        links: [changed.id],
        newTags: ["incoming"],
        updates: [
          {
            id: changed.id,
            context: "The changed neighbor now supports the incoming account.",
            keywords: ["observation"],
            tags: ["history"],
          },
          {
            id: untouched.id,
            context: untouched.context,
            keywords: untouched.keywords,
            tags: untouched.tags,
          },
        ],
      };
    });

    const second = await memory.add({
      content: "The incoming account.",
      timestamp: NOTE_TIMESTAMP,
    });

    // The observation timestamp and the runtime update time stay distinct, and both records of
    // the batch carry the same preparation time.
    expect(second.timestamp).toBe(NOTE_TIMESTAMP);
    expect(second.updatedAt).toBe("2026-09-28T09:05:00.000Z");
    expect(store.stored(changed.id)).toEqual({
      ...changed,
      context: "The changed neighbor now supports the incoming account.",
      updatedAt: "2026-09-28T09:05:00.000Z",
    });
    expect(store.stored(untouched.id)).toEqual(untouched);
    expect(store.stored(second.id)?.updatedAt).toBe(second.updatedAt);
  });

  it("never advances the update time through reads and does not invent one for a rejected write", async () => {
    const { store, model, memory } = createMemory();
    const storedAt = "2026-09-27T08:00:00.000Z";
    const current = store.seed({
      note: candidate({ updatedAt: storedAt }),
      vector: [1, 0, 0, 0],
    });
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => ({
      links: [current.id],
      newTags: ["incoming"],
      updates: [
        {
          id: current.id,
          context: "A revised context.",
          keywords: ["observation"],
          tags: ["history"],
        },
      ],
    }));
    const failure = new Error("the connection was reset");
    store.putError = failure;

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("persist");
    expect(error.persistence).toBe("uncertain");
    expect(store.stored(current.id)).toEqual(current);
    expect((await memory.get(current.id))?.updatedAt).toBe(storedAt);
    expect((await memory.page(10)).notes[0]?.updatedAt).toBe(storedAt);
    const results = await memory.search("a query", { linkedLimit: 0 });
    expect(results[0]?.note.updatedAt).toBe(storedAt);
    expect(store.stored(current.id)?.updatedAt).toBe(storedAt);
    expect(store.calls.some((call) => call.startsWith("pageEmbedded"))).toBe(
      false,
    );
  });

  it("keeps the update time out of the embedded text and the model instructions", async () => {
    const { store, embedder, model, memory } = createMemory();
    const storedAt = "2026-09-27T08:00:00.000Z";
    const current = store.seed({
      note: candidate({ updatedAt: storedAt }),
      vector: [1, 0, 0, 0],
    });
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => ({
      links: [current.id],
      newTags: ["incoming"],
      updates: [],
    }));

    const incoming = await memory.add({
      content: "The incoming account.",
      timestamp: NOTE_TIMESTAMP,
    });
    const preparedAt = incoming.updatedAt;
    if (preparedAt === undefined) {
      throw new Error("an insertion must record an update time.");
    }

    for (const request of model.requests) {
      expect(request.prompt).not.toContain(storedAt);
      expect(request.prompt).not.toContain(preparedAt);
    }
    expect(embedder.texts.length).toBeGreaterThan(0);
    for (const text of embedder.texts) {
      expect(text).not.toContain(storedAt);
      expect(text).not.toContain(preparedAt);
    }
    // A neighbor without a real change keeps its persisted update time.
    expect(store.stored(current.id)?.updatedAt).toBe(storedAt);
  });
});

describe("insertion decisions", () => {
  it("skips evolution when no candidates exist", async () => {
    const { store, model, memory } = createMemory();
    model.queue("construct", () =>
      attributes("Records the source.", ["source"], ["observation"]),
    );

    const note = await memory.add({ content: "The first stored source." });

    expect(model.requests.map((request) => request.stage)).toEqual([
      "construct",
    ]);
    expect(store.calls).toEqual(["nearest:5:4", "put"]);
    expect(note.links).toEqual([]);
    expect(store.writes).toEqual([
      [{ note, vector: vectorFor(embeddingText(note)) }],
    ]);
  });

  it("links to a supplied candidate and evolves it in one acknowledged batch", async () => {
    const { store, embedder, model, memory } = createMemory();
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    const revised = {
      context: "The earlier observation now supports the revised account.",
      keywords: ["observation", "revision"],
      tags: ["history", "revision"],
    };
    model.queue("construct", () =>
      attributes("Records the incoming account.", ["account"], ["incoming"]),
    );
    model.queue("evolve", () => ({
      links: [current.id],
      newTags: ["observation", "revision"],
      updates: [{ id: current.id, ...revised }],
    }));

    const note = await memory.add({
      content: "The incoming account.",
      timestamp: NOTE_TIMESTAMP,
      metadata: { origin: "host", nested: { count: 1 } },
    });

    expect(note.links).toEqual([current.id]);
    expect(note.tags).toEqual(["observation", "revision"]);
    expect(note.context).toBe("Records the incoming account.");
    expect(note.keywords).toEqual(["account"]);
    expect(note.content).toBe("The incoming account.");
    expect(note.timestamp).toBe(NOTE_TIMESTAMP);
    expect(note.metadata).toEqual({ origin: "host", nested: { count: 1 } });

    const storedCurrent = store.stored(current.id);
    // Both records of the batch carry the same preparation time.
    expect(storedCurrent).toEqual({
      ...current,
      ...revised,
      updatedAt: note.updatedAt,
    });
    expect(store.stored(note.id)).toEqual(note);

    expect(store.writes).toHaveLength(1);
    const batch = store.writes[0] ?? [];
    expect(batch.map((record) => record.note.id)).toEqual([
      current.id,
      note.id,
    ]);
    expect(store.storedVector(note.id)).toEqual(vectorFor(embeddingText(note)));
    expect(store.storedVector(current.id)).toEqual(
      vectorFor(embeddingText({ ...current, ...revised })),
    );
    expect(embedder.texts).toEqual([
      embeddingText({ ...note, tags: ["incoming"] }),
      embeddingText({ ...current, ...revised }),
      embeddingText(note),
    ]);
    expect(model.requests.map((request) => request.stage)).toEqual([
      "construct",
      "evolve",
    ]);
  });

  it("omits an unchanged neighbor proposal and reuses the incoming vector", async () => {
    const { store, embedder, model, memory } = createMemory();
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    model.queue("construct", () =>
      attributes("Records the incoming account.", ["account"], ["incoming"]),
    );
    model.queue("evolve", () => ({
      links: [],
      newTags: ["incoming"],
      updates: [
        {
          id: current.id,
          context: current.context,
          keywords: current.keywords,
          tags: current.tags,
        },
      ],
    }));

    const note = await memory.add({ content: "The incoming account." });

    expect(embedder.texts).toEqual([embeddingText(note)]);
    expect(store.writes).toEqual([
      [{ note, vector: vectorFor(embeddingText(note)) }],
    ]);
  });

  it("re-embeds a neighbor whose tags alone changed", async () => {
    const { store, embedder, model, memory } = createMemory();
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    const revised: Note = {
      ...current,
      tags: ["history", "revision"],
    };
    model.queue("construct", () =>
      attributes("Records the incoming account.", ["account"], ["incoming"]),
    );
    model.queue("evolve", () => ({
      links: [],
      newTags: ["incoming"],
      updates: [
        {
          id: current.id,
          context: current.context,
          keywords: current.keywords,
          tags: revised.tags,
        },
      ],
    }));

    const note = await memory.add({ content: "The incoming account." });

    expect(embedder.texts).toEqual([
      embeddingText(note),
      embeddingText(revised),
    ]);
    expect(store.stored(current.id)).toEqual({
      ...revised,
      updatedAt: note.updatedAt,
    });
    expect(store.storedVector(current.id)).toEqual(
      vectorFor(embeddingText(revised)),
    );
    expect((store.writes[0] ?? []).map((record) => record.note.id)).toEqual([
      current.id,
      note.id,
    ]);
  });

  it("needs no additional embedding for a link-only change", async () => {
    const { store, embedder, model, memory } = createMemory();
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    model.queue("construct", () =>
      attributes("Records the incoming account.", ["account"], ["incoming"]),
    );
    model.queue("evolve", () => ({
      links: [current.id],
      newTags: ["incoming"],
      updates: [],
    }));

    const note = await memory.add({ content: "The incoming account." });

    expect(note.links).toEqual([current.id]);
    expect(embedder.texts).toEqual([embeddingText(note)]);
    expect(store.writes).toEqual([
      [{ note, vector: vectorFor(embeddingText(note)) }],
    ]);
  });

  it("links only to supplied candidates, not to other stored notes", async () => {
    const { store, model, memory } = createMemory({ neighbors: 1 });
    store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    const outside = store.seed({
      note: candidate({ id: OTHER_ID, content: "An unrelated stored note." }),
      vector: [0, 1, 0, 0],
    });
    model.queue("construct", () =>
      attributes("Records the incoming account.", ["account"], ["incoming"]),
    );
    model.queue("evolve", () => ({
      links: [outside.id],
      newTags: ["incoming"],
      updates: [],
    }));

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("evolve");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBeInstanceOf(ModelResponseError);
    expect(store.calls).toEqual(["nearest:1:4"]);
    expect(store.writes).toEqual([]);
  });

  it("rejects repeated update IDs before any write", async () => {
    const { store, model, memory } = createMemory();
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    model.queue("construct", () =>
      attributes("Records the incoming account.", ["account"], ["incoming"]),
    );
    model.queue("evolve", () => ({
      links: [],
      newTags: ["incoming"],
      updates: [
        { id: current.id, context: "First revision.", keywords: [], tags: [] },
        { id: current.id, context: "Second revision.", keywords: [], tags: [] },
      ],
    }));

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("evolve");
    expect(error.persistence).toBe("unchanged");
    expect(store.writes).toEqual([]);
    expect(store.stored(current.id)).toEqual(current);
  });

  it("fails the whole evolution response before preparing any sibling", async () => {
    const { store, embedder, model, memory } = createMemory();
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    model.queue("construct", () =>
      attributes("Records the incoming account.", ["account"], ["incoming"]),
    );
    model.queue("evolve", () => ({
      links: [],
      newTags: ["incoming"],
      updates: [
        {
          id: current.id,
          context: "A valid revision.",
          keywords: [],
          tags: [],
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          context: "An unknown candidate.",
          keywords: [],
          tags: [],
        },
      ],
    }));

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("evolve");
    expect(embedder.texts).toHaveLength(1);
    expect(store.writes).toEqual([]);
    expect(store.stored(current.id)).toEqual(current);
  });
});

describe("returned records", () => {
  it("detaches a constructed note from the record handed to the store", async () => {
    const { store, model, memory } = createMemory();
    store.retainWrites = true;
    model.queue("construct", () =>
      attributes("Records the source.", ["source"], ["observation"]),
    );

    const note = await memory.add({
      content: "The source text.",
      metadata: { origin: "host" },
    });
    (note.metadata as { origin: string }).origin = "mutated";
    note.context = "Rewritten through the returned note.";
    note.keywords.push("appended");

    expect(store.stored(note.id)).toEqual({
      id: note.id,
      content: "The source text.",
      timestamp: note.timestamp,
      context: "Records the source.",
      keywords: ["source"],
      tags: ["observation"],
      links: [],
      metadata: { origin: "host" },
      updatedAt: note.updatedAt,
    });
  });

  it("detaches an evolved note from the record handed to the store", async () => {
    const { store, model, memory } = createMemory();
    store.retainWrites = true;
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    model.queue("construct", () =>
      attributes("Records the incoming account.", ["account"], ["incoming"]),
    );
    model.queue("evolve", () => ({
      links: [current.id],
      newTags: ["observation", "revision"],
      updates: [],
    }));

    const note = await memory.add({ content: "The incoming account." });
    note.links.push(OTHER_ID);
    note.tags.length = 0;

    const stored = store.stored(note.id);
    expect(stored?.links).toEqual([current.id]);
    expect(stored?.tags).toEqual(["observation", "revision"]);
  });
});

describe("failure outcomes", () => {
  it("reports a construction response that does not match the contract", async () => {
    const { store, embedder, model, memory } = createMemory();
    model.queue("construct", () => ({ context: "Only a context." }));

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("construct");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBeInstanceOf(ModelResponseError);
    expect(error.noteId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect("affectedNoteIds" in error).toBe(false);
    expect(embedder.texts).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it("keeps an untrusted construction response out of the public message", async () => {
    const { embedder, model, memory } = createMemory();
    model.queue("construct", () => ({
      ...(CONSTRUCTED() as Record<string, unknown>),
      [CREDENTIAL_MARKER]: "leaked",
    }));

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("construct");
    expect(error.message).toBe(
      `The add operation failed at the construct stage for note ${error.noteId}: ` +
        "The construction response does not satisfy the documented contract.",
    );
    expect(error.message).not.toContain(CREDENTIAL_MARKER);
    expect(error.cause).toBeInstanceOf(ModelResponseError);
    // Detailed diagnostics stay available on the cause.
    expect((error.cause as Error).message).toContain(CREDENTIAL_MARKER);
    expect(embedder.texts).toEqual([]);
  });

  it.each([
    [
      "an extra top-level field",
      (candidateId: string) => ({
        links: [candidateId],
        newTags: ["incoming"],
        updates: [],
        [CREDENTIAL_MARKER]: "leaked",
      }),
    ],
    [
      "an extra nested update field",
      (candidateId: string) => ({
        links: [],
        newTags: ["incoming"],
        updates: [
          {
            id: candidateId,
            context: "A revised context.",
            keywords: ["observation"],
            tags: ["history"],
            [CREDENTIAL_MARKER]: "leaked",
          },
        ],
      }),
    ],
  ])(
    "keeps an untrusted evolution response (%s) out of the public message",
    async (_description, build) => {
      const { store, model, memory } = createMemory();
      const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
      model.queue("construct", CONSTRUCTED);
      model.queue("evolve", () => build(current.id));

      const error = expectMemoryError(
        await rejection(memory.add({ content: "The incoming account." })),
      );

      expect(error.stage).toBe("evolve");
      expect(error.message).toBe(
        `The add operation failed at the evolve stage for note ${error.noteId}: ` +
          "The evolution response does not satisfy the documented contract.",
      );
      expect(error.message).not.toContain(CREDENTIAL_MARKER);
      expect(error.cause).toBeInstanceOf(ModelResponseError);
      expect((error.cause as Error).message).toContain(CREDENTIAL_MARKER);
      expect(store.writes).toEqual([]);
    },
  );

  it("reports a construction transport failure with its cause", async () => {
    const { model, memory } = createMemory();
    const failure = new Error("the provider rejected the request");
    model.queue("construct", () => {
      throw failure;
    });

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("construct");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
    expect(error.message).not.toContain("The incoming account.");
  });

  it("reports an evolution transport failure with its cause", async () => {
    const { store, model, memory } = createMemory();
    store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    const failure = new Error("the provider timed out");
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => {
      throw failure;
    });

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("evolve");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
    expect(store.writes).toEqual([]);
  });

  it("reports an embedding failure before the candidate search", async () => {
    const { store, embedder, model, memory } = createMemory();
    const failure = new Error("the encoder runtime is unavailable");
    embedder.failNext = failure;
    model.queue("construct", CONSTRUCTED);

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("embed");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
    expect(store.calls).toEqual([]);
  });

  it("reports an unusable embedder vector before the write attempt", async () => {
    const { store, embedder, model, memory } = createMemory();
    embedder.source = () => [0, 0, 0, 0];
    model.queue("construct", CONSTRUCTED);

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("embed");
    expect(error.persistence).toBe("unchanged");
    expect(error.message).toContain("4-dimensional");
    expect(store.calls).toEqual([]);
  });

  it("reports a failed final embedding before the batch write", async () => {
    const { store, model, memory, embedder } = createMemory();
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    const failure = new Error("the encoder runtime is unavailable");
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => {
      embedder.failNext = failure;
      return {
        links: [current.id],
        newTags: ["incoming", "revision"],
        updates: [],
      };
    });

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("embed");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
    expect(store.calls).toEqual(["nearest:5:4"]);
    expect(store.writes).toEqual([]);
  });

  it("reports a failed neighbor re-embedding before the batch write", async () => {
    const { store, model, memory, embedder } = createMemory();
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    const failure = new Error("the encoder runtime is unavailable");
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => {
      embedder.failNext = failure;
      return {
        links: [],
        newTags: ["incoming"],
        updates: [
          {
            id: current.id,
            context: "A revised context.",
            keywords: ["observation"],
            tags: ["history"],
          },
        ],
      };
    });

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("embed");
    expect(error.persistence).toBe("unchanged");
    expect(store.writes).toEqual([]);
    expect(store.stored(current.id)).toEqual(current);
  });

  it("reports candidate selection failures", async () => {
    const { store, model, memory } = createMemory();
    const failure = new Error("the search request failed");
    store.nearestError = failure;
    model.queue("construct", CONSTRUCTED);

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("candidates");
    expect(error.persistence).toBe("unchanged");
    expect(error.cause).toBe(failure);
    expect(store.writes).toEqual([]);
  });

  it("reports a rejected batch write as uncertain with the prepared batch", async () => {
    const { store, model, memory } = createMemory();
    const current = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    const failure = new Error("the connection was reset");
    store.putError = failure;
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => ({
      links: [current.id],
      newTags: ["incoming"],
      updates: [
        {
          id: current.id,
          context: "A revised context.",
          keywords: ["observation"],
          tags: ["history"],
        },
      ],
    }));

    const error = expectMemoryError(
      await rejection(memory.add({ content: "The incoming account." })),
    );

    expect(error.stage).toBe("persist");
    expect(error.persistence).toBe("uncertain");
    expect(error.noteId).toBeDefined();
    expect(error.affectedNoteIds).toEqual([current.id, error.noteId]);
    expect(error.cause).toBe(failure);
    expect(store.stored(current.id)).toEqual(current);
  });
});

describe("queue serialization", () => {
  it("does not select candidates while an earlier insertion is pending", async () => {
    const { store, model, memory } = createMemory();
    const gate = deferred<void>();
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", async () => {
      await gate.promise;
      return { links: [], newTags: ["incoming"], updates: [] };
    });
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => ({
      links: [],
      newTags: ["incoming"],
      updates: [],
    }));
    store.seed({ note: candidate(), vector: [1, 0, 0, 0] });

    const first = memory.add({ content: "The first incoming account." });
    const second = memory.add({ content: "The second incoming account." });
    await flush();

    expect(store.calls).toEqual(["nearest:5:4"]);
    expect(model.requests.map((request) => request.stage)).toEqual([
      "construct",
      "evolve",
    ]);

    gate.resolve();
    await first;
    await second;

    expect(store.calls).toEqual(["nearest:5:4", "put", "nearest:5:4", "put"]);
  });

  it("continues with later insertions after a rejected one", async () => {
    const { store, model, memory } = createMemory();
    model.queue("construct", () => {
      throw new Error("the provider is unavailable");
    });
    model.queue("construct", CONSTRUCTED);

    const failure = rejection(memory.add({ content: "The rejected account." }));
    const accepted = memory.add({ content: "The accepted account." });

    expectMemoryError(await failure);
    const note = await accepted;
    expect(store.records.size).toBe(1);
    expect(store.stored(note.id)).toEqual(note);
  });

  it("copies pending input so a caller mutation cannot change it", async () => {
    const { store, model, memory } = createMemory();
    const gate = deferred<void>();
    model.queue("construct", async () => {
      await gate.promise;
      return CONSTRUCTED();
    });
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => ({
      links: [],
      newTags: ["incoming"],
      updates: [],
    }));
    const metadata = { origin: "host", nested: { count: 1 } };

    const first = memory.add({ content: "The first account.", metadata });
    const second = memory.add({ content: "The second account." });
    metadata.origin = "mutated";
    metadata.nested.count = 99;
    gate.resolve();

    const firstNote = await first;
    await second;

    expect(store.stored(firstNote.id)?.metadata).toEqual({
      origin: "host",
      nested: { count: 1 },
    });
  });

  it("returns the final note only after the batch write is acknowledged", async () => {
    const { store, model, memory } = createMemory();
    const gate = store.holdWrites();
    model.queue("construct", CONSTRUCTED);

    const operation = memory.add({ content: "The incoming account." });
    let settled: Note | undefined;
    void operation.then((note) => {
      settled = note;
    });
    await flush();

    expect(store.calls).toEqual(["nearest:5:4", "put"]);
    expect(settled).toBeUndefined();

    gate.resolve();
    const note = await operation;

    expect(settled).toEqual(note);
    expect(store.stored(note.id)).toEqual(note);
  });

  it("uses configured prompts and copies them at construction", async () => {
    const prompts = {
      construction: "Describe the memory for later retrieval.",
      evolution: "Relate the memory to its neighbors.",
    };
    const construction = prompts.construction;
    const evolution = prompts.evolution;
    const { store, model, memory } = createMemory({ prompts });
    store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => ({
      links: [],
      newTags: ["incoming"],
      updates: [],
    }));
    prompts.construction = "Mutated after construction.";
    prompts.evolution = "Mutated after construction.";

    await memory.add({ content: "The incoming account." });

    expect(model.requests[0]?.prompt.startsWith(`${construction}\n\n`)).toBe(
      true,
    );
    expect(model.requests[0]?.prompt).toContain("End of source material.");
    expect(model.requests[1]?.prompt.startsWith(`${evolution}\n\n`)).toBe(true);
    expect(model.requests[1]?.prompt).toContain("End of memory data.");
  });

  it("uses the documented default prompts when none are configured", async () => {
    const { model, memory } = createMemory();
    model.queue("construct", CONSTRUCTED);

    await memory.add({ content: "The incoming account." });

    expect(
      model.requests[0]?.prompt.startsWith(
        `${defaultPrompts.construction}\n\n`,
      ),
    ).toBe(true);
  });
});
