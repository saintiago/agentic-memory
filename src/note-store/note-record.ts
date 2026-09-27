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

/** Metadata is JSON; non-finite numbers, functions and undefined are not JSON. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

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
    metadata: z.record(z.string(), jsonValueSchema).optional(),
  })
  .superRefine((note, context) => {
    const seen = new Set<string>();
    note.links.forEach((link, index) => {
      if (link === note.id) {
        context.addIssue({
          code: "custom",
          path: ["links", index],
          message: "A note must not link to itself.",
        });
      }
      if (seen.has(link)) {
        context.addIssue({
          code: "custom",
          path: ["links", index],
          message: "Links must be distinct.",
        });
      }
      seen.add(link);
    });
  });

export type Note = z.infer<typeof noteSchema>;

/** A note and the embedding that represents its content together with its semantic attributes. */
export const embeddedNoteSchema = z.strictObject({
  note: noteSchema,
  vector: z.array(z.number()),
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
