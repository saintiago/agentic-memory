/**
 * Durable ingestion queue public contract: concurrent submissions with source-key
 * deduplication, one collection writer, retry and status reporting, persisted insertion plans and
 * restart replay, idempotent legacy receipt migration, receipt traversal, explicit failed-receipt
 * recovery and reviewed context corrections.
 *
 * See docs/ingestion-queue.md and docs/architecture.md#public-contracts.
 */

export {
  legacyImportResultSchema,
  legacyReceiptSchema,
  queueBindingSchema,
  queueObservationSchema,
  queueReceiptSchema,
  queueReceiptPageSchema,
  queueRecoveryEvidenceSchema,
  queueRecoveryRequestSchema,
  queueRecoverySchema,
  queueReceiptStatuses,
  queueSubmissionSchema,
  queueStatusSchema,
  reconcileOutcomeSchema,
} from "./contract.js";
export type {
  LegacyImportResult,
  LegacyReceipt,
  QueueBinding,
  QueueObservation,
  QueueReceipt,
  QueueReceiptPage,
  QueueReceiptStatus,
  QueueRecovery,
  QueueRecoveryEvidence,
  QueueRecoveryRequest,
  QueueSubmission,
  QueueStatus,
  ReconcileOutcome,
} from "./contract.js";
export {
  QueueBindingError,
  QueueClosedError,
  QueueConflictError,
  QueueReceiptNotFoundError,
  QueueRequestError,
  QueueStateConflictError,
  QueueWorkerLockedError,
} from "./errors.js";
export { openIngestionQueue } from "./queue.js";
export type {
  IngestionQueue,
  IngestionQueueOptions,
  MemoryPreparer,
} from "./queue.js";
