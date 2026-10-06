/**
 * Failure types of the durable ingestion queue. They keep provider text out of public messages and
 * let the service map a failed operation to an HTTP status.
 *
 * See docs/ingestion-queue.md.
 */

/** A source key already holds a different observation, so the submission is a conflict. */
export class QueueConflictError extends Error {
  readonly sourceKey: string;

  constructor(sourceKey: string) {
    super(
      `The source key "${sourceKey}" already holds a different observation.`,
    );
    this.name = "QueueConflictError";
    this.sourceKey = sourceKey;
  }
}

/**
 * The queue's durable state refuses the requested transition: an ineligible failed receipt, a
 * future attempt count, or writer work that must settle first. The reason is a safe operator
 * diagnostic, independent of provider error text.
 */
export class QueueStateConflictError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "QueueStateConflictError";
    this.reason = reason;
  }
}

/** A request named a receipt the queue journal does not hold. */
export class QueueReceiptNotFoundError extends Error {
  readonly receiptId: string;

  constructor(receiptId: string) {
    super(`No queue receipt has the identity ${receiptId}.`);
    this.name = "QueueReceiptNotFoundError";
    this.receiptId = receiptId;
  }
}

/** A rejected submission, receipt lookup or reconciliation request. */
export class QueueRequestError extends Error {
  readonly reason: string;

  constructor(reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "QueueRequestError";
    this.reason = reason;
  }
}

/** The queue's journal declares another database endpoint, collection or embedding space. */
export class QueueBindingError extends Error {
  readonly journalPath: string;

  constructor(journalPath: string, reason: string) {
    super(
      `The ingestion queue journal at ${journalPath} is incompatible with this binding: ` +
        `${reason}.`,
    );
    this.name = "QueueBindingError";
    this.journalPath = journalPath;
  }
}

/** A worker or migration owns this queue. Producers may still submit. */
export class QueueWorkerLockedError extends Error {
  readonly journalPath: string;

  constructor(journalPath: string) {
    super(
      `Another ingestion worker or migration already owns the queue at ${journalPath}.`,
    );
    this.name = "QueueWorkerLockedError";
    this.journalPath = journalPath;
  }
}

/** The queue was closed, so it cannot accept submissions or start a worker. */
export class QueueClosedError extends Error {
  constructor() {
    super("The ingestion queue is closed.");
    this.name = "QueueClosedError";
  }
}
