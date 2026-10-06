/**
 * Typed failures of memory operations. A failure names the operation, the stage that failed and
 * whether stored notes are known to be unchanged or whether a rejected write attempt left their
 * state uncertain.
 *
 * See docs/memory.md#failures.
 */

/**
 * The memory operations a host can invoke. `prepare` and `apply` are the durable insertion path
 * the ingestion queue consumes; `add` is the same insertion performed in one call, and
 * `prepareContextCorrection` prepares a reviewed replacement of one existing note while
 * `prepareLinkCorrection` prepares a reviewed removal of outgoing links.
 */
export type MemoryOperation =
  | "add"
  | "get"
  | "page"
  | "search"
  | "prepare"
  | "prepareContextCorrection"
  | "prepareLinkCorrection"
  | "apply";

/**
 * The stage an operation reached: input validation, construction or evolution generation, an
 * embedding, candidate selection, the batch write or a read.
 */
export type MemoryStage =
  | "input"
  | "construct"
  | "embed"
  | "candidates"
  | "evolve"
  | "persist"
  | "read";

/** Whether stored notes are known to be unchanged, or a write attempt left an uncertain outcome. */
export type MemoryPersistence = "unchanged" | "uncertain";

/**
 * What a failed context- or link-correction read established about the inspected proposal.
 * `stale` means the read succeeded and confirmed the proposal no longer matches the stored note;
 * `unknown` means the read itself failed, so current storage was not observed.
 */
export type CorrectionReadOutcome = "stale" | "unknown";

/** The details of one memory failure. */
export interface MemoryErrorDetails {
  readonly operation: MemoryOperation;
  readonly stage: MemoryStage;
  readonly persistence: MemoryPersistence;
  /**
   * A safe explanation of the failure. It carries no credentials, complete prompts or source
   * text; the underlying failure stays attached as `cause` for diagnosis.
   */
  readonly reason: string;
  /** The identity an add allocated before it failed. */
  readonly noteId?: string;
  /**
   * The read outcome of a failed context- or link-correction preparation, so a maintenance owner
   * can distinguish a confirmed stale proposal from a read that could not observe storage.
   */
  readonly readOutcome?: CorrectionReadOutcome;
  /** The prepared batch of a rejected write attempt, so the host can reconcile its state. */
  readonly affectedNoteIds?: readonly string[];
  /** The underlying provider or validation failure, preserved for diagnosis. */
  readonly cause?: unknown;
}

/** A typed failure of one memory operation. */
export class MemoryError extends Error {
  declare readonly operation: MemoryOperation;
  declare readonly stage: MemoryStage;
  declare readonly persistence: MemoryPersistence;
  /** The safe failure description, without credentials, prompts or source text. */
  declare readonly reason: string;
  declare readonly noteId?: string;
  /** The confirmed staleness or unobserved read of one failed correction preparation. */
  declare readonly readOutcome?: CorrectionReadOutcome;
  declare readonly affectedNoteIds?: readonly string[];

  constructor(details: MemoryErrorDetails) {
    const target =
      details.noteId === undefined ? "" : ` for note ${details.noteId}`;
    super(
      `The ${details.operation} operation failed at the ${details.stage} stage${target}: ` +
        details.reason,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "MemoryError";
    this.operation = details.operation;
    this.stage = details.stage;
    this.persistence = details.persistence;
    this.reason = details.reason;
    if (details.noteId !== undefined) {
      this.noteId = details.noteId;
    }
    if (details.readOutcome !== undefined) {
      this.readOutcome = details.readOutcome;
    }
    if (details.affectedNoteIds !== undefined) {
      this.affectedNoteIds = [...details.affectedNoteIds];
    }
  }
}
