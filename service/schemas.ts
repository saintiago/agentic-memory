/**
 * The owned runtime schemas of the documented `/v1` API: every accepted request and every served
 * response is validated against these shapes, and the same module types the HTTP client. The
 * persisted record and search shapes come from the public component contracts, so the service can
 * neither invent nor silently reshape them.
 *
 * See docs/service.md#api.
 */
import { z } from "zod";

import {
  queueObservationSchema,
  queueRecoveryRequestSchema,
  queueRecoverySchema,
  queueReceiptSchema,
  queueStatusSchema,
} from "../src/ingestion-queue/index.js";
import { embeddedNoteSchema, noteSchema } from "../src/note-store/index.js";

/** `POST /v1/observations`: one caller-owned observation. */
export const observationRequestSchema = queueObservationSchema;

/** `GET /v1/receipts/:id` and the submission response body: one accepted observation's state. */
export const receiptSchema = queueReceiptSchema;

/** One opaque URL-safe continuation token; clients return it unchanged. */
export const cursorTokenSchema = z.string().min(1);

/** `GET /v1/receipts`: one acceptance-sequence page of current receipts. */
export const receiptPageSchema = z.strictObject({
  receipts: z.array(receiptSchema),
  cursor: cursorTokenSchema.optional(),
});

/** `POST /v1/receipts/:id/recover`: the operator's inspected failed-attempt count. */
export const recoveryRequestSchema = queueRecoveryRequestSchema;

/** The recovery response: the current receipt and whether this request requeued it. */
export const recoveryResponseSchema = queueRecoverySchema;

/** `POST /v1/search`: query text and the public retrieval limits. */
export const searchRequestSchema = z.strictObject({
  query: z.string(),
  limit: z.number().int().positive().optional(),
  linkedLimit: z.number().int().nonnegative().optional(),
});

/** One retrieval result: a ranked direct match or a bounded linked addition. */
export const searchResultSchema = z.union([
  z.strictObject({
    note: noteSchema,
    via: z.literal("match"),
    score: z.number(),
  }),
  z.strictObject({ note: noteSchema, via: z.literal("link") }),
]);

/** `POST /v1/search` response: the request time and Memory's complete ordered results. */
export const searchResponseSchema = z.strictObject({
  searchedAt: z.iso.datetime({ offset: true }),
  results: z.array(searchResultSchema),
});

/** `GET /v1/notes`: one page of current notes with an optional continuation cursor. */
export const notesPageSchema = z.strictObject({
  notes: z.array(noteSchema),
  cursor: cursorTokenSchema.optional(),
});

/** `GET /v1/inspection/records`: complete notes and stored vectors of one embedding space. */
export const inspectionPageSchema = z.strictObject({
  records: z.array(embeddedNoteSchema),
  cursor: cursorTokenSchema.optional(),
  embeddingSpaceId: z.string().min(1),
});

/** The capability availability the service reports separately for each documented purpose. */
export const serviceAvailabilitySchema = z.strictObject({
  submission: z.boolean(),
  retrieval: z.boolean(),
  ingestion: z.boolean(),
});

/** `GET /v1/status`: collection and space identity, availability and queue outcomes. */
export const serviceStatusSchema = z.strictObject({
  collection: z.string().min(1),
  embeddingSpace: z.strictObject({
    id: z.string().min(1),
    dimensions: z.number().int().positive(),
    distance: z.literal("Cosine"),
  }),
  availability: serviceAvailabilitySchema,
  queue: queueStatusSchema.optional(),
  error: z.string().min(1).optional(),
});

/** Every failure body carries one sanitized, machine-readable error. */
export const serviceErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
});

export type ObservationRequest = z.infer<typeof observationRequestSchema>;
export type ReceiptBody = z.infer<typeof receiptSchema>;
export type ReceiptPage = z.infer<typeof receiptPageSchema>;
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;
export type RecoveryResponse = z.infer<typeof recoveryResponseSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type NotesPage = z.infer<typeof notesPageSchema>;
export type InspectionPage = z.infer<typeof inspectionPageSchema>;
export type ServiceAvailability = z.infer<typeof serviceAvailabilitySchema>;
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type ServiceErrorBody = z.infer<typeof serviceErrorSchema>;
