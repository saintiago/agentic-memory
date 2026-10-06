/**
 * The core of the local memory service behind the `/v1` API: durable submission through the
 * ingestion queue, retrieval and pagination through the shared provider stack, the paginated
 * stored-vector inspection the dashboard consumes, and availability reporting. It owns the HTTP
 * failure classification; route parsing and serialization stay in the HTTP layer.
 *
 * See docs/service.md.
 */
import {
  MemoryError,
  QueueClosedError,
  QueueConflictError,
  QueueReceiptNotFoundError,
  QueueRequestError,
  QueueStateConflictError,
  type Cursor,
  type EmbeddingSpace,
  type IngestionQueue,
  type Note,
  type QueueObservation,
  type QueueReceipt,
  type QueueRecovery,
  type QueueRecoveryRequest,
  type QueueStatus,
  type QueueSubmission,
  type SearchOptions,
} from "../src/index.js";
import { encodeCursor } from "./cursor.js";
import {
  conflict,
  internal,
  invalidRequest,
  notFound,
  overloaded,
  ServiceFailure,
  unavailable,
} from "./errors.js";
import {
  ProviderRuntime,
  ProviderUnavailableError,
  type ServiceEngine,
} from "./providers.js";
import { InferenceOverloadedError } from "./scheduler.js";
import {
  inspectionPageSchema,
  notesPageSchema,
  receiptPageSchema,
  recoveryResponseSchema,
  serviceStatusSchema,
  type InspectionPage,
  type NotesPage,
  type ReceiptPage,
  type SearchResponse,
  type ServiceStatus,
} from "./schemas.js";

export interface MemoryServiceOptions {
  readonly queue: IngestionQueue;
  readonly providers: ProviderRuntime;
  readonly collection: string;
  readonly embeddingSpace: EmbeddingSpace;
  readonly now?: () => Date;
}

/** The default page size of the read and inspection routes. */
const defaultPageLimit = 100;

/**
 * One service instance's behavior. It never writes through the providers directly: ingestion
 * commits to the queue, and the queue's supervised worker applies plans through the shared stack.
 */
export class MemoryService {
  readonly #queue: IngestionQueue;
  readonly #providers: ProviderRuntime;
  readonly #collection: string;
  readonly #embeddingSpace: EmbeddingSpace;
  readonly #now: () => Date;
  #stopping = false;

  constructor(options: MemoryServiceOptions) {
    this.#queue = options.queue;
    this.#providers = options.providers;
    this.#collection = options.collection;
    this.#embeddingSpace = options.embeddingSpace;
    this.#now = options.now ?? (() => new Date());
  }

  /** Whether the service stopped admitting requests for shutdown. */
  get stopping(): boolean {
    return this.#stopping;
  }

  /** Stop admitting new requests; in-flight work settles separately. */
  beginShutdown(): void {
    this.#stopping = true;
  }

  /** Accept one observation durably, or return the receipt of an identical resubmission. */
  async submit(observation: QueueObservation): Promise<QueueSubmission> {
    this.#assertAdmitting();
    try {
      return await this.#queue.submit(observation);
    } catch (cause) {
      throw this.#queueFailure(cause);
    }
  }

  /** Look up one receipt; an unknown identity returns `undefined`. */
  async receipt(id: string): Promise<QueueReceipt | undefined> {
    this.#assertAdmitting();
    try {
      return await this.#queue.receipt(id);
    } catch (cause) {
      throw this.#queueFailure(cause);
    }
  }

