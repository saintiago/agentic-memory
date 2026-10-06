/**
 * A Qdrant collection for comparison baselines: same note payloads as the runtime store, but a
 * distinct declared representation, so a raw-content or constructed collection is never mistaken
 * for an `amem-note-v1` runtime collection.
 *
 * See docs/evaluation.md#comparison-modes and docs/note-store.md#collection-compatibility.
 */
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";

import {
  cursorSchema,
  embeddedNoteSchema,
  noteIdSchema,
  noteSchema,
  vectorSchema,
  type Cursor,
  type EmbeddedNote,
  type EmbeddedPage,
  type Match,
  type Note,
  type NoteStore,
  type NoteStoreSpace,
  type Page,
} from "../../src/index.js";

/** The collection metadata key evaluation baselines use; the runtime key stays untouched. */
export const evaluationMetadataKey = "agenticMemoryEvaluation";
const schemaVersion = 1;
const vectorDatatype = "float32";

const spaceSchema: z.ZodType<NoteStoreSpace> = z.strictObject({
  id: z.string().min(1, "An embedding-space ID must be nonempty."),
  dimensions: z.int().positive("Dimensions must be a positive integer."),
  distance: z.literal("Cosine"),
});

const optionsSchema = z.strictObject({
  url: z
    .string()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
      message: "A Qdrant URL must start with http:// or https://.",
    })
    .refine(
      (url) =>
        URL.canParse(url) &&
        (() => {
          const endpoint = new URL(url);
          return (
            endpoint.username === "" &&
            endpoint.password === "" &&
            !/[?#]/.test(url) &&
            endpoint.port !== "0"
          );
        })(),
      "A Qdrant URL must be valid, use a nonzero port, and contain no credentials, query or fragment.",
    ),
  apiKey: z.string().min(1, "An API key must be nonempty.").optional(),
  collection: z.string().min(1, "A collection name must be nonempty."),
  representation: z
    .string()
    .min(1, "A baseline representation must be nonempty."),
  space: spaceSchema,
  timeoutMs: z
    .int()
    .positive("A timeout must be a positive integer.")
    .optional(),
});

/** Settings of one evaluation baseline collection. */
export type EvaluationBaselineOptions = z.infer<typeof optionsSchema>;

/** Raised when an existing collection is not the evaluation baseline this run requires. */
export class EvaluationBaselineCompatibilityError extends Error {
  readonly collection: string;

  constructor(collection: string, reason: string) {
    super(
      `Qdrant collection "${collection}" is not a compatible evaluation baseline: ${reason}.`,
    );
    this.name = "EvaluationBaselineCompatibilityError";
    this.collection = collection;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertCompatible = (
  collection: string,
  info: Awaited<ReturnType<QdrantClient["getCollection"]>>,
  expected: { representation: string; space: NoteStoreSpace },
): void => {
  const vectors = isObject(info.config.params.vectors)
    ? info.config.params.vectors
    : undefined;
  const size = vectors?.["size"];
  const distance = vectors?.["distance"];
  const datatype = vectors?.["datatype"];
  if (
    size !== expected.space.dimensions ||
    distance !== expected.space.distance ||
    (datatype !== undefined && datatype !== vectorDatatype)
  ) {
    throw new EvaluationBaselineCompatibilityError(
      collection,
      `its vector configuration is not ${String(expected.space.dimensions)} dimensions with ` +
        `${expected.space.distance} distance and ${vectorDatatype} storage`,
    );
  }
  const metadata = info.config.metadata;
  const declared = isObject(metadata)
    ? metadata[evaluationMetadataKey]
    : undefined;
  if (!isObject(declared)) {
    throw new EvaluationBaselineCompatibilityError(
      collection,
      `its collection metadata key "${evaluationMetadataKey}" is missing`,
    );
  }
  if (
    declared["schemaVersion"] !== schemaVersion ||
    declared["representation"] !== expected.representation
  ) {
    throw new EvaluationBaselineCompatibilityError(
      collection,
      `it declares ${JSON.stringify(declared["representation"])} schema version ` +
        `${JSON.stringify(declared["schemaVersion"])} instead of ` +
        `"${expected.representation}" schema version ${String(schemaVersion)}`,
    );
  }
  const space = declared["embeddingSpace"];
  if (
    !isObject(space) ||
    space["id"] !== expected.space.id ||
    space["dimensions"] !== expected.space.dimensions ||
    space["distance"] !== expected.space.distance
  ) {
    throw new EvaluationBaselineCompatibilityError(
      collection,
      `its declared embedding space ${JSON.stringify(space)} does not match ` +
        `${JSON.stringify(expected.space)}`,
    );
  }
};

const ensureCollection = async (
  client: QdrantClient,
  collection: string,
  representation: string,
  space: NoteStoreSpace,
): Promise<void> => {
  const existing = await client.collectionExists(collection);
  if (!existing.exists) {
    try {
      await client.createCollection(collection, {
        vectors: {
          size: space.dimensions,
          distance: space.distance,
          datatype: vectorDatatype,
        },
        metadata: {
          [evaluationMetadataKey]: {
            schemaVersion,
            representation,
            embeddingSpace: {
              id: space.id,
              dimensions: space.dimensions,
              distance: space.distance,
            },
          },
        },
      });
    } catch (error) {
      const raced = await client.collectionExists(collection);
      if (!raced.exists) {
        throw error;
      }
    }
  }
  assertCompatible(collection, await client.getCollection(collection), {
    representation,
    space,
  });
};

const parseLimit = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("A limit must be a positive safe integer.");
  }
  return limit;
};

