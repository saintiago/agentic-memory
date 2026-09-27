import { z } from "zod";

/**
 * The persisted note record contract owned by NoteStore. Each schema is defined once and the
 * exported types are derived from it, so runtime validation and static types cannot disagree.
 *
 * See docs/note-store.md#record-validation.
 */

/** A JSON value accepted in optional note metadata. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface JsonIssue {
  readonly message: string;
  readonly path: ReadonlyArray<string | number>;
}

/** JSON text produces plain records, so class instances, dates, maps and sets are not objects. */
const isJsonObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Reports every reason `value` is not JSON. Only the containers on the current path count as
 * ancestors, so a value shared by sibling properties stays valid while a cycle is rejected.
 */
const findJsonIssues = (
  value: unknown,
  requireObject: boolean,
): JsonIssue[] => {
  if (requireObject && !isJsonObject(value)) {
    return [{ message: "Metadata must be a JSON object.", path: [] }];
  }
  const issues: JsonIssue[] = [];
  const visit = (
    node: unknown,
    path: ReadonlyArray<string | number>,
    ancestors: ReadonlySet<object>,
  ): void => {
    if (
      node === null ||
      typeof node === "boolean" ||
      typeof node === "string"
    ) {
      return;
    }
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        issues.push({ message: "JSON numbers must be finite.", path });
      }
      return;
    }
    if (Array.isArray(node)) {
      const elements: readonly unknown[] = node;
      visitContainer(node, elements.entries(), path, ancestors);
      return;
    }
    if (isJsonObject(node)) {
      visitContainer(node, Object.entries(node), path, ancestors);
      return;
    }
    issues.push({ message: "Expected a JSON value.", path });
  };
  const visitContainer = (
    container: object,
    children: Iterable<readonly [string | number, unknown]>,
    path: ReadonlyArray<string | number>,
    ancestors: ReadonlySet<object>,
  ): void => {
    if (ancestors.has(container)) {
      issues.push({ message: "JSON values must not contain cycles.", path });
      return;
    }
    const nested = new Set(ancestors).add(container);
    for (const [key, child] of children) {
      visit(child, [...path, key], nested);
    }
  };

  visit(value, [], new Set());
  return issues;
};

/**
 * Copies an already validated JSON tree. Objects are rebuilt from entries so own `__proto__`
 * properties survive, and defining each key as data cannot mutate any prototype.
 */
const cloneJsonValue = (value: unknown): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((element: unknown) => cloneJsonValue(element));
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, element]) => [
        key,
        cloneJsonValue(element),
      ]),
    );
  }
  return value as JsonValue;
};

/**
 * Builds a JSON schema from the structural rules. The input is `unknown` because no single Zod
 * type covers every JSON value, and parsing returns a detached copy of the validated tree.
 */
const jsonSchema = <Output extends JsonValue>(
  requireObject: boolean,
): z.ZodType<Output> =>
  z
    .unknown()
    .superRefine((value, context) => {
      for (const issue of findJsonIssues(value, requireObject)) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: [...issue.path],
        });
      }
    })
    // The refinement rejects every value this copy cannot represent as `Output`.
    .transform((value) => cloneJsonValue(value) as Output);

/** Any JSON value: non-finite numbers, functions, undefined and cycles are rejected. */
export const jsonValueSchema: z.ZodType<JsonValue> = jsonSchema(false);

/** Metadata is an optional JSON object whose keys note identity rules do not reserve. */
const metadataSchema: z.ZodType<Record<string, JsonValue>> = jsonSchema(true);

const hasNonWhitespaceText = (value: string): boolean => /\S/.test(value);
const nonWhitespaceText = (description: string) =>
  z
    .string()
    .refine(
      hasNonWhitespaceText,
      `${description} must contain non-whitespace text.`,
    );
const nonemptyText = (description: string) =>
  z.string().min(1, `${description} must be nonempty.`);

/** Note identifiers are UUIDs; links reference other notes by UUID. */
export const noteIdSchema = z.uuid();

/** Semantic attributes generated for a note: a concise context, keywords and broader tags. */
export const attributesSchema = z.strictObject({
  context: nonWhitespaceText("Context"),
  keywords: z.array(nonemptyText("A keyword")),
  tags: z.array(nonemptyText("A tag")),
});

export type Attributes = z.infer<typeof attributesSchema>;

/**
 * A complete current note. Immutable source fields and generated semantic attributes are both
 * part of the record; strings and array order are preserved rather than normalized.
 */
export const noteSchema = z
  .strictObject({
    id: noteIdSchema,
    content: nonWhitespaceText("Content"),
    timestamp: z.iso.datetime({ offset: true }),
    ...attributesSchema.shape,
    links: z.array(noteIdSchema),
    metadata: metadataSchema.optional(),
  })
  .superRefine((note, context) => {
    // UUID identity is case-insensitive, while the supplied spellings are preserved as written.
    const noteId = note.id.toLowerCase();
    const seen = new Set<string>();
    note.links.forEach((link, index) => {
      const linkId = link.toLowerCase();
      if (linkId === noteId) {
        context.addIssue({
          code: "custom",
          path: ["links", index],
          message: "A note must not link to itself.",
        });
      }
      if (seen.has(linkId)) {
        context.addIssue({
          code: "custom",
          path: ["links", index],
          message: "Links must be distinct.",
        });
      }
      seen.add(linkId);
    });
  });

export type Note = z.infer<typeof noteSchema>;

/**
 * Declared dimensions belong to the collection; the shared record contract is finite components
 * and a nonzero norm, so cosine similarity is always defined. Search vectors satisfy the same
 * contract, so the rule has one home.
 */
export const vectorSchema = z
  .array(z.number())
  .refine(
    (vector) => vector.some((component) => component !== 0),
    "A vector must have nonzero norm.",
  );

/** A note and the embedding that represents its content together with its semantic attributes. */
export const embeddedNoteSchema = z.strictObject({
  note: noteSchema,
  vector: vectorSchema,
});

export type EmbeddedNote = z.infer<typeof embeddedNoteSchema>;

/** A similarity search result. Scores are finite; ordering is the store's responsibility. */
export const matchSchema = z.strictObject({
  note: noteSchema,
  score: z.number(),
});

export type Match = z.infer<typeof matchSchema>;

/** An opaque pagination cursor; it belongs to the current collection and provider. */
export const cursorSchema = z.union([z.string(), z.number()]);

export type Cursor = z.infer<typeof cursorSchema>;

/** A page of current notes; a missing cursor means the traversal is complete. */
export const pageSchema = z.strictObject({
  notes: z.array(noteSchema),
  cursor: cursorSchema.optional(),
});

export type Page = z.infer<typeof pageSchema>;
