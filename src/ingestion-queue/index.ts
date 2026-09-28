/**
 * Durable ingestion queue public contract: concurrent submissions with source-key
 * deduplication, one collection writer, retry and status reporting, persisted insertion plans and
 * restart replay, plus idempotent legacy receipt migration.
 *
 * See docs/ingestion-queue.md and docs/architecture.md#public-contracts.
 */

export {
  legacyImportResultSchema,
  legacyReceiptSchema,
  queueBindingSchema,
  queueObservationSchema,
  queueReceiptSchema,
  queueReceiptStatuses,
  queueStatusSchema,
  reconcileOutcomeSchema,
} from "./contract.js";
export type {
  LegacyImportResult,
  LegacyReceipt,
  QueueBinding,
  QueueObservation,
  QueueReceipt,
  QueueReceiptStatus,
  QueueStatus,
  ReconcileOutcome,
} from "./contract.js";
export {
  QueueBindingError,
  QueueClosedError,
  QueueConflictError,
  QueueRequestError,
  QueueWorkerLockedError,
} from "./errors.js";
export { openIngestionQueue } from "./queue.js";
export type {
  IngestionQueue,
  IngestionQueueOptions,
  MemoryPreparer,
} from "./queue.js";
