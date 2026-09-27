/**
 * The environment a replay runs against: the supplied embedder and language model, the description
 * recorded in the manifest and a factory for the isolated collection of one representation.
 *
 * The deterministic demonstration uses the in-memory environment here; a live run supplies its own
 * environment over real Qdrant, the pinned encoder and a host model transport.
 *
 * See docs/evaluation.md#comparison-modes and docs/evaluation.md#run-artifacts.
 */
import {
  embeddedNoteSchema,
  noteIdSchema,
  vectorSchema,
  type Embedder,
  type EmbeddedNote,
  type JsonValue,
  type LanguageModel,
  type Match,
  type Note,
  type NoteStore,
  type NoteStoreSpace,
  type Page,
} from "../../src/index.js";
import type { ManifestModel } from "./artifacts.js";
import type { ExchangeLog } from "./recorder.js";

/** A store opened for one representation, with the name recorded in the run artifacts. */
export interface OpenedCollection {
  store: NoteStore;
  collection: string;
}

/** Encoder, model and storage identity recorded in the manifest. */
export interface EnvironmentDescription {
  encoder: { settings: Record<string, JsonValue> | null };
  model: ManifestModel;
  storage: {
    kind: "qdrant" | "in-memory";
    endpoint: string | null;
    schemaVersion: number;
  };
}

/**
 * Everything a replay needs from its host. The host owns provider lifecycle, so the runner never
 * disposes the environment.
 */
export interface EvaluationEnvironment {
  readonly embedder: Embedder;
  readonly model: LanguageModel;
  /** A provider exchange log, when the host records one for live evidence. */
  readonly exchanges: ExchangeLog | null;
  describe(): EnvironmentDescription;
  /** Open a fresh isolated collection for one representation identity. */
  openCollection(request: {
    representation: string;
    label: string;
  }): Promise<OpenedCollection>;
  dispose(): Promise<void>;
}

const positiveInteger = (value: number, description: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${description} must be a positive safe integer.`);
  }
  return value;
};

const cosine = (left: readonly number[], right: readonly number[]): number => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

/**
 * A deterministic in-memory NoteStore for the demonstration and the harness tests: current records
 * in insertion order, exact cosine ranking and index-based pagination. It is a consumer replacement
 * for the provider contract, not evidence about Qdrant behavior.
 */
export class InMemoryNoteStore implements NoteStore {
  readonly collection: string;
  readonly #space: NoteStoreSpace;
  readonly #records = new Map<string, EmbeddedNote>();

  constructor(collection: string, space: NoteStoreSpace) {
    this.collection = collection;
    this.#space = space;
  }

  /** The record the store currently holds, for assertions about an acknowledged write. */
  stored(id: string): EmbeddedNote | undefined {
    const record = this.#records.get(id.toLowerCase());
    return record === undefined ? undefined : structuredClone(record);
  }

  async put(records: EmbeddedNote[]): Promise<void> {
    const prepared = records.map((record) => {
      const parsed = embeddedNoteSchema.parse(record);
      if (parsed.vector.length !== this.#space.dimensions) {
        throw new Error(
          `A vector must have exactly ${this.#space.dimensions} dimensions.`,
        );
      }
      return parsed;
    });
    const identities = new Set<string>();
    for (const record of prepared) {
      const identity = record.note.id.toLowerCase();
      if (identities.has(identity)) {
        throw new Error(
          `A batch must not contain the note ID ${record.note.id} more than once.`,
        );
      }
      identities.add(identity);
    }
    for (const record of prepared) {
      this.#records.set(record.note.id.toLowerCase(), {
        note: structuredClone(record.note),
        vector: [...record.vector],
      });
    }
  }

  async get(ids: string[]): Promise<Note[]> {
    const found = new Map<string, Note>();
    for (const id of ids) {
      const parsed = noteIdSchema.safeParse(id);
      if (!parsed.success) {
        throw new Error(`Note identifiers must be UUIDs, received ${id}.`);
      }
      const identity = parsed.data.toLowerCase();
      const record = this.#records.get(identity);
      if (record !== undefined && !found.has(identity)) {
        found.set(identity, structuredClone(record.note));
      }
    }
    return [...found.values()];
  }

  async nearest(vector: number[], limit: number): Promise<Match[]> {
    const search = vectorSchema.parse(vector);
    if (search.length !== this.#space.dimensions) {
      throw new Error(
        `A vector must have exactly ${this.#space.dimensions} dimensions.`,
      );
    }
    const count = positiveInteger(limit, "A limit");
    return [...this.#records.values()]
      .map((record) => ({
        note: structuredClone(record.note),
        score: cosine(search, record.vector),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, count);
  }

  async page(limit: number, cursor?: string | number): Promise<Page> {
    const count = positiveInteger(limit, "A page limit");
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new Error("A cursor must be a nonnegative integer.");
    }
    const records = [...this.#records.values()];
    const notes = records
      .slice(start, start + count)
      .map((record) => structuredClone(record.note));
    const next = start + count;
    return next < records.length ? { notes, cursor: next } : { notes };
  }
}

/**
 * The deterministic environment: in-memory collections, the caller's embedder and model, and the
 * caller's manifest description. Each run gets fresh, isolated collections.
 */
export const createInMemoryEnvironment = (options: {
  embedder: Embedder;
  model: LanguageModel;
  exchangeLog?: ExchangeLog | null;
  encoderSettings?: Record<string, JsonValue> | null;
  modelDescription: ManifestModel;
}): EvaluationEnvironment => {
  const encoderSettings = options.encoderSettings ?? null;
  return {
    embedder: options.embedder,
    model: options.model,
    exchanges: options.exchangeLog ?? null,
    describe() {
      return {
        encoder: { settings: encoderSettings },
        model: options.modelDescription,
        storage: { kind: "in-memory", endpoint: null, schemaVersion: 1 },
      };
    },
    async openCollection(request) {
      const space: NoteStoreSpace = {
        id: options.embedder.space.id,
        dimensions: options.embedder.space.dimensions,
        distance: options.embedder.space.distance,
      };
      const collection = `memory:${request.label}:${request.representation}`;
      return {
        store: new InMemoryNoteStore(collection, space),
        collection,
      };
    },
    async dispose() {},
  };
};
