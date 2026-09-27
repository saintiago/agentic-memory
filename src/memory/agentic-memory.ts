/**
 * Memory orchestration for note insertion: construct semantic attributes, consider the nearest
 * stored notes, interpret one evolution decision and persist the incoming note together with the
 * accepted changes as one batch. Retrieval and inspection belong to the retrieval composition.
 *
 * See docs/memory.md and docs/architecture.md#insertion-and-evolution.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { Embedder } from "../embeddings/index.js";
import type { LanguageModel } from "../language-model/index.js";
import {
  jsonValueSchema,
  vectorSchema,
  type Attributes,
  type EmbeddedNote,
  type JsonValue,
  type Match,
  type Note,
  type NoteStore,
} from "../note-store/index.js";
import { MemoryError, type MemoryStage } from "./memory-error.js";
import {
  assembleConstructionPrompt,
  assembleEvolutionPrompt,
  defaultPrompts,
  type MemoryPrompts,
} from "./prompts.js";
import { embeddingText } from "./representation.js";
import {
  readConstructionResponse,
  readEvolutionResponse,
  type EvolutionResponse,
} from "./response.js";

const hasNonWhitespaceText = (value: string): boolean => /\S/.test(value);

const isJsonObject = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/**
 * Metadata reuses NoteStore's JSON value contract, so non-JSON values, cycles and non-finite
 * numbers are rejected and the accepted tree is detached, and then requires a JSON object.
 */
const metadataSchema: z.ZodType<Record<string, JsonValue>> =
  jsonValueSchema.refine(isJsonObject, "Metadata must be a JSON object.");

/**
 * Source material for one note. The content rule mirrors the persisted record's rule, and the
 * metadata rule accepts a detached JSON object or rejects it; nothing is silently dropped.
 */
const addInputSchema = z.strictObject({
  content: z
    .string()
    .refine(hasNonWhitespaceText, "Content must contain non-whitespace text."),
  timestamp: z.iso
    .datetime({
      offset: true,
      message: "A timestamp must be an ISO 8601 instant with a timezone.",
    })
    .optional(),
  metadata: metadataSchema.optional(),
});

/** Source material accepted for a new note. Provenance is caller-supplied and returned unchanged. */
export type AddInput = z.infer<typeof addInputSchema>;

/** A positive safe integer with one message for both the format and the range check. */
const positiveSafeInteger = (description: string) => {
  const message = `${description} must be a positive safe integer.`;
  return z.int(message).positive(message);
};

const memoryOptionsSchema = z.strictObject({
  neighbors: positiveSafeInteger("The neighbor limit").optional(),
  prompts: z
    .strictObject({
      construction: z
        .string()
        .min(1, "The construction prompt must be a nonempty string."),
      evolution: z
        .string()
        .min(1, "The evolution prompt must be a nonempty string."),
    })
    .partial()
    .optional(),
});

/** Instance settings for insertion. Omitted values use the documented defaults. */
export type MemoryOptions = z.infer<typeof memoryOptionsSchema>;

/** Retrieval limits: direct matches and the optional one-hop linked additions. */
export interface SearchOptions {
  limit?: number;
  linkedLimit?: number;
}

/** Direct matches keep their score; linked additions are distinct notes found through one hop. */
export type SearchResult =
  { note: Note; via: "match"; score: number } | { note: Note; via: "link" };

const DEFAULT_NEIGHBORS = 5;

const readAddInput = (input: unknown): AddInput => {
  const parsed = addInputSchema.safeParse(input);
  if (!parsed.success) {
    // The public reason stays fixed: schema issues can quote caller-supplied property names or
    // metadata paths, so the structured issues stay attached as the cause instead.
    throw new MemoryError({
      operation: "add",
      stage: "input",
      persistence: "unchanged",
      reason: "The input is not a valid add request.",
      cause: parsed.error,
    });
  }
  return parsed.data;
};