  /**
   * Enumerate one acceptance-sequence page of current receipts. The journal serves this without
   * providers, so an operator can inspect outcomes during a provider outage.
   */
  async receipts(limit?: number, cursor?: Cursor): Promise<ReceiptPage> {
    this.#assertAdmitting();
    if (cursor !== undefined && typeof cursor !== "string") {
      throw invalidRequest("The receipt page cursor is not valid.");
    }
    try {
      const page = await this.#queue.pageReceipts(
        limit ?? defaultPageLimit,
        cursor,
      );
      return receiptPageSchema.parse({
        receipts: page.receipts,
        ...(page.cursor === undefined
          ? {}
          : { cursor: encodeCursor(page.cursor) }),
      });
    } catch (cause) {
      throw this.#receiptPageFailure(cause);
    }
  }

  /**
   * Requeue one retained failed receipt after the cause was corrected. The journal performs the
   * transition, so no provider is needed and the response reports durable requeueing, not storage.
   */
  async recover(
    id: string,
    request: QueueRecoveryRequest,
  ): Promise<QueueRecovery> {
    this.#assertAdmitting();
    try {
      return recoveryResponseSchema.parse(
        await this.#queue.recoverFailed(id, request),
      );
    } catch (cause) {
      throw this.#recoveryFailure(cause);
    }
  }

  /** Search stored memories through the shared encoder and store. */
  async search(query: string, options: SearchOptions): Promise<SearchResponse> {
    this.#assertAdmitting();
    const engine = await this.#engine(
      "The memory retrieval capability is unavailable.",
    );
    try {
      const results = await engine.search(query, options);
      return { searchedAt: this.#now().toISOString(), results };
    } catch (cause) {
      throw this.#retrievalFailure(cause, "The search request is not valid.");
    }
  }

  /** Read one complete current note; an unknown identity returns `undefined`. */
  async note(id: string): Promise<Note | undefined> {
    this.#assertAdmitting();
    const engine = await this.#engine(
      "The memory retrieval capability is unavailable.",
    );
    try {
      return await engine.get(id);
    } catch (cause) {
      throw this.#retrievalFailure(cause, "The note ID is not valid.");
    }
  }

  /** Inspect one page of current notes. */
  async notes(limit?: number, cursor?: Cursor): Promise<NotesPage> {
    this.#assertAdmitting();
    const engine = await this.#engine(
      "The memory retrieval capability is unavailable.",
    );
    try {
      const page = await engine.page(limit ?? defaultPageLimit, cursor);
      return notesPageSchema.parse({
        notes: page.notes,
        ...(page.cursor === undefined
          ? {}
          : { cursor: encodeCursor(page.cursor) }),
      });
    } catch (cause) {
      throw this.#retrievalFailure(cause, "The page request is not valid.");
    }
  }

  /** Export one page of complete notes and stored vectors for projection. */
  async inspectionRecords(
    limit?: number,
    cursor?: Cursor,
  ): Promise<InspectionPage> {
    this.#assertAdmitting();
    const engine = await this.#engine(
      "The vector inspection capability is unavailable.",
    );
    const pageLimit = limit ?? defaultPageLimit;
    if (!Number.isSafeInteger(pageLimit) || pageLimit <= 0) {
      throw invalidRequest("The page limit must be a positive safe integer.");
    }
    try {
      const page = await engine.pageEmbedded(pageLimit, cursor);
      return inspectionPageSchema.parse({
        records: page.records,
        ...(page.cursor === undefined
          ? {}
          : { cursor: encodeCursor(page.cursor) }),
        embeddingSpaceId: this.#embeddingSpace.id,
      });
    } catch (cause) {
      if (cause instanceof ServiceFailure) {
        throw cause;
      }
      throw unavailable("The vector inspection capability failed.", cause);
    }
  }

  /** Report collection identity, capability availability and durable queue outcomes. */
  async status(): Promise<ServiceStatus> {
    // Provider availability reflects both initialization and the last operational outcome, so a
    // known database or model outage is never reported as available.
    const capabilities = this.#providers.availability();
    let queue: QueueStatus | undefined;
    let journalError: string | undefined;
    try {
      queue = await this.#queue.status();
    } catch (cause) {
      console.error("[service] the queue status could not be read:", cause);
      journalError = "The durable queue journal is unavailable.";
    }
    const error = this.#providers.error() ?? journalError;
    // A pending context correction holds every later collection write until its committed plan
    // is replayed or an operator resolves it, so ingestion is not available while the slot exists.
    const correctionPending = queue?.contextCorrection !== undefined;
    return serviceStatusSchema.parse({
      collection: this.#collection,
      embeddingSpace: {
        id: this.#embeddingSpace.id,
        dimensions: this.#embeddingSpace.dimensions,
        distance: this.#embeddingSpace.distance,
      },
      availability: {
        submission: queue !== undefined && !this.#stopping,
        retrieval: capabilities.retrieval && !this.#stopping,
        ingestion:
          capabilities.ingestion &&
          !this.#stopping &&
          queue?.worker === "running" &&
          !correctionPending,
      },
      ...(queue === undefined ? {} : { queue }),
      ...(error === undefined ? {} : { error }),
    });
  }

  async #engine(unavailableMessage: string): Promise<ServiceEngine> {
    try {
      return await this.#providers.engine();
    } catch (cause) {
      throw this.#retrievalFailure(cause, unavailableMessage);
    }
  }

  /** Map one queue failure onto the documented HTTP classification. */
  #queueFailure(cause: unknown): ServiceFailure {
    if (cause instanceof ServiceFailure) {
      return cause;
    }
    if (cause instanceof QueueConflictError) {
      return conflict(
        `The source key "${cause.sourceKey}" already holds a different observation.`,
      );
    }
    if (cause instanceof QueueRequestError) {
      return invalidRequest(
        "The observation is not a valid submission.",
        cause,
      );
    }
    if (
      cause instanceof QueueClosedError ||
      cause instanceof ProviderUnavailableError
    ) {
      return unavailable(
        "The durable queue is not accepting work right now.",
        cause,
      );
    }
    return unavailable(
      "The observation could not be accepted durably; retry the identical submission.",
      cause,
    );
  }

  /** Map one receipt-enumeration failure onto validation or capability unavailability. */
  #receiptPageFailure(cause: unknown): ServiceFailure {
    if (cause instanceof ServiceFailure) {
      return cause;
    }
    if (cause instanceof QueueRequestError) {
      return invalidRequest("The receipt page request is not valid.", cause);
    }
    if (cause instanceof QueueClosedError) {
      return unavailable(
        "The durable queue is not accepting work right now.",
        cause,
      );
    }
    return unavailable("The receipt page could not be read.", cause);
  }

  /** Map one recovery failure onto the documented validation, absence and conflict outcomes. */
  #recoveryFailure(cause: unknown): ServiceFailure {
    if (cause instanceof ServiceFailure) {
      return cause;
    }
    if (cause instanceof QueueRequestError) {
      return invalidRequest("The recovery request is not valid.", cause);
    }
    if (cause instanceof QueueReceiptNotFoundError) {
      return notFound("No receipt exists with that ID.");
    }
    if (cause instanceof QueueStateConflictError) {
      return conflict(cause.reason);
    }
    if (cause instanceof QueueClosedError) {
      return unavailable(
        "The durable queue is not accepting work right now.",
        cause,
      );
    }
    return unavailable(
      "The failed observation could not be requeued durably; retry the identical request.",
      cause,
    );
  }

  /** Map one failed retrieval onto validation or capability unavailability. */
  #retrievalFailure(cause: unknown, invalidMessage: string): ServiceFailure {
    if (cause instanceof ServiceFailure) {
      return cause;
    }
    if (cause instanceof ProviderUnavailableError) {
      return unavailable(cause.reason, cause);
    }
    if (cause instanceof InferenceOverloadedError) {
      return overloaded(Math.ceil(cause.retryAfterMs / 1_000));
    }
    if (cause instanceof MemoryError) {
      return cause.stage === "input"
        ? invalidRequest(invalidMessage, cause)
        : unavailable("The memory capability is unavailable.", cause);
    }
    return internal(cause);
  }

  #assertAdmitting(): void {
    if (this.#stopping) {
      throw unavailable("The memory service is shutting down.");
    }
  }
}