const parseVector = (vector: unknown, dimensions: number): number[] => {
  const parsed = vectorSchema.parse(vector);
  if (parsed.length !== dimensions) {
    throw new Error(`A vector must have exactly ${dimensions} dimensions.`);
  }
  return parsed;
};

/** Current baseline records held by one compatible Qdrant collection. */
class EvaluationBaselineStore implements NoteStore {
  readonly #client: QdrantClient;
  readonly #collection: string;
  readonly #dimensions: number;

  constructor(client: QdrantClient, collection: string, dimensions: number) {
    this.#client = client;
    this.#collection = collection;
    this.#dimensions = dimensions;
  }

  async put(records: EmbeddedNote[]): Promise<void> {
    const prepared = records.map((record) => {
      const parsed = embeddedNoteSchema.parse(record);
      parseVector(parsed.vector, this.#dimensions);
      return parsed;
    });
    if (prepared.length === 0) {
      return;
    }
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
    await this.#client.upsert(this.#collection, {
      wait: true,
      points: prepared.map(({ note, vector }) => ({
        id: note.id,
        vector,
        payload: note,
      })),
    });
  }

  async get(ids: string[]): Promise<Note[]> {
    if (ids.length === 0) {
      return [];
    }
    const requested = new Map<string, string>();
    for (const id of ids) {
      const parsed = noteIdSchema.safeParse(id);
      if (!parsed.success) {
        throw new Error(`Note identifiers must be UUIDs, received ${id}.`);
      }
      requested.set(parsed.data.toLowerCase(), parsed.data);
    }
    const records = await this.#client.retrieve(this.#collection, {
      ids: [...requested.values()],
      with_payload: true,
      with_vector: false,
    });
    const found = new Map<string, Note>();
    for (const record of records) {
      const note = this.#readNote(record.id, record.payload);
      found.set(note.id.toLowerCase(), note);
    }
    return [...found.values()];
  }

  async getEmbedded(ids: string[]): Promise<EmbeddedNote[]> {
    if (ids.length === 0) {
      return [];
    }
    const requested = new Map<string, string>();
    for (const id of ids) {
      const parsed = noteIdSchema.safeParse(id);
      if (!parsed.success) {
        throw new Error(`Note identifiers must be UUIDs, received ${id}.`);
      }
      requested.set(parsed.data.toLowerCase(), parsed.data);
    }
    const records = await this.#client.retrieve(this.#collection, {
      ids: [...requested.values()],
      with_payload: true,
      with_vector: true,
    });
    const found = new Map<string, EmbeddedNote>();
    for (const record of records) {
      const note = this.#readNote(record.id, record.payload);
      const parsed = vectorSchema.safeParse(record.vector);
      if (!parsed.success || parsed.data.length !== this.#dimensions) {
        throw new Error(
          `Stored vector for point ${String(record.id)} is missing or does not match the ` +
            `declared ${this.#dimensions}-dimensional embedding space.`,
        );
      }
      const identity = note.id.toLowerCase();
      if (!found.has(identity)) {
        found.set(identity, { note, vector: parsed.data });
      }
    }
    return [...found.values()];
  }

  async nearest(vector: number[], limit: number): Promise<Match[]> {
    const response = await this.#client.query(this.#collection, {
      query: parseVector(vector, this.#dimensions),
      limit: parseLimit(limit),
      with_payload: true,
      with_vector: false,
    });
    return response.points
      .map((point) => ({
        note: this.#readNote(point.id, point.payload),
        score: point.score,
      }))
      .sort((left, right) => right.score - left.score);
  }

  async page(limit: number, cursor?: Cursor): Promise<Page> {
    const offset =
      cursor === undefined ? undefined : cursorSchema.parse(cursor);
    const response = await this.#client.scroll(this.#collection, {
      limit: parseLimit(limit),
      with_payload: true,
      with_vector: false,
      ...(offset === undefined ? {} : { offset }),
    });
    const notes = response.points.map((point) =>
      this.#readNote(point.id, point.payload),
    );
    const next = response.next_page_offset;
    return next === null || next === undefined
      ? { notes }
      : { notes, cursor: cursorSchema.parse(next) };
  }

  async pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage> {
    const offset =
      cursor === undefined ? undefined : cursorSchema.parse(cursor);
    const response = await this.#client.scroll(this.#collection, {
      limit: parseLimit(limit),
      with_payload: true,
      with_vector: true,
      ...(offset === undefined ? {} : { offset }),
    });
    const records = response.points.map((point) => {
      const parsed = vectorSchema.safeParse(point.vector);
      if (!parsed.success || parsed.data.length !== this.#dimensions) {
        throw new Error(
          `Stored vector for point ${String(point.id)} is missing or does not match the ` +
            `declared ${this.#dimensions}-dimensional embedding space.`,
        );
      }
      return {
        note: this.#readNote(point.id, point.payload),
        vector: parsed.data,
      };
    });
    const next = response.next_page_offset;
    return next === null || next === undefined
      ? { records }
      : { records, cursor: cursorSchema.parse(next) };
  }

  #readNote(pointId: unknown, payload: unknown): Note {
    const parsed = noteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `Stored payload for point ${String(pointId)} is not a complete note.`,
      );
    }
    if (parsed.data.id.toLowerCase() !== String(pointId).toLowerCase()) {
      throw new Error(
        `Stored note ID ${parsed.data.id} does not agree with point ID ${String(pointId)}.`,
      );
    }
    return parsed.data;
  }
}

/** The Qdrant client settings an evaluation baseline and its cleanup share. */
export const evaluationClient = (options: {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
}): QdrantClient => {
  const endpoint = new URL(options.url);
  return new QdrantClient({
    url: endpoint.origin,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    prefix: endpoint.pathname.replace(/\/$/, ""),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
};

/**
 * Open or create one compatible evaluation baseline collection. A missing collection is created
 * with its representation identity in the same request; an existing one must match exactly.
 */
export const openEvaluationBaselineStore = async (
  options: EvaluationBaselineOptions,
): Promise<NoteStore> => {
  const { url, apiKey, collection, representation, space, timeoutMs } =
    optionsSchema.parse(options);
  const client = evaluationClient({
    url,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  await ensureCollection(client, collection, representation, space);
  return new EvaluationBaselineStore(client, collection, space.dimensions);
};

/** Remove one disposable evaluation collection; only the runner's own names are ever passed here. */
export const deleteEvaluationCollection = async (options: {
  url: string;
  apiKey?: string;
  collection: string;
  timeoutMs?: number;
}): Promise<void> => {
  const client = evaluationClient(options);
  const existing = await client.collectionExists(options.collection);
  if (existing.exists) {
    await client.deleteCollection(options.collection);
  }
};