/** A failure before the batch write leaves stored notes unchanged. */
const addFailure = (
  stage: MemoryStage,
  reason: string,
  noteId: string,
  cause?: unknown,
): MemoryError =>
  new MemoryError({
    operation: "add",
    stage,
    persistence: "unchanged",
    reason,
    noteId,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * The library's memory operations. Insertions on one instance are serialized in invocation order;
 * the host still owns collecting source material, awaiting writes and reconciling uncertain
 * outcomes. This queue is not a durable job system or a distributed writer lock.
 */
export class AgenticMemory {
  readonly #store: NoteStore;
  readonly #embedder: Embedder;
  readonly #model: LanguageModel;
  readonly #prompts: MemoryPrompts;
  readonly #neighbors: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    store: NoteStore,
    embedder: Embedder,
    model: LanguageModel,
    options: MemoryOptions = {},
  ) {
    // Instance settings fail at construction with a schema error; they are not an operation.
    const parsed = memoryOptionsSchema.parse(options);
    this.#store = store;
    this.#embedder = embedder;
    this.#model = model;
    this.#prompts = {
      construction: parsed.prompts?.construction ?? defaultPrompts.construction,
      evolution: parsed.prompts?.evolution ?? defaultPrompts.evolution,
    };
    this.#neighbors = parsed.neighbors ?? DEFAULT_NEIGHBORS;
  }

  /**
   * Insert one source note. The input is validated and copied at the call boundary, and the
   * insertion runs after every earlier insertion on this instance. A rejected insertion does not
   * block the ones queued after it.
   */
  async add(input: AddInput): Promise<Note> {
    const request = readAddInput(input);
    const operation = this.#queue.then(() => this.#insert(request));
    // The queue only tracks completion; a failed insertion must not poison later ones.
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #insert(request: AddInput): Promise<Note> {
    // Resolve the observation time when the queued insertion starts, not when it was invoked.
    const timestamp = request.timestamp ?? new Date().toISOString();
    const noteId = randomUUID();

    const attributes = await this.#construct(
      request.content,
      timestamp,
      noteId,
    );
    const constructed: Note = {
      id: noteId,
      content: request.content,
      timestamp,
      context: attributes.context,
      keywords: attributes.keywords,
      tags: attributes.tags,
      links: [],
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    };

    const initialVector = await this.#embed(embeddingText(constructed), noteId);
    const candidates = await this.#nearest(initialVector, noteId);

    if (candidates.length === 0) {
      await this.#persist(
        [{ note: constructed, vector: initialVector }],
        noteId,
      );
      return constructed;
    }

    const decision = await this.#evolve(constructed, candidates, noteId);
    const incoming: Note = {
      ...constructed,
      links: decision.links,
      tags: decision.newTags,
    };
    const changed = await this.#revise(decision, candidates, noteId);

    // Link-only changes reuse the constructed vector; a changed incoming representation is
    // embedded again before the batch write.
    const incomingVector =
      embeddingText(incoming) === embeddingText(constructed)
        ? initialVector
        : await this.#embed(embeddingText(incoming), noteId);

    await this.#persist(
      [...changed, { note: incoming, vector: incomingVector }],
      noteId,
    );
    return incoming;
  }

  async #construct(
    content: string,
    timestamp: string,
    noteId: string,
  ): Promise<Attributes> {
    const prompt = assembleConstructionPrompt(this.#prompts.construction, {
      content,
      timestamp,
    });
    let response: unknown;
    try {
      response = await this.#model.generate({ stage: "construct", prompt });
    } catch (cause) {
      throw addFailure(
        "construct",
        "The language model failed to answer the construction request.",
        noteId,
        cause,
      );
    }
    try {
      return readConstructionResponse(response);
    } catch (cause) {
      // Only the fixed description is public: response-validation detail can quote untrusted
      // response content and stays in the attached cause.
      throw addFailure(
        "construct",
        "The construction response does not satisfy the documented contract.",
        noteId,
        cause,
      );
    }
  }

  async #embed(text: string, noteId: string): Promise<number[]> {
    let vector: number[];
    try {
      vector = await this.#embedder.embed(text);
    } catch (cause) {
      throw addFailure(
        "embed",
        "The embedder failed to produce a vector for the note text.",
        noteId,
        cause,
      );
    }
    // A provider that violates its declared space is rejected before the write attempt, so an
    // unusable vector is reported as an unchanged failure instead of an uncertain write.
    const dimensions = this.#embedder.space.dimensions;
    const parsed = vectorSchema.safeParse(vector);
    if (!parsed.success || parsed.data.length !== dimensions) {
      throw addFailure(
        "embed",
        `The embedder returned a vector that does not match its declared ` +
          `${dimensions}-dimensional space.`,
        noteId,
        parsed.success ? undefined : parsed.error,
      );
    }
    return parsed.data;
  }

  async #nearest(vector: number[], noteId: string): Promise<Match[]> {
    try {
      return await this.#store.nearest(vector, this.#neighbors);
    } catch (cause) {
      throw addFailure(
        "candidates",
        "The note store failed to return nearest neighbors.",
        noteId,
        cause,
      );
    }
  }

  async #evolve(
    incoming: Note,
    candidates: Match[],
    noteId: string,
  ): Promise<EvolutionResponse> {
    const prompt = assembleEvolutionPrompt(this.#prompts.evolution, {
      incoming,
      neighbors: candidates.map((candidate) => candidate.note),
    });
    let response: unknown;
    try {
      response = await this.#model.generate({ stage: "evolve", prompt });
    } catch (cause) {
      throw addFailure(
        "evolve",
        "The language model failed to answer the evolution request.",
        noteId,
        cause,
      );
    }
    try {
      return readEvolutionResponse(
        response,
        candidates.map((candidate) => candidate.note.id),
      );
    } catch (cause) {
      // Only the fixed description is public: response-validation detail can quote untrusted
      // response content and stays in the attached cause.
      throw addFailure(
        "evolve",
        "The evolution response does not satisfy the documented contract.",
        noteId,
        cause,
      );
    }
  }

  /**
   * Prepare the accepted neighbor revisions. A proposal whose canonical embedding text is
   * unchanged is omitted; every other revision receives a fresh embedding before any write.
   */
  async #revise(
    decision: EvolutionResponse,
    candidates: Match[],
    noteId: string,
  ): Promise<EmbeddedNote[]> {
    const stored = new Map<string, Note>();
    for (const candidate of candidates) {
      stored.set(candidate.note.id.toLowerCase(), candidate.note);
    }
    const prepared: EmbeddedNote[] = [];
    for (const update of decision.updates) {
      const current = stored.get(update.id.toLowerCase());
      if (current === undefined) {
        // readEvolutionResponse already rejected references outside the candidate set.
        throw addFailure(
          "evolve",
          `The evolution response references the unknown note ${update.id}.`,
          noteId,
        );
      }
      const revised: Note = {
        ...current,
        context: update.context,
        keywords: update.keywords,
        tags: update.tags,
      };
      const text = embeddingText(revised);
      if (text === embeddingText(current)) {
        continue;
      }
      prepared.push({ note: revised, vector: await this.#embed(text, noteId) });
    }
    return prepared;
  }

  /**
   * Issue the single batch write. A rejected write attempt is reported as uncertain: the provider
   * may have applied part of the batch, and Memory never attempts a rollback.
   */
  async #persist(records: EmbeddedNote[], noteId: string): Promise<void> {
    try {
      await this.#store.put(records);
    } catch (cause) {
      throw new MemoryError({
        operation: "add",
        stage: "persist",
        persistence: "uncertain",
        noteId,
        affectedNoteIds: records.map((record) => record.note.id),
        reason:
          "The note store rejected the prepared batch, so its outcome is uncertain.",
        cause,
      });
    }
  }
}
