/**
 * Qdrant-backed NoteStore implementation.
 *
 * See docs/note-store.md for the record contract, validation rules, Qdrant mapping and collection
 * compatibility requirements this module implements.
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
  type Page,
} from "./note-record.js";
import type { NoteStore } from "./note-store.js";

/** Collection metadata key and value that declare the note representation this store owns. */
const METADATA_KEY = "agenticMemory";
const SCHEMA_VERSION = 1;
const REPRESENTATION = "amem-note-v1";
/** The dense-vector storage datatype this store persists; Qdrant uses it when none is declared. */
const VECTOR_DATATYPE = "float32";

/**
 * The embedding-space descriptor a collection declares. The host supplies it as data; the shape
 * matches the Embeddings component's `EmbeddingSpace` without importing an encoder implementation.
 */
export interface NoteStoreSpace {
  readonly id: string;
  readonly dimensions: number;
  readonly distance: "Cosine";
}

/** A positive safe integer with one message for both the format and the range check. */
const positiveSafeInteger = (description: string) => {
  const message = `${description} must be a positive safe integer.`;
  return z.int(message).positive(message);
};

const spaceSchema: z.ZodType<NoteStoreSpace> = z.strictObject({
  id: z.string().min(1, "An embedding-space ID must be nonempty."),
  dimensions: positiveSafeInteger("Dimensions"),
  distance: z.literal("Cosine"),
});

const collectionMetadataSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  representation: z.literal(REPRESENTATION),
  embeddingSpace: spaceSchema,
});

/**
 * Whether the platform can send the credential in the `api-key` header the Qdrant client sets. The
 * runtime owns the header rule, and this check keeps the credential out of the failure the client
 * would otherwise raise for an unusable key.
 */
const isHeaderValue = (apiKey: string): boolean => {
  try {
    const headers = new Headers();
    headers.set("api-key", apiKey);
    return true;
  } catch {
    return false;
  }
};

