/**
 * The values exchanged between the queue's journal client and its journal thread: the durable
 * record shapes, the operations the client asks for, and the failure reports the client revives as
 * the queue's typed errors. This module holds types only, so the thread can import it without a
 * runtime dependency on the rest of the component.
 *
 * See docs/ingestion-queue.md#durable-acceptance-and-ordering and #crash-recovery.
 */
import type { JsonValue } from "../note-store/index.js";
import type {
  LegacyReceipt,
  QueueObservation,
  QueueRecoveryEvidence,
  QueueReceiptStatus,
  ReconcileOutcome,
} from "./contract.js";

/** One receipt as the journal stores it; `plan` is the serialized insertion plan when durable. */
export interface JournalRecord {
  readonly sequence: number;
  readonly receiptId: string;
  readonly sourceKey: string;
  readonly noteId: string;
  readonly status: QueueReceiptStatus;
  readonly content: string;
  readonly timestamp: string;
  readonly provenance: Record<string, JsonValue> | undefined;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly attemptCount: number;
  readonly nextRetryAt: string | undefined;
  readonly lastError: string | undefined;
  readonly storedAt: string | undefined;
  readonly plan: string | undefined;
  /** Retained evidence of each effective recovery, oldest first; absent when there are none. */
  readonly recoveries: QueueRecoveryEvidence[] | undefined;
  /**
   * Whether preparation committed a complete plan for this receipt at least once. A receipt
   * without a plan but with this evidence lost a committed plan, so the queue must not prepare
   * again; only reconciliation clears the evidence.
   */
  readonly planCommitted: boolean;
  /**
   * Whether an outcome the queue cannot resolve by itself — a legacy uncertainty — forbids every
   * collection write until an operator reconciles this receipt.
   */
  readonly requiresReconciliation: boolean;
  /** Whether an operator already decided this receipt's outcome explicitly. */
  readonly reconciled: boolean;
}

/**
 * The one pending context-correction slot, while the journal holds it. A missing plan is
 * committed-plan evidence with lost data, so the queue blocks instead of preparing again.
 */
export interface PendingCorrection {
  readonly noteId: string;
  readonly plan: string | undefined;
  readonly attemptCount: number;
  readonly nextRetryAt: string | undefined;
  readonly lastError: string | undefined;
  readonly updatedAt: string;
}

/** One failure a worker recorded for a receipt. */
export interface JournalFailure {
  readonly status: Extract<
    QueueReceiptStatus,
    "retrying" | "failed" | "blocked"
  >;
  readonly nextRetryAt: string | undefined;
  readonly lastError: string;
}

/** One failed correction application attempt; the slot carries the cumulative count. */
export interface JournalCorrectionFailure {
  readonly nextRetryAt: string | undefined;
  readonly lastError: string;
}

/** Receipt counts and the oldest pending acceptance, for status reporting. */
export interface JournalStatus {
  readonly counts: Record<QueueReceiptStatus, number>;
  readonly oldestPendingAt: string | undefined;
  /**
   * The global reconciliation diagnostic, the pending correction's diagnostic, otherwise the
   * oldest pending receipt's error.
   */
  readonly pendingError: string | undefined;
  /** The pending context correction's selected note and safe diagnostic, while it exists. */
  readonly correction: { noteId: string; lastError?: string } | undefined;
}

/** The journal bound to the version, representation and binding of its first handle. */
export interface ExpectedJournalMetadata {
  /** The journal schema version this build can reopen, as stored text. */
  readonly journalVersion: string;
  readonly representation: string;
  readonly binding: JsonValue;
}

/**
 * One operation the client asks the journal thread to perform. A request carries the operation and
 * its durable inputs; the thread replies with the operation's result or a failure report.
 */
export type JournalOperation =
  | {
      readonly operation: "open";
      readonly path: string;
      readonly expected: ExpectedJournalMetadata;
    }
  | { readonly operation: "upgrade" }
  | { readonly operation: "recheckUpgrade" }
  | {
      readonly operation: "submit";
      readonly observation: QueueObservation;
      readonly now: string;
    }
  | {
      readonly operation: "importLegacy";
      readonly records: readonly LegacyReceipt[];
      readonly now: string;
    }
  | { readonly operation: "byId"; readonly receiptId: string }
  | {
      readonly operation: "pageReceipts";
      readonly limit: number;
      readonly cursor: string | undefined;
    }
  | { readonly operation: "nextPending" }
  | { readonly operation: "unresolvedReconciliation" }
  | {
      readonly operation: "claim";
      readonly sequence: number;
      readonly now: string;
    }
  | {
      readonly operation: "savePlan";
      readonly sequence: number;
      readonly plan: string;
      readonly now: string;
    }
  | {
      readonly operation: "markStored";
      readonly sequence: number;
      readonly noteId: string;
      readonly now: string;
    }
  | {
      readonly operation: "markFailure";
      readonly sequence: number;
      readonly failure: JournalFailure;
      readonly now: string;
    }
  | {
      readonly operation: "reconcile";
      readonly receiptId: string;
      readonly outcome: ReconcileOutcome;
      readonly now: string;
    }
  | {
      readonly operation: "recoverFailed";
      readonly receiptId: string;
      readonly expectedAttemptCount: number;
      readonly now: string;
    }
  | { readonly operation: "correction" }
  | { readonly operation: "correctionRefusal" }
  | {
      readonly operation: "saveCorrection";
      readonly noteId: string;
      readonly plan: string;
      readonly now: string;
    }
  | { readonly operation: "beginCorrectionAttempt"; readonly now: string }
  | {
      readonly operation: "markCorrectionFailure";
      readonly failure: JournalCorrectionFailure;
      readonly now: string;
    }
  | { readonly operation: "clearCorrection" }
  | { readonly operation: "status" }
  | { readonly operation: "close" };

/** One request as it travels to the journal thread: the operation and its correlation identity. */
export type JournalRequest = JournalOperation & { readonly id: number };

/**
 * A failure as the journal thread reports it: a conflict, a binding mismatch, a rejected request,
 * or an unexpected storage failure. The client turns each report into the queue's typed error.
 */
export type JournalFailureReport =
  | { readonly kind: "conflict"; readonly sourceKey: string }
  | { readonly kind: "state"; readonly reason: string }
  | { readonly kind: "notFound"; readonly receiptId: string }
  | { readonly kind: "binding"; readonly reason: string }
  | { readonly kind: "request"; readonly reason: string }
  | {
      readonly kind: "storage";
      readonly name: string;
      readonly message: string;
    };

/** One reply of the journal thread: the operation's result or its failure report. */
export type JournalResponse =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly failure: JournalFailureReport };
