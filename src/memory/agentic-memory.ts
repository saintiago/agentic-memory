/**
 * Memory orchestration for note insertion, retrieval and inspection: construct semantic attributes,
 * consider the nearest stored notes, interpret one evolution decision and persist the incoming note
 * together with the accepted changes as one batch, recording the batch preparation time on the
 * incoming note and each actually changed neighbor; embed a query, keep the store's ranked direct
 * matches and follow one bounded hop of their outgoing links; read notes and pages without
 * generating text or changing a record.
 *
 * Insertion is available in one call through `add` and as the durable, two-step `prepare`/`apply`
 * path the ingestion queue consumes. Both share this algorithm: `prepare` returns the immutable
 * plan without writing, and `apply` writes the exact supplied plan without regeneration.
 * `prepareContextCorrection` prepares a reviewed replacement of one existing note through the same
 * immutable plan format; it reads and embeds without constructing, searching or writing.
 * `prepareLinkCorrection` prepares a reviewed removal of outgoing links from one existing note
 * through that format; it reads the current record with its stored vector without embedding,
 * constructing, searching or writing.
 *
 * See docs/memory.md, docs/architecture.md#insertion-and-evolution and
 * docs/architecture.md#retrieval.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { Embedder } from "../embeddings/index.js";
import type { LanguageModel } from "../language-model/index.js";
import {
  cursorSchema,
  embeddedNoteSchema,
  jsonValueSchema,
  noteIdSchema,
  noteSchema,
  pageSchema,
  vectorSchema,
  type Attributes,
  type Cursor,
  type EmbeddedNote,
  type JsonValue,
  type Match,
  type Note,
  type NoteStore,
  type Page,
} from "../note-store/index.js";
import {
  MemoryError,
  type CorrectionReadOutcome,
  type MemoryOperation,
  type MemoryStage,
} from "./memory-error.js";
import {
  contextCorrectionInputSchema,
  type ContextCorrectionInput,
  type ContextCorrectionPreparation,
  type ContextCorrectionPreparer,
} from "./context-correction.js";
import {
  linkCorrectionInputSchema,
  type LinkCorrectionInput,
  type LinkCorrectionPreparer,
} from "./link-correction.js";
import {
  insertionPlanSchema,
  insertionPlanVersion,
  type InsertionPlan,
} from "./insertion-plan.js";
import {
  assembleConstructionPrompt,
  assembleEvolutionPrompt,
  defaultPrompts,
  type MemoryPrompts,
} from "./prompts.js";
import { embeddingText, representationVersion } from "./representation.js";
import {
  readConstructionResponse,
  readEvolutionResponse,
  type EvolutionResponse,
} from "./response.js";

const hasNonWhitespaceText = (value: string): boolean => /\S/.test(value);

/** Non-whitespace text with one message for both source content and search queries. */
const nonWhitespaceText = (description: string) =>
  z
    .string()
    .refine(
      hasNonWhitespaceText,
      `${description} must contain non-whitespace text.`,
    );

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
  content: nonWhitespaceText("Content"),
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

/**
 * Source material for one durable insertion whose identity and observation time were fixed at
 * acceptance: content, the previously allocated note identity and the original timestamp.
 */
const prepareInputSchema = z.strictObject({
  noteId: noteIdSchema,
  content: nonWhitespaceText("Content"),
  timestamp: z.iso.datetime({
    offset: true,
    message: "A timestamp must be an ISO 8601 instant with a timezone.",
  }),
  metadata: metadataSchema.optional(),
});

/** Source material accepted for durable preparation. */
export type PrepareInput = z.infer<typeof prepareInputSchema>;

/** A positive safe integer with one message for both the format and the range check. */
const positiveSafeInteger = (description: string) => {
  const message = `${description} must be a positive safe integer.`;
  return z.int(message).positive(message);
};