const optionsSchema = z.strictObject({
  url: z
    .string()
    .refine(
      (url) => url.startsWith("http://") || url.startsWith("https://"),
      "A Qdrant URL must start with http:// or https://.",
    )
    .refine((url) => {
      if (!URL.canParse(url)) {
        return false;
      }
      const endpoint = new URL(url);
      return (
        endpoint.username === "" &&
        endpoint.password === "" &&
        !/[?#]/.test(url) &&
        endpoint.port !== "0"
      );
    }, "A Qdrant URL must be valid, use a nonzero port, and contain no credentials, query or fragment."),
  apiKey: z
    .string()
    .min(1, "An API key must be nonempty.")
    .refine(isHeaderValue, "An API key must be a valid HTTP header value.")
    .optional(),
  collection: z.string().min(1, "A collection name must be nonempty."),
  space: spaceSchema,
  timeoutMs: positiveSafeInteger("A timeout").optional(),
});

/** Connection and collection settings for a Qdrant note store; the timeout is in milliseconds. */
export type QdrantNoteStoreOptions = z.infer<typeof optionsSchema>;

/**
 * Validate connection settings against the store's own rules without contacting Qdrant. A host
 * that binds durable state to a collection runs this before opening the connection, so a
 * malformed endpoint or credential fails while nothing is bound to it yet.
 */
export const parseQdrantNoteStoreOptions = (
  options: QdrantNoteStoreOptions,
): QdrantNoteStoreOptions => optionsSchema.parse(options);

/** Raised when an existing collection is not the compatible store this connection requires. */
export class QdrantCollectionCompatibilityError extends Error {
  readonly collection: string;

  constructor(collection: string, reason: string) {
    super(
      `Qdrant collection "${collection}" is incompatible with this note store: ${reason}.`,
    );
    this.name = "QdrantCollectionCompatibilityError";
    this.collection = collection;
  }
}

interface JsonObject {
  readonly [key: string]: unknown;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const issueSummary = (
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): string =>
  issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join(".")}: ${issue.message}`,
    )
    .join("; ");

/**
 * Confirm that a stored collection declares this exact representation and embedding space and that
 * its actual vector configuration agrees. Missing, malformed and mismatched state all reject.
 */
const assertCompatible = (
  collection: string,
  info: Awaited<ReturnType<QdrantClient["getCollection"]>>,
  expected: NoteStoreSpace,
): void => {
  const vectors = isObject(info.config.params.vectors)
    ? info.config.params.vectors
    : undefined;
  const size = vectors?.["size"];
  const distance = vectors?.["distance"];
  if (typeof size !== "number" || typeof distance !== "string") {
    throw new QdrantCollectionCompatibilityError(
      collection,
      "it does not store a single unnamed dense vector",
    );
  }
  if (size !== expected.dimensions || distance !== expected.distance) {
    throw new QdrantCollectionCompatibilityError(
      collection,
      `its vector configuration is ${size} dimensions with ${distance} distance, expected ` +
        `${expected.dimensions} dimensions with ${expected.distance} distance`,
    );
  }
  // The stored datatype is part of the vector configuration: a lossy one rewrites the prepared
  // embedding on write, so anything but the supported format is incompatible.
  const datatype = vectors?.["datatype"];
  if (datatype !== undefined && datatype !== VECTOR_DATATYPE) {
    throw new QdrantCollectionCompatibilityError(
      collection,
      `it stores vectors as ${String(datatype)} instead of the supported ${VECTOR_DATATYPE}`,
    );
  }
  if (vectors?.["multivector_config"] !== undefined) {
    throw new QdrantCollectionCompatibilityError(
      collection,
      "it declares multi-vector storage instead of one dense vector per point",
    );
  }

  const metadata = info.config.metadata;
  const declared = isObject(metadata) ? metadata[METADATA_KEY] : undefined;
  if (declared === undefined) {
    throw new QdrantCollectionCompatibilityError(
      collection,
      `its collection metadata key "${METADATA_KEY}" is missing`,
    );
  }
  const parsed = collectionMetadataSchema.safeParse(declared);
  if (!parsed.success) {
    throw new QdrantCollectionCompatibilityError(
      collection,
      `its "${METADATA_KEY}" metadata is not the supported ${REPRESENTATION} schema version ` +
        `${SCHEMA_VERSION} (received ${JSON.stringify(declared)}; ` +
        `${issueSummary(parsed.error.issues)})`,
    );
  }
  const declaredSpace = parsed.data.embeddingSpace;
  if (declaredSpace.id !== expected.id) {
    throw new QdrantCollectionCompatibilityError(
      collection,
      `its declared embedding space "${declaredSpace.id}" does not match "${expected.id}"`,
    );
  }
  if (
    declaredSpace.dimensions !== expected.dimensions ||
    declaredSpace.distance !== expected.distance
  ) {
    throw new QdrantCollectionCompatibilityError(
      collection,
      `its declared embedding space is ${declaredSpace.dimensions} dimensions with ` +
        `${declaredSpace.distance} distance, expected ${expected.dimensions} dimensions with ` +
        `${expected.distance} distance`,
    );
  }
};

/**
 * Open the named collection, creating a missing one with its vector configuration and metadata in
 * a single request. A create that loses a race re-reads the existing collection instead of
 * claiming ownership of unknown state.
 */
const ensureCollection = async (
  client: QdrantClient,
  collection: string,
  space: NoteStoreSpace,
): Promise<void> => {
  const existing = await client.collectionExists(collection);
  if (!existing.exists) {
    try {
      await client.createCollection(collection, {
        vectors: {
          size: space.dimensions,
          distance: space.distance,
          datatype: VECTOR_DATATYPE,
        },
        metadata: {
          [METADATA_KEY]: {
            schemaVersion: SCHEMA_VERSION,
            representation: REPRESENTATION,
            embeddingSpace: {
              id: space.id,
              dimensions: space.dimensions,
              distance: space.distance,
            },
          },
        },
      });
    } catch (error) {
      // A concurrent initializer may have created the collection between the existence check and
      // the request. Validate whatever exists now; otherwise the failure belongs to this caller.
      const raced = await client.collectionExists(collection);
      if (!raced.exists) {
        throw error;
      }
    }
  }
  assertCompatible(collection, await client.getCollection(collection), space);
};

const parseLimit = (limit: unknown): number => {
  const parsed = positiveSafeInteger("A limit").safeParse(limit);
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
};

const parseVector = (vector: unknown, dimensions: number): number[] => {
  const parsed = vectorSchema.parse(vector);
  if (parsed.length !== dimensions) {
    throw new Error(`A vector must have exactly ${dimensions} dimensions.`);
  }
  return parsed;
};

/**
 * Validate one vector as the collection's stored embedding. The explicit export fails the whole
 * operation for a missing or unusable vector rather than skipping the record or re-embedding it.
 */
const parseStoredVector = (
  pointId: unknown,
  vector: unknown,
  dimensions: number,
): number[] => {
  const parsed = vectorSchema.safeParse(vector);
  if (!parsed.success || parsed.data.length !== dimensions) {
    throw new Error(
      `Stored vector for point ${String(pointId)} is missing or invalid for the declared ` +
        `${dimensions}-dimensional embedding space.`,
    );
  }
  return parsed.data;
};

const parseNoteId = (id: unknown): string => {
  const parsed = noteIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new Error(`Note identifiers must be UUIDs, received ${String(id)}.`);
  }
  return parsed.data;
};

/** Current note/vector records held by one compatible Qdrant collection. */
class QdrantNoteStore implements NoteStore {
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
    const ids = new Set<string>();
    for (const record of prepared) {
      const id = record.note.id.toLowerCase();
      if (ids.has(id)) {
        throw new Error(
          `A batch must not contain the note ID ${record.note.id} more than once.`,
        );
      }
      ids.add(id);
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
      const parsed = parseNoteId(id);
      const identity = parsed.toLowerCase();
      if (!requested.has(identity)) {
        requested.set(identity, parsed);
      }
    }
    const records = await this.#client.retrieve(this.#collection, {
      ids: [...requested.values()],
      with_payload: true,
      with_vector: false,
    });
    const found = new Map<string, Note>();
    for (const record of records) {
      const note = this.#readNote(record.id, record.payload);
      const identity = note.id.toLowerCase();
      if (!found.has(identity)) {
        found.set(identity, note);
      }
    }
    return [...found.values()];
  }

  /**
   * Read complete records with their actual stored vectors by identity. The requested identities
   * are fetched directly, and a found record whose stored vector is missing or unusable fails the
   * read instead of being skipped or re-embedded.
   */
  async getEmbedded(ids: string[]): Promise<EmbeddedNote[]> {
    if (ids.length === 0) {
      return [];
    }
    const requested = new Map<string, string>();
    for (const id of ids) {
      const parsed = parseNoteId(id);
      const identity = parsed.toLowerCase();
      if (!requested.has(identity)) {
        requested.set(identity, parsed);
      }
    }
    const records = await this.#client.retrieve(this.#collection, {
      ids: [...requested.values()],
      with_payload: true,
      with_vector: true,
    });
    const found = new Map<string, EmbeddedNote>();
    for (const record of records) {
      const note = this.#readNote(record.id, record.payload);
      const vector = parseStoredVector(
        record.id,
        record.vector,
        this.#dimensions,
      );
      const identity = note.id.toLowerCase();
      if (!found.has(identity)) {
        found.set(identity, { note, vector });
      }
    }
    return [...found.values()];
  }

  async nearest(vector: number[], limit: number): Promise<Match[]> {
    const searchVector = parseVector(vector, this.#dimensions);
    const count = parseLimit(limit);
    const response = await this.#client.query(this.#collection, {
      query: searchVector,
      limit: count,
      with_payload: true,
      with_vector: false,
    });
    const matches = response.points.map((point) => {
      const note = this.#readNote(point.id, point.payload);
      if (!Number.isFinite(point.score)) {
        throw new Error(
          `Qdrant returned a non-finite score for point ${String(point.id)}.`,
        );
      }
      return { note, score: point.score };
    });
    return matches.sort((left, right) => right.score - left.score);
  }

  async page(limit: number, cursor?: Cursor): Promise<Page> {
    const count = parseLimit(limit);
    const offset =
      cursor === undefined ? undefined : cursorSchema.parse(cursor);
    const response = await this.#client.scroll(this.#collection, {
      limit: count,
      with_payload: true,
      with_vector: false,
      ...(offset === undefined ? {} : { offset }),
    });
    const notes = response.points.map((point) =>
      this.#readNote(point.id, point.payload),
    );
    const next = response.next_page_offset;
    if (next === null || next === undefined) {
      return { notes };
    }
    return { notes, cursor: cursorSchema.parse(next) };
  }

  async pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage> {
    const count = parseLimit(limit);
    const offset =
      cursor === undefined ? undefined : cursorSchema.parse(cursor);
    const response = await this.#client.scroll(this.#collection, {
      limit: count,
      with_payload: true,
      with_vector: true,
      ...(offset === undefined ? {} : { offset }),
    });
    const records = response.points.map((point) => ({
      note: this.#readNote(point.id, point.payload),
      vector: parseStoredVector(point.id, point.vector, this.#dimensions),
    }));
    const next = response.next_page_offset;
    if (next === null || next === undefined) {
      return { records };
    }
    return { records, cursor: cursorSchema.parse(next) };
  }

  /**
   * Validate a stored payload as a complete note. A payload that is malformed or whose ID does not
   * agree with its point ID is an error, never a silently omitted or repaired record.
   */
  #readNote(pointId: unknown, payload: unknown): Note {
    const parsed = noteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `Stored payload for point ${String(pointId)} is not a complete note ` +
          `(${issueSummary(parsed.error.issues)}).`,
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

/**
 * Open or create a compatible collection and return the NoteStore backed by it. The host owns
 * server startup, shutdown and credentials.
 */
export const openQdrantNoteStore = async (
  options: QdrantNoteStoreOptions,
): Promise<NoteStore> => {
  const { url, apiKey, collection, space, timeoutMs } =
    parseQdrantNoteStoreOptions(options);
  const endpoint = new URL(url);
  const client = new QdrantClient({
    // The client defaults missing ports to 6333 and ignores URL paths. URL normalizes explicit
    // standard ports to an empty string, so supply the effective port and base path separately.
    url: endpoint.origin,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    prefix: endpoint.pathname.replace(/\/$/, ""),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  await ensureCollection(client, collection, space);
  return new QdrantNoteStore(client, collection, space.dimensions);
};
