/**
 * Public schemas and types of the durable ingestion queue: the observations a producer submits,
 * the receipts it looks up, the binding a queue owns and the legacy records migration imports.
 *
 * See docs/ingestion-queue.md.
 */
import { z } from "zod";

import type { EmbeddingSpace } from "../embeddings/index.js";
import { jsonValueSchema, type JsonValue } from "../note-store/index.js";

/**
 * Receipt statuses. `queued`, `processing` and `retrying` are pending work, `blocked` needs
 * operator action or a corrected environment, and `stored` and `failed` are terminal.
 */
export const queueReceiptStatuses = [
  "queued",
  "processing",
  "retrying",
  "stored",
  "failed",
  "blocked",
] as const;

export type QueueReceiptStatus = (typeof queueReceiptStatuses)[number];

const nonWhitespaceText = (description: string) =>
  z
    .string()
    .refine(
      (value) => /\S/.test(value),
      `${description} must contain non-whitespace text.`,
    );

const instant = (description: string) =>
  z.iso.datetime({
    offset: true,
    message: `${description} must be an ISO 8601 instant with a timezone.`,
  });

/** Provenance is opaque to the queue; it is only required to be a JSON object. */
const provenanceSchema: z.ZodType<Record<string, JsonValue>> =
  jsonValueSchema.refine(
    (value): value is Record<string, JsonValue> =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
    "Provenance must be a JSON object.",
  );

/** One caller-owned observation offered for durable acceptance. */
export const queueObservationSchema = z.strictObject({
  sourceKey: z.string().min(1, "A source key must be a nonempty string."),
  content: nonWhitespaceText("Content"),
  timestamp: instant("A timestamp").optional(),
  provenance: provenanceSchema.optional(),
});

export type QueueObservation = z.infer<typeof queueObservationSchema>;

/**
 * The collection, embedding space and representation a queue owns. All producers of that
 * collection share one queue, and a journal is bound to the values it first accepted.
 */
export const queueBindingSchema = z.strictObject({
  endpoint: z.string().min(1, "A database endpoint must be nonempty."),
  collection: z.string().min(1, "A collection name must be nonempty."),
  embeddingSpace: z.strictObject({
    id: z.string().min(1, "An embedding-space ID must be nonempty."),
    dimensions: z.int().positive("Dimensions must be a positive safe integer."),
    distance: z.literal("Cosine"),
  }) satisfies z.ZodType<EmbeddingSpace>,
});

export type QueueBinding = z.infer<typeof queueBindingSchema>;

/**
 * One accepted observation's public state. `noteId` appears once the note is stored, because an
 * accepted observation is not yet searchable.
 */
export const queueReceiptSchema = z.strictObject({
  id: z.uuid(),
  sourceKey: z.string().min(1),
  status: z.enum(queueReceiptStatuses),
  acceptedAt: instant("An acceptance time"),
  updatedAt: instant("An update time"),
  attemptCount: z.int().nonnegative(),
  nextRetryAt: instant("A retry time").optional(),
  lastError: z.string().min(1).optional(),
  noteId: z.uuid().optional(),
});

export type QueueReceipt = z.infer<typeof queueReceiptSchema>;

/**
 * The outcome of one submission: the accepted receipt fields plus whether this call created the
 * receipt. A producer only learns whether it accepted new work; the receipt itself is unchanged.
 */
export const queueSubmissionSchema = queueReceiptSchema.extend({
  created: z.boolean(),
});

export type QueueSubmission = z.infer<typeof queueSubmissionSchema>;

/** Receipt outcomes and pending backlog of one queue. Counts include every accepted receipt. */
export const queueStatusSchema = z.strictObject({
  worker: z.enum(["running", "stopped"]),
  accepted: z.int().nonnegative(),
  backlog: z.int().nonnegative(),
  counts: z.strictObject({
    queued: z.int().nonnegative(),
    processing: z.int().nonnegative(),
    retrying: z.int().nonnegative(),
    stored: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    blocked: z.int().nonnegative(),
  }),
  oldestPendingAt: instant("An acceptance time").optional(),
  oldestPendingAgeMs: z.int().nonnegative().optional(),
  lastError: z.string().min(1).optional(),
});

export type QueueStatus = z.infer<typeof queueStatusSchema>;

/**
 * One preserved legacy receipt offered for migration. `pending` observations are known not to have
 * written, `stored` ones keep their completed identity, and `uncertain` in-flight records without
 * a durable plan require reconciliation before further collection writes.
 */
export const legacyReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    sourceKey: z.string().min(1),
    content: nonWhitespaceText("Content"),
    timestamp: instant("A timestamp").optional(),
    provenance: provenanceSchema.optional(),
    receiptId: z.uuid().optional(),
    acceptedAt: instant("An acceptance time").optional(),
  }),
  z.strictObject({
    status: z.literal("stored"),
    sourceKey: z.string().min(1),
    content: nonWhitespaceText("Content"),
    timestamp: instant("A timestamp").optional(),
    provenance: provenanceSchema.optional(),
    receiptId: z.uuid().optional(),
    acceptedAt: instant("An acceptance time").optional(),
    noteId: z.uuid(),
    storedAt: instant("A storage time").optional(),
  }),
  z.strictObject({
    status: z.literal("uncertain"),
    sourceKey: z.string().min(1),
    content: nonWhitespaceText("Content"),
    timestamp: instant("A timestamp").optional(),
    provenance: provenanceSchema.optional(),
    receiptId: z.uuid().optional(),
    acceptedAt: instant("An acceptance time").optional(),
    noteId: z.uuid().optional(),
  }),
]);

export type LegacyReceipt = z.infer<typeof legacyReceiptSchema>;

/** The idempotent outcome of importing a batch of legacy receipts. */
export const legacyImportResultSchema = z.strictObject({
  imported: z.int().nonnegative(),
  existing: z.int().nonnegative(),
  blocked: z.int().nonnegative(),
});

export type LegacyImportResult = z.infer<typeof legacyImportResultSchema>;

/**
 * The operator's decision for one blocked receipt. `stored` records a completed identity;
 * `not-written` clears the unusable plan so the worker may prepare and apply again.
 */
export const reconcileOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("stored"), noteId: z.uuid() }),
  z.strictObject({ outcome: z.literal("not-written") }),
]);

export type ReconcileOutcome = z.infer<typeof reconcileOutcomeSchema>;