/** A nonnegative safe integer with one message for both the format and the range check. */
const nonnegativeSafeInteger = (description: string) => {
  const message = `${description} must be a nonnegative safe integer.`;
  return z.int(message).nonnegative(message);
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

/** Retrieval limits: a positive direct-match limit and a nonnegative linked-addition limit. */
const searchOptionsSchema = z.strictObject({
  limit: positiveSafeInteger("The direct-match limit").optional(),
  linkedLimit: nonnegativeSafeInteger("The linked-additions limit").optional(),
});

const DEFAULT_NEIGHBORS = 5;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_LINKED_LIMIT = 5;

/** The retrieval operations. They never write, so their failures are always `unchanged`. */
type RetrievalOperation = Extract<MemoryOperation, "get" | "page" | "search">;

/**
 * The pre-write mutations: insertion preparation, correction preparation and plan application.
 * Any failure before the single batch write leaves stored notes unchanged.
 */
type MutationOperation = Extract<
  MemoryOperation,
  | "add"
  | "prepare"
  | "prepareContextCorrection"
  | "prepareLinkCorrection"
  | "apply"
>;

/** The operations that embed the note representation they prepare. */
type EmbeddingOperation = Extract<
  MemoryOperation,
  "add" | "prepare" | "prepareContextCorrection"
>;

/**
 * Validate one insertion request. The public reason stays fixed: schema issues can quote
 * caller-supplied property names or metadata paths, so the structured issues stay attached as the
 * cause instead.
 */
const readInsertionInput = <Output>(
  operation: "add" | "prepare",
  schema: z.ZodType<Output>,
  input: unknown,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      operation,
      stage: "input",
      persistence: "unchanged",
      reason: `The input is not a valid ${operation} request.`,
      cause: parsed.error,
    });
  }
  return parsed.data;
};

