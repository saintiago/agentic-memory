/**
 * The durable insertion plan exchanged between Memory and the ingestion queue. Preparation
 * produces one immutable, versioned plan without writing notes; application validates the plan
 * against its declared version and embedding space and writes exactly the supplied records.
 *
 * See docs/memory.md#durable-preparation-and-application.
 */
import { z } from "zod";

import type { EmbeddingSpace } from "../embeddings/index.js";
import { embeddedNoteSchema, noteIdSchema } from "../note-store/index.js";
import { representationVersion } from "./representation.js";

/** The plan schema version. A plan declaring another version is not applicable. */
export const insertionPlanVersion = 1;

/** The embedding-space descriptor a plan was prepared against; it is data, not an encoder import. */
const planSpaceSchema: z.ZodType<EmbeddingSpace> = z.strictObject({
  id: z.string().min(1, "An embedding-space ID must be nonempty."),
  dimensions: z.int().positive("Dimensions must be a positive safe integer."),
  distance: z.literal("Cosine"),
});

/**
 * A complete insertion decision: the fixed incoming note identity, the declared representation
 * and embedding space it was prepared against, and the exact records to apply. The incoming note
 * is one of the records, so application never regenerates attributes, vectors or timestamps.
 */
export const insertionPlanSchema = z.strictObject({
  version: z.literal(insertionPlanVersion),
  representation: z.literal(representationVersion),
  embeddingSpace: planSpaceSchema,
  noteId: noteIdSchema,
  records: z.array(embeddedNoteSchema).min(1),
});

export type InsertionPlan = z.infer<typeof insertionPlanSchema>;
