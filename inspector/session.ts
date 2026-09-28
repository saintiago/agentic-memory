/**
 * Inspection state of the local host: the most recent completed graph view, the paginated export
 * and projection lifecycle behind it, the periodic and manual refresh requests, the disposable
 * coordinate cache and the explicit stored-vector comparison.
 *
 * All storage reads are asynchronous, projection work runs in the injected worker-backed runner,
 * one export/projection job runs at a time and further requests are coalesced. A failed refresh
 * keeps the last successful view; it never becomes an empty collection.
 *
 * See docs/dashboard.md#refresh-and-projection-lifecycle and docs/dashboard.md#asynchronous-data-updates.
 */
import type { Cursor, EmbeddedPage, Note, NoteStore } from "../src/index.js";
import type { ProjectionArtifactStore } from "./artifacts.js";
import { buildGraphView, type GraphView } from "./graph.js";
import type { ProjectionArtifact, ProjectionInput } from "./projection.js";
import type { ProjectionRunner } from "./projection-runner.js";

/** The graph state the browser polls: a completed view, a pending first view, or a failure. */
export interface GraphSnapshot {
  readonly status: "loading" | "ready" | "error";
  readonly refreshing: boolean;
  /** A sanitized refresh failure; kept next to the last successful view until a refresh succeeds. */
  readonly error?: string;
  readonly view?: GraphView;
}

/** Why an explicit comparison could not be served. */
export type ComparisonFailure = "no-view" | "unknown-note";

/** A comparison request that the current inspection state cannot answer. */
export class InspectionComparisonError extends Error {
  readonly reason: ComparisonFailure;

  constructor(reason: ComparisonFailure, message: string) {
    super(message);
    this.name = "InspectionComparisonError";
    this.reason = reason;
  }
}

export interface InspectionSessionOptions {
  /** The configured collection the export reads. */
  readonly collection: string;
  /** The embedding space identity the projected vectors belong to. */
  readonly embeddingSpaceId: string;
  /** The paginated embedded-record export; the session never writes through it. */
  readonly store: Pick<NoteStore, "pageEmbedded">;
  /** Projection and comparison work, executed off the HTTP event loop. */
  readonly runner: ProjectionRunner;
  /** Disposable coordinates, written after each completed projection. */
  readonly artifacts: ProjectionArtifactStore;
  /** Milliseconds between periodic refreshes; zero keeps the host to explicit refreshes. */
  readonly pollIntervalMs: number;
  readonly pageLimit?: number;
  readonly now?: () => Date;
}

interface Export {
  readonly notes: Note[];
  readonly inputs: ProjectionInput[];
}

interface QueuedJob {
  readonly rebuild: boolean;
}

const defaultPageLimit = 100;

const noViewMessage = "The host has no completed graph view yet.";

/** The session stopped between export pages or before publishing; never a refresh failure. */
class InspectionStopped extends Error {
  constructor() {
    super("The inspection session stopped.");
    this.name = "InspectionStopped";
  }
}

/** One host process's inspection state. */
export class InspectionSession {
  #store: Pick<NoteStore, "pageEmbedded">;
  #runner: ProjectionRunner;
  #artifacts: ProjectionArtifactStore;
  #collection: string;
  #embeddingSpaceId: string;
  #pollIntervalMs: number;
  #pageLimit: number;
  #now: () => Date;

  #view: GraphView | undefined;
  #error: string | undefined;
  #running = false;
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #resolveStopped: (() => void) | undefined;
  #stoppedSignal: Promise<void>;
  #queued: QueuedJob | undefined;
  #current: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #cacheTaken = false;