/** An insertion failure before the batch write attempt leaves stored notes unchanged. */
const insertionFailure = (
  operation: MutationOperation,
  stage: MemoryStage,
  reason: string,
  noteId?: string,
  cause?: unknown,
): MemoryError =>
  new MemoryError({
    operation,
    stage,
    persistence: "unchanged",
    reason,
    ...(noteId === undefined ? {} : { noteId }),
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * One failed correction read, carrying the evidence a maintenance owner needs: a confirmed stale
 * proposal is distinct from a read that could not observe storage.
 */
const correctionReadFailure = (
  operation: Extract<
    MemoryOperation,
    "prepareContextCorrection" | "prepareLinkCorrection"
  >,
  noteId: string,
  readOutcome: CorrectionReadOutcome,
  reason: string,
  cause?: unknown,
): MemoryError =>
  new MemoryError({
    operation,
    stage: "read",
    persistence: "unchanged",
    reason,
    noteId,
    readOutcome,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * A rejected retrieval request or a failed read. Retrieval never writes, so every retrieval
 * failure leaves stored notes unchanged and the caller chooses the stage that failed.
 */
const retrievalFailure = (
  operation: RetrievalOperation,
  stage: Extract<MemoryStage, "input" | "embed" | "candidates" | "read">,
  reason: string,
  cause?: unknown,
): MemoryError =>
  new MemoryError({
    operation,
    stage,
    persistence: "unchanged",
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Validate one provider vector against the declared embedding space. The parsed values are
 * detached; a mismatched shape, non-finite component, zero norm or wrong length is a failure the
 * caller reports before any write.
 */
const parseProviderVector = (
  vector: unknown,
  dimensions: number,
): { vector: number[] } | { reason: string; cause?: unknown } => {
  const parsed = vectorSchema.safeParse(vector);
  if (parsed.success && parsed.data.length === dimensions) {
    return { vector: parsed.data };
  }
  return {
    reason:
      "The embedder returned a vector that does not match its declared " +
      `${dimensions}-dimensional space.`,
    ...(parsed.success ? {} : { cause: parsed.error }),
  };
};

/**
 * Select the link targets of the ranked matches in match rank and stored link order, without
 * repeating a direct match or an earlier target, until the linked budget is exhausted. Selection
 * happens before the fetch, so a missing target is never replaced by a further link.
 */
const selectLinkedTargets = (
  matches: readonly Match[],
  budget: number,
): string[] => {
  const selected: string[] = [];
  if (budget === 0) {
    return selected;
  }
  const known = new Set(matches.map((match) => match.note.id.toLowerCase()));
  for (const match of matches) {
    for (const link of match.note.links) {
      const identity = link.toLowerCase();
      if (known.has(identity)) {
        continue;
      }
      known.add(identity);
      selected.push(link);
      if (selected.length === budget) {
        return selected;
      }
    }
  }
  return selected;
};

/**
 * Detach one record at the public boundary. Parsing the shared note schema returns a copy of the
 * validated tree, including nested metadata and arrays. The NoteStore contract does not promise
 * detached reads, and a replacement store may retain the records handed to a write, so a host must
 * never reach stored state through the note an operation returns.
 */
const detachNote = (note: Note): Note => noteSchema.parse(note);

/**
 * Compare two note or attribute values completely, independent of JSON object key order: every
 * string, array element and UUID spelling must match exactly, while a present `undefined` counts
 * as an absent optional field. Update time is part of the complete comparison, never the only
 * revision token.
 */
const sameJsonValue = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((element, index) => sameJsonValue(element, right[index]))
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  const meaningful = (value: object): [string, unknown][] =>
    Object.entries(value).filter(([, nested]) => nested !== undefined);
  const rightEntries = new Map(meaningful(right));
  const leftEntries = meaningful(left);
  return (
    leftEntries.length === rightEntries.size &&
    leftEntries.every(
      ([key, value]) =>
        rightEntries.has(key) && sameJsonValue(value, rightEntries.get(key)),
    )
  );
};

/** The semantic attributes of one note, as a correction proposal describes them. */
const noteAttributes = (note: Note): Attributes => ({
  context: note.context,
  keywords: note.keywords,
  tags: note.tags,
});

/**
 * Sample the batch preparation time once, immediately before the write that persists the current
 * note versions. It records when the version was prepared for persistence; it is not the
 * observation `timestamp`, a commit acknowledgment or a change cursor.
 *
 * See docs/memory.md#update-time.
 */
const batchPreparationTime = (): string => new Date().toISOString();

/**
 * Freeze a prepared plan in place. Preparation promises an immutable plan, and the queue may keep
 * one for a long time, so a caller cannot change pending work after preparation succeeded.
 */
const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
};

/** One insertion the persistence path builds a plan for; identity and timestamp are fixed. */
interface InsertionRequest {
  readonly noteId: string;
  readonly content: string;
  readonly timestamp: string;
  readonly metadata?: Record<string, JsonValue> | undefined;
}

/**
 * The library's memory operations. Insertions on one instance are serialized in invocation order;
 * the host still owns collecting source material, awaiting writes and reconciling uncertain
 * outcomes. This queue is not a durable job system or a distributed writer lock. Correction
 * preparation joins that order; retrieval and inspection keep their ordinary concurrency.
 */
export class AgenticMemory
  implements ContextCorrectionPreparer, LinkCorrectionPreparer
{
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
    const request = readInsertionInput("add", addInputSchema, input);
    return await this.#enqueue(async () => {
      // Resolve the observation time when the queued insertion starts, not when it was invoked.
      const timestamp = request.timestamp ?? new Date().toISOString();
      const plan = await this.#buildPlan("add", {
        noteId: randomUUID(),
        content: request.content,
        timestamp,
        ...(request.metadata === undefined
          ? {}
          : { metadata: request.metadata }),
      });
      return await this.#applyPlan("add", this.#readPlan("add", plan));
    });
  }

  /**
   * Prepare one durable insertion without writing notes. The caller supplies the identity and
   * observation time fixed at acceptance; the returned plan is immutable and contains every
   * record the later application writes. The same construction, evolution and embedding rules as
   * `add` apply, and preparation is serialized with every other insertion on this instance.
   */
  async prepare(input: PrepareInput): Promise<InsertionPlan> {
    const request = readInsertionInput("prepare", prepareInputSchema, input);
    return await this.#enqueue(() => this.#buildPlan("prepare", request));
  }

  /**
   * Prepare one reviewed correction of an existing note. The proposal is validated and detached at
   * the call boundary; the current note is read and compared inside the invocation order, so a
   * stale proposal is rejected without writes and without poisoning later operations. A no-op
   * returns the current note; a change returns the revised note and a frozen one-record plan the
   * existing `apply` writes unchanged. There is no construction, search, model call or link change.
   *
   * See docs/memory.md#existing-context-correction.
   */
  async prepareContextCorrection(
    input: ContextCorrectionInput,
  ): Promise<ContextCorrectionPreparation> {
    const parsed = contextCorrectionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw insertionFailure(
        "prepareContextCorrection",
        "input",
        "The input is not a valid context correction request.",
        undefined,
        parsed.error,
      );
    }
    const { expected, attributes } = parsed.data;
    return await this.#enqueue(async () => {
      const current = await this.#readInspected(expected);
      if (!sameJsonValue(expected, current)) {
        throw correctionReadFailure(
          "prepareContextCorrection",
          expected.id,
          "stale",
          "The inspected note does not match the current stored note.",
        );
      }
      if (sameJsonValue(attributes, noteAttributes(current))) {
        return { note: detachNote(current) };
      }
      // Only the semantic attributes change; identity, source content, timestamp, metadata,
      // links and `updatedAt` all come from the current stored note.
      const revised: Note = {
        ...current,
        context: attributes.context,
        keywords: attributes.keywords,
        tags: attributes.tags,
      };
      const vector = await this.#embed(
        "prepareContextCorrection",
        embeddingText(revised),
        current.id,
      );
      // The update time is sampled only after the embedding succeeded. A no-op never reaches
      // this point, so it conserves the record and its update time exactly.
      const note: Note = { ...revised, updatedAt: batchPreparationTime() };
      return { note, plan: this.#plan(current.id, [{ note, vector }]) };
    });
  }

  /**
   * Prepare one reviewed removal of outgoing links from an existing note. The proposal is
   * validated and detached at the call boundary; the current record is read with its stored vector
   * and compared inside the invocation order, so a stale proposal is rejected without writes and
   * without poisoning later operations. Every valid removal changes the note, so preparation
   * always returns a frozen one-record plan the existing `apply` writes unchanged, reusing the
   * actual stored vector. There is no construction, search, model call, embedding or target write.
   *
   * See docs/memory.md#existing-link-correction.
   */
  async prepareLinkCorrection(
    input: LinkCorrectionInput,
  ): Promise<InsertionPlan> {
    const parsed = linkCorrectionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw insertionFailure(
        "prepareLinkCorrection",
        "input",
        "The input is not a valid link correction request.",
        undefined,
        parsed.error,
      );
    }
    const { expected, removeTargetIds } = parsed.data;
    return await this.#enqueue(async () => {
      const current = await this.#readInspectedEmbedded(expected);
      if (!sameJsonValue(expected, current.note)) {
        throw correctionReadFailure(
          "prepareLinkCorrection",
          expected.id,
          "stale",
          "The inspected note does not match the current stored note.",
        );
      }
      // Only the selected outgoing links are filtered out; the identity, source content, source
      // timestamp, metadata, semantic attributes and stored vector stay exactly as read.
      const removals = new Set(
        removeTargetIds.map((target) => target.toLowerCase()),
      );
      const note: Note = {
        ...current.note,
        links: current.note.links.filter(
          (link) => !removals.has(link.toLowerCase()),
        ),
        updatedAt: batchPreparationTime(),
      };
      return this.#plan(current.note.id, [{ note, vector: current.vector }]);
    });
  }

  /**
   * Apply one prepared plan: validate its version and declared embedding space, then write its
   * exact records through the store's `put` contract without regenerating anything. Reapplying the
   * same plan preserves identities, vectors and update times. Validation detaches the supplied
   * plan at invocation, before waiting for earlier insertions.
   */
  async apply(plan: InsertionPlan): Promise<Note> {
    const prepared = this.#readPlan("apply", plan);
    return await this.#enqueue(() => this.#applyPlan("apply", prepared));
  }

  /**
   * Read the complete current note, or `undefined` when the store holds no such note. An invalid
   * identity fails before the store call, and a store failure is an operation error rather than an
   * absent note.
   */
  async get(id: string): Promise<Note | undefined> {
    const parsed = noteIdSchema.safeParse(id);
    if (!parsed.success) {
      throw retrievalFailure(
        "get",
        "input",
        "The input is not a valid note ID.",
        parsed.error,
      );
    }
    const identity = parsed.data.toLowerCase();
    const notes = await this.#read(
      "get",
      async () => (await this.#store.get([parsed.data])).map(detachNote),
      "The note store failed to read the requested note.",
    );
    return notes.find((note) => note.id.toLowerCase() === identity);
  }

  /**
   * Inspect one page of current notes: the limit defaults to 100 notes and the opaque cursor is
   * forwarded to the store. Inspection neither generates text nor changes a record.
   */
  async page(
    limit: number = DEFAULT_PAGE_LIMIT,
    cursor?: Cursor,
  ): Promise<Page> {
    const parsedLimit = positiveSafeInteger("The page limit").safeParse(limit);
    const parsedCursor =
      cursor === undefined ? undefined : cursorSchema.safeParse(cursor);
    const cursorIssue =
      parsedCursor !== undefined && !parsedCursor.success
        ? parsedCursor.error
        : undefined;
    if (!parsedLimit.success || cursorIssue !== undefined) {
      throw retrievalFailure(
        "page",
        "input",
        "The input is not a valid page request.",
        parsedLimit.success ? cursorIssue : parsedLimit.error,
      );
    }
    return await this.#read(
      "page",
      async () =>
        pageSchema.parse(
          await this.#store.page(parsedLimit.data, parsedCursor?.data),
        ),
      "The note store failed to read the requested page.",
    );
  }

  /**
   * Search current notes. The query is embedded as supplied; the store's ranked direct matches keep
   * their order and scores, and distinct notes reached through one hop of their outgoing links are
   * appended in selection order. Search makes no model call and never rewrites the query.
   */
  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const parsedQuery = nonWhitespaceText("The search query").safeParse(query);
    const parsedOptions = searchOptionsSchema.safeParse(options);
    if (!parsedQuery.success || !parsedOptions.success) {
      throw retrievalFailure(
        "search",
        "input",
        "The input is not a valid search request.",
        parsedQuery.success ? parsedOptions.error : parsedQuery.error,
      );
    }
    const limit = parsedOptions.data.limit ?? DEFAULT_SEARCH_LIMIT;
    const linkedLimit = parsedOptions.data.linkedLimit ?? DEFAULT_LINKED_LIMIT;
    const vector = await this.#queryVector(parsedQuery.data);

    let matches: Match[];
    try {
      matches = (await this.#store.nearest(vector, limit)).map((match) => ({
        note: detachNote(match.note),
        score: match.score,
      }));
    } catch (cause) {
      throw retrievalFailure(
        "search",
        "candidates",
        "The note store failed to return direct matches.",
        cause,
      );
    }
    const results: SearchResult[] = matches.map((match) => ({
      note: match.note,
      via: "match",
      score: match.score,
    }));

    // The targets are selected before the fetch, so a missing one is skipped instead of being
    // replaced by a link that did not fit the budget.
    const selected = selectLinkedTargets(matches, linkedLimit);
    if (selected.length === 0) {
      return results;
    }
    const fetched = await this.#read(
      "search",
      async () => (await this.#store.get(selected)).map(detachNote),
      "The note store failed to read the linked notes.",
    );
    const byIdentity = new Map(
      fetched.map((note) => [note.id.toLowerCase(), note]),
    );
    for (const id of selected) {
      const note = byIdentity.get(id.toLowerCase());
      if (note !== undefined) {
        results.push({ note, via: "link" });
      }
    }
    return results;
  }

  /** Run one insertion step after every earlier insertion on this instance. */
  async #enqueue<Value>(run: () => Promise<Value>): Promise<Value> {
    const result = this.#queue.then(run);
    // The queue only tracks completion; a failed insertion must not poison later ones.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  /**
   * Read the note a correction proposal inspected, matching identities as `get` does. A missing
   * note and a failed read are distinct unchanged failures the caller reports before any write.
   */
  async #readInspected(expected: Note): Promise<Note> {
    let found: Note[];
    try {
      found = (await this.#store.get([expected.id])).map(detachNote);
    } catch (cause) {
      throw correctionReadFailure(
        "prepareContextCorrection",
        expected.id,
        "unknown",
        "The note store failed to read the inspected note.",
        cause,
      );
    }
    const identity = expected.id.toLowerCase();
    const current = found.find((note) => note.id.toLowerCase() === identity);
    if (current === undefined) {
      throw correctionReadFailure(
        "prepareContextCorrection",
        expected.id,
        "stale",
        "The inspected note no longer exists in the collection.",
      );
    }
    return current;
  }

  /**
   * Read the record a link-correction proposal inspected with its actual stored vector, matching
   * identities as `get` does. A missing note, a failed read and an unusable stored vector are
   * distinct unchanged failures the caller reports before any write; only the completed read can
   * confirm a proposal stale.
   */
  async #readInspectedEmbedded(expected: Note): Promise<EmbeddedNote> {
    const dimensions = this.#embedder.space.dimensions;
    let found: EmbeddedNote[];
    try {
      found = (await this.#store.getEmbedded([expected.id])).map((record) => {
        const parsed = embeddedNoteSchema.parse(record);
        if (parsed.vector.length !== dimensions) {
          throw new Error(
            `The stored vector of note ${parsed.note.id} does not match the declared ` +
              `${dimensions}-dimensional embedding space.`,
          );
        }
        return parsed;
      });
    } catch (cause) {
      throw correctionReadFailure(
        "prepareLinkCorrection",
        expected.id,
        "unknown",
        "The note store failed to read the inspected record.",
        cause,
      );
    }
    const identity = expected.id.toLowerCase();
    const current = found.find(
      (record) => record.note.id.toLowerCase() === identity,
    );
    if (current === undefined) {
      throw correctionReadFailure(
        "prepareLinkCorrection",
        expected.id,
        "stale",
        "The inspected note no longer exists in the collection.",
      );
    }
    return current;
  }

  /**
   * Construct, link and evolve one note without writing. The same rules serve `add` and `prepare`;
   * only the failure's operation name and the moment the result becomes durable differ.
   */
  async #buildPlan(
    operation: "add" | "prepare",
    request: InsertionRequest,
  ): Promise<InsertionPlan> {
    const { noteId, content, timestamp, metadata } = request;
    const attributes = await this.#construct(
      operation,
      content,
      timestamp,
      noteId,
    );
    const constructed: Note = {
      id: noteId,
      content,
      timestamp,
      context: attributes.context,
      keywords: attributes.keywords,
      tags: attributes.tags,
      links: [],
      ...(metadata === undefined ? {} : { metadata }),
    };

    const initialVector = await this.#embed(
      operation,
      embeddingText(constructed),
      noteId,
    );
    const candidates = await this.#nearest(operation, initialVector, noteId);

    if (candidates.length === 0) {
      // Insertion always supplies an update time. It is sampled after preparation succeeded and
      // immediately before the write, and it never replaces the observation timestamp.
      const inserted: Note = {
        ...constructed,
        updatedAt: batchPreparationTime(),
      };
      return this.#plan(noteId, [{ note: inserted, vector: initialVector }]);
    }

    const decision = await this.#evolve(
      operation,
      constructed,
      candidates,
      noteId,
    );
    const incoming: Note = {
      ...constructed,
      links: decision.links,
      tags: decision.newTags,
    };
    const changed = await this.#revise(operation, decision, candidates, noteId);

    // Link-only changes reuse the constructed vector; a changed incoming representation is
    // embedded again before the batch write.
    const incomingVector =
      embeddingText(incoming) === embeddingText(constructed)
        ? initialVector
        : await this.#embed(operation, embeddingText(incoming), noteId);

    // All interpretation and embedding work succeeded. Sample the batch preparation time once,
    // immediately before the write, and record it on the incoming note and every actually changed
    // neighbor. `updatedAt` is excluded from the embedded text, so stamping cannot stale a vector.
    const updatedAt = batchPreparationTime();
    const incomingNote: Note = { ...incoming, updatedAt };
    const batch: EmbeddedNote[] = [
      ...changed.map((record) => ({
        note: { ...record.note, updatedAt },
        vector: record.vector,
      })),
      { note: incomingNote, vector: incomingVector },
    ];
    return this.#plan(noteId, batch);
  }

  /** Detach provider-owned records before freezing the completed insertion decision. */
  #plan(noteId: string, records: EmbeddedNote[]): InsertionPlan {
    const space = this.#embedder.space;
    return deepFreeze({
      version: insertionPlanVersion,
      representation: representationVersion,
      embeddingSpace: {
        id: space.id,
        dimensions: space.dimensions,
        distance: space.distance,
      },
      noteId,
      records: structuredClone(records),
    });
  }

  /**
   * Validate and detach one plan. A plan is applicable when it declares this schema version and
   * representation and the exact embedding space of this instance. Validation runs before
   * enqueueing caller-supplied plans, so later mutations cannot change pending work.
   */
  #readPlan(operation: "add" | "apply", plan: InsertionPlan): InsertionPlan {
    const parsed = insertionPlanSchema.safeParse(plan);
    if (!parsed.success) {
      throw insertionFailure(
        operation,
        "input",
        "The insertion plan does not satisfy the documented contract.",
        undefined,
        parsed.error,
      );
    }
    const prepared = parsed.data;
    const space = this.#embedder.space;
    if (
      prepared.embeddingSpace.id !== space.id ||
      prepared.embeddingSpace.dimensions !== space.dimensions ||
      prepared.embeddingSpace.distance !== space.distance
    ) {
      throw insertionFailure(
        operation,
        "input",
        "The insertion plan belongs to a different embedding space than this instance.",
        prepared.noteId,
      );
    }
    const identities = new Set<string>();
    for (const record of prepared.records) {
      const identity = record.note.id.toLowerCase();
      if (identities.has(identity)) {
        throw insertionFailure(
          operation,
          "input",
          `The insertion plan repeats the note identity ${record.note.id}.`,
          prepared.noteId,
        );
      }
      identities.add(identity);
      if (record.vector.length !== prepared.embeddingSpace.dimensions) {
        throw insertionFailure(
          operation,
          "input",
          "The insertion plan contains a vector that does not match its declared embedding " +
            "space.",
          prepared.noteId,
        );
      }
    }
    const incoming = prepared.records.find(
      (record) =>
        record.note.id.toLowerCase() === prepared.noteId.toLowerCase(),
    );
    if (incoming === undefined) {
      throw insertionFailure(
        operation,
        "input",
        "The insertion plan does not contain its incoming note.",
        prepared.noteId,
      );
    }
    return prepared;
  }

  /** Apply the already validated, detached records in insertion order. */
  async #applyPlan(
    operation: "add" | "apply",
    prepared: InsertionPlan,
  ): Promise<Note> {
    const incoming = prepared.records.find(
      (record) =>
        record.note.id.toLowerCase() === prepared.noteId.toLowerCase(),
    )!;
    await this.#persist(operation, prepared.records, prepared.noteId);
    return detachNote(incoming.note);
  }

  async #construct(
    operation: "add" | "prepare",
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
      throw insertionFailure(
        operation,
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
      throw insertionFailure(
        operation,
        "construct",
        "The construction response does not satisfy the documented contract.",
        noteId,
        cause,
      );
    }
  }

  async #embed(
    operation: EmbeddingOperation,
    text: string,
    noteId: string,
  ): Promise<number[]> {
    let vector: unknown;
    try {
      vector = await this.#embedder.embed(text);
    } catch (cause) {
      throw insertionFailure(
        operation,
        "embed",
        "The embedder failed to produce a vector for the note text.",
        noteId,
        cause,
      );
    }
    // A provider that violates its declared space is rejected before the write attempt, so an
    // unusable vector is reported as an unchanged failure instead of an uncertain write.
    const parsed = parseProviderVector(vector, this.#embedder.space.dimensions);
    if (!("vector" in parsed)) {
      throw insertionFailure(
        operation,
        "embed",
        parsed.reason,
        noteId,
        parsed.cause,
      );
    }
    return parsed.vector;
  }

  /** Embed one search query as supplied and validate the provider vector against its space. */
  async #queryVector(query: string): Promise<number[]> {
    let vector: unknown;
    try {
      vector = await this.#embedder.embed(query);
    } catch (cause) {
      throw retrievalFailure(
        "search",
        "embed",
        "The embedder failed to produce a vector for the search query.",
        cause,
      );
    }
    const parsed = parseProviderVector(vector, this.#embedder.space.dimensions);
    if (!("vector" in parsed)) {
      throw retrievalFailure("search", "embed", parsed.reason, parsed.cause);
    }
    return parsed.vector;
  }

  /** Run one store read, reporting a provider failure as a read-stage operation error. */
  async #read<T>(
    operation: RetrievalOperation,
    read: () => Promise<T>,
    reason: string,
  ): Promise<T> {
    try {
      return await read();
    } catch (cause) {
      throw retrievalFailure(operation, "read", reason, cause);
    }
  }

  async #nearest(
    operation: "add" | "prepare",
    vector: number[],
    noteId: string,
  ): Promise<Match[]> {
    try {
      return await this.#store.nearest(vector, this.#neighbors);
    } catch (cause) {
      throw insertionFailure(
        operation,
        "candidates",
        "The note store failed to return nearest neighbors.",
        noteId,
        cause,
      );
    }
  }

  async #evolve(
    operation: "add" | "prepare",
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
      throw insertionFailure(
        operation,
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
      throw insertionFailure(
        operation,
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
    operation: "add" | "prepare",
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
        throw insertionFailure(
          operation,
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
      prepared.push({
        note: revised,
        vector: await this.#embed(operation, text, noteId),
      });
    }
    return prepared;
  }

  /**
   * Issue the single batch write. A rejected write attempt is reported as uncertain: the provider
   * may have applied part of the batch, and Memory never attempts a rollback.
   */
  async #persist(
    operation: "add" | "apply",
    records: EmbeddedNote[],
    noteId: string,
  ): Promise<void> {
    try {
      await this.#store.put(records);
    } catch (cause) {
      throw new MemoryError({
        operation,
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