  constructor(options: InspectionSessionOptions) {
    this.#store = options.store;
    this.#runner = options.runner;
    this.#artifacts = options.artifacts;
    this.#collection = options.collection;
    this.#embeddingSpaceId = options.embeddingSpaceId;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#pageLimit = options.pageLimit ?? defaultPageLimit;
    this.#now = options.now ?? (() => new Date());
    this.#stoppedSignal = new Promise((resolve) => {
      this.#resolveStopped = resolve;
    });
  }

  /** Start the initial export and projection; periodic refresh starts once it completes. */
  start(): void {
    this.#queue(false);
  }

  /** Request one inspection refresh; a request during a running job coalesces into one more job. */
  refresh(): void {
    this.#queue(false);
  }

  /** Request a full fit for the next complete export. */
  rebuild(): void {
    this.#queue(true);
  }

  /** The current graph state, served by `GET /api/graph` without waiting for pending work. */
  snapshot(): GraphSnapshot {
    const refreshing = this.#running;
    const error = this.#error;
    if (this.#view !== undefined) {
      return {
        status: "ready",
        refreshing,
        ...(error === undefined ? {} : { error }),
        view: this.#view,
      };
    }
    return {
      status: error === undefined ? "loading" : "error",
      refreshing,
      ...(error === undefined ? {} : { error }),
    };
  }

  /**
   * Cosine similarity of two notes from the latest completed export, with the capture time of the
   * view that holds their vectors.
   */
  async compare(
    leftId: string,
    rightId: string,
  ): Promise<{ readonly similarity: number; readonly capturedAt: string }> {
    if (this.#view === undefined) {
      throw new InspectionComparisonError("no-view", noViewMessage);
    }
    // Similarity, membership and capture time must describe one completed export. A refresh in
    // flight would otherwise let the worker's vectors advance past the capture time of the view
    // this request started from. Waiting for the job is enough: the worker applies messages in
    // order, so a projection dispatched after this comparison cannot be observed by it.
    await this.settled();
    const view = this.#view;
    if (view === undefined) {
      throw new InspectionComparisonError("no-view", noViewMessage);
    }
    const displayed = new Set(view.nodes.map((node) => node.id.toLowerCase()));
    if (
      !displayed.has(leftId.toLowerCase()) ||
      !displayed.has(rightId.toLowerCase())
    ) {
      throw new InspectionComparisonError(
        "unknown-note",
        "Both notes must be present in the latest completed graph view.",
      );
    }
    const similarity = await this.#runner.compare(leftId, rightId);
    return { similarity, capturedAt: view.capturedAt };
  }

  /** Resolve once no refresh job is running and none is queued. */
  async settled(): Promise<void> {
    while (this.#current !== undefined) {
      await this.#current;
    }
  }

  /** Stop periodic refresh and pending jobs, cancel the running one and release the worker. */
  stop(): Promise<void> {
    if (this.#stopping === undefined) {
      this.#stopping = this.#stop();
    }
    return this.#stopping;
  }

  /**
   * Cancel pending work and release the worker. Further pages, projection dispatches and
   * publications stop at once, and closing the runner rejects an outstanding projection or
   * comparison. The running job is not awaited, so a stalled worker cannot delay shutdown.
   */
  async #stop(): Promise<void> {
    this.#stopped = true;
    this.#resolveStopped?.();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#queued = undefined;
    await this.#runner.close();
  }

  /** Serialize refresh jobs and coalesce requests made while one is running. */
  #queue(rebuild: boolean): void {
    if (this.#stopped) {
      return;
    }
    if (this.#running) {
      this.#queued = { rebuild: rebuild || (this.#queued?.rebuild ?? false) };
      return;
    }
    this.#running = true;
    this.#current = this.#run(rebuild).finally(() => {
      this.#running = false;
      this.#current = undefined;
      const queued = this.#queued;
      this.#queued = undefined;
      if (queued !== undefined) {
        this.#queue(queued.rebuild);
      }
      this.#schedule();
    });
  }

  /** One complete inspection job: export, project, publish; failures keep the previous view. */
  async #run(rebuild: boolean): Promise<void> {
    let exported: Export;
    try {
      exported = await this.#export();
    } catch (cause) {
      if (this.#stopped) {
        return;
      }
      this.#recordFailure("The last inspection export failed.", cause);
      return;
    }
    const capturedAt = this.#now().toISOString();
    let artifact: ProjectionArtifact;
    try {
      const cached = await this.#takeCachedProjection();
      this.#throwIfStopped();
      artifact = await this.#runner.project({
        collection: this.#collection,
        embeddingSpaceId: this.#embeddingSpaceId,
        inputs: exported.inputs,
        rebuild,
        ...(cached === undefined ? {} : { cached }),
      });
      this.#throwIfStopped();
      this.#view = buildGraphView({
        capturedAt,
        embeddingSpaceId: this.#embeddingSpaceId,
        projection: artifact,
        notes: exported.notes,
      });
      this.#error = undefined;
    } catch (cause) {
      if (this.#stopped) {
        return;
      }
      this.#recordFailure("The last inspection projection failed.", cause);
      return;
    }
    // Shutdown writes nothing; the artifact is a disposable cache of the next run.
    if (this.#stopped) {
      return;
    }
    try {
      await this.#artifacts.save(artifact);
    } catch (cause) {
      // The artifact is a disposable cache: the completed view stays current without it.
      console.warn(
        "[inspector] the projection artifact could not be saved:",
        cause,
      );
    }
  }

  /** Traverse the complete embedded export; a cursor is continued until the store omits one. */
  async #export(): Promise<Export> {
    const notes: Note[] = [];
    const inputs: ProjectionInput[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      this.#throwIfStopped();
      const page = await this.#page(cursor);
      for (const record of page.records) {
        notes.push(record.note);
        inputs.push({ id: record.note.id, vector: record.vector });
      }
      cursor = page.cursor;
      if (cursor === undefined) {
        return { notes, inputs };
      }
    }
  }

  /** One export page, abandoned when the session stops before it arrives. */
  async #page(cursor: Cursor | undefined): Promise<EmbeddedPage> {
    const page = await Promise.race([
      this.#store.pageEmbedded(this.#pageLimit, cursor),
      this.#stoppedSignal.then(() => undefined),
    ]);
    if (page === undefined) {
      throw new InspectionStopped();
    }
    return page;
  }

  /** Fail a pending job as soon as the session stops; its run reports no failure for it. */
  #throwIfStopped(): void {
    if (this.#stopped) {
      throw new InspectionStopped();
    }
  }

  /** The stored artifact is offered to the projection once, at the first complete export. */
  async #takeCachedProjection(): Promise<ProjectionArtifact | undefined> {
    if (this.#cacheTaken) {
      return undefined;
    }
    this.#cacheTaken = true;
    try {
      return await this.#artifacts.load({
        collection: this.#collection,
        embeddingSpaceId: this.#embeddingSpaceId,
      });
    } catch (cause) {
      console.warn(
        "[inspector] the stored projection artifact could not be read:",
        cause,
      );
      return undefined;
    }
  }

  /** Report a sanitized failure while the underlying cause stays in the host's diagnostics. */
  #recordFailure(message: string, cause: unknown): void {
    this.#error = message;
    console.error(`[inspector] ${message}`, cause);
  }

  /** Schedule the next periodic refresh after a completed job; never overlap jobs. */
  #schedule(): void {
    if (
      this.#stopped ||
      this.#pollIntervalMs === 0 ||
      this.#running ||
      this.#timer !== undefined
    ) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.refresh();
    }, this.#pollIntervalMs);
    this.#timer.unref();
  }
}
