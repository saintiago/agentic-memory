/**
 * Inspection state of the local host: the most recent completed graph view, the paginated export
 * and projection lifecycle behind it, the periodic and manual refresh requests, the disposable
 * coordinate cache and the explicit stored-vector comparison.
 *
 * All storage reads are asynchronous, projection work runs in the injected worker-backed runner,
 * one export/projection job runs at a time and further requests are coalesced. A failed refresh
 * keeps the last successful view; it never becomes an empty collection. A requested fresh fit
 * stays due through failures and coalescing until one completes.
 *
 * See docs/dashboard.md#refresh-and-projection-lifecycle and docs/dashboard.md#asynchronous-data-updates.
 */
import type { Note } from "../src/index.js";
import type { ProjectionArtifactStore } from "./artifacts.js";
import { buildGraphView, type GraphSnapshot, type GraphView } from "./graph.js";
import type { ProjectionArtifact, ProjectionInput } from "./projection.js";
import type { ProjectionRunner } from "./projection-runner.js";
import type {
  InspectionIdentity,
  InspectionPage,
  InspectionSource,
} from "./source.js";

export type { GraphSnapshot };

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
  /** The service-backed read surface; the session never writes through it. */
  readonly source: InspectionSource;
  /** Projection and comparison work, executed off the HTTP event loop. */
  readonly runner: ProjectionRunner;
  /** Disposable coordinates, written after each completed projection. */
  readonly artifacts: ProjectionArtifactStore;
  /** Milliseconds between periodic refreshes; zero keeps the host to explicit refreshes. */
  readonly pollIntervalMs: number;
  /** The first delay before a failed export or projection is retried; 1 second by default. */
  readonly retryBaseMs?: number;
  /** The longest delay between failed-refresh retries; 30 seconds by default. */
  readonly retryMaxMs?: number;
  readonly pageLimit?: number;
  readonly now?: () => Date;
}

interface Export {
  readonly notes: Note[];
  readonly inputs: ProjectionInput[];
}

interface QueuedJob {
  /** Only a new explicit request, not the running job's unfulfilled rebuild intent. */
  readonly rebuild: boolean;
}

const defaultPageLimit = 100;
const defaultRetryBaseMs = 1_000;
const defaultRetryMaxMs = 30_000;

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
  #source: InspectionSource;
  #runner: ProjectionRunner;
  #artifacts: ProjectionArtifactStore;
  #pollIntervalMs: number;
  #retryBaseMs: number;
  #retryMaxMs: number;
  #pageLimit: number;
  #now: () => Date;
  /** Observers of the observable graph state, such as a listener's event channel. */
  readonly #listeners = new Set<() => void>();

  #view: GraphView | undefined;
  #error: string | undefined;
  #running = false;
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #cancellation = new AbortController();
  #queued: QueuedJob | undefined;
  /** A fresh fit is due: a failed rebuild keeps its intent for the retry and the next job. */
  #rebuildRequested = false;
  #current: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #retryAttempt = 0;
  #cacheTaken = false;

  constructor(options: InspectionSessionOptions) {
    this.#source = options.source;
    this.#runner = options.runner;
    this.#artifacts = options.artifacts;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#retryBaseMs = options.retryBaseMs ?? defaultRetryBaseMs;
    this.#retryMaxMs = options.retryMaxMs ?? defaultRetryMaxMs;
    this.#pageLimit = options.pageLimit ?? defaultPageLimit;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Observe every observable state change: a job starts, publishes a view or records a failure.
   * The returned function unsubscribes.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Start the initial export and projection; periodic refresh starts once it completes. */
  start(): void {
    this.#queue(false);
  }

  /** Request one inspection refresh; a request during a running job coalesces into one more job. */
  refresh(): void {
    this.#queue(false);
  }

  /** Request a full fit for the next complete export; it stays due until that fit completes. */
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
    this.#cancellation.abort();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#queued = undefined;
    await this.#runner.close();
  }

  /**
   * Serialize refresh jobs and coalesce requests made while one is running. Queued requests keep
   * only explicit rebuild intent; unfinished intent is inherited when the next job starts, after
   * the current job has either fulfilled it or failed.
   */
  #queue(rebuild: boolean): void {
    if (this.#stopped) {
      return;
    }
    // Any new trigger supersedes a pending retry of an earlier failure.
    this.#clearRetry();
    if (this.#running) {
      this.#queued = { rebuild: rebuild || (this.#queued?.rebuild ?? false) };
      return;
    }
    const freshFit = rebuild || this.#rebuildRequested;
    this.#rebuildRequested = freshFit;
    this.#running = true;
    this.#notify();
    this.#current = this.#run(freshFit).finally(() => {
      this.#running = false;
      this.#current = undefined;
      this.#notify();
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
    let identity: InspectionIdentity;
    let exported: Export;
    try {
      // The collection and embedding-space identity come from the service on every job, so a
      // reconnected or reconfigured service is never projected as the previous one.
      identity = await this.#source.identity();
      exported = await this.#export();
    } catch (cause) {
      if (this.#stopped) {
        return;
      }
      this.#recordFailure("The last inspection export failed.", cause);
      this.#scheduleRetry();
      return;
    }
    const capturedAt = this.#now().toISOString();
    let artifact: ProjectionArtifact;
    try {
      const cached = await this.#takeCachedProjection(identity);
      this.#throwIfStopped();
      artifact = await this.#runner.project({
        collection: identity.collection,
        embeddingSpaceId: identity.embeddingSpaceId,
        inputs: exported.inputs,
        rebuild,
        ...(cached === undefined ? {} : { cached }),
      });
      this.#throwIfStopped();
      this.#view = buildGraphView({
        capturedAt,
        embeddingSpaceId: identity.embeddingSpaceId,
        projection: artifact,
        notes: exported.notes,
      });
      this.#error = undefined;
      this.#retryAttempt = 0;
      this.#clearRetry();
      if (rebuild) {
        // The requested fresh fit is fulfilled; the next job may transform instead of refitting.
        this.#rebuildRequested = false;
      }
    } catch (cause) {
      if (this.#stopped) {
        return;
      }
      this.#recordFailure("The last inspection projection failed.", cause);
      this.#scheduleRetry();
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
    let cursor: string | undefined;
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

  /** Stop waiting on an export page; remove the subscription as soon as either side settles. */
  async #page(cursor: string | undefined): Promise<InspectionPage> {
    this.#throwIfStopped();
    const signal = this.#cancellation.signal;
    let cancel: () => void = () => {};
    try {
      return await new Promise<InspectionPage>((resolve, reject) => {
        cancel = () => {
          reject(new InspectionStopped());
        };
        signal.addEventListener("abort", cancel, { once: true });
        void this.#source
          .pageEmbedded(this.#pageLimit, cursor)
          .then(resolve, reject);
      });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  /** Fail a pending job as soon as the session stops; its run reports no failure for it. */
  #throwIfStopped(): void {
    if (this.#stopped) {
      throw new InspectionStopped();
    }
  }

  /** The stored artifact is offered to the projection once, at the first complete export. */
  async #takeCachedProjection(
    identity: InspectionIdentity,
  ): Promise<ProjectionArtifact | undefined> {
    if (this.#cacheTaken) {
      return undefined;
    }
    this.#cacheTaken = true;
    try {
      return await this.#artifacts.load({
        collection: identity.collection,
        embeddingSpaceId: identity.embeddingSpaceId,
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

  /**
   * Recover a failed refresh on the session's own bounded backoff instead of waiting for another
   * memory write; a new trigger supersedes the pending retry. The retry runs through `refresh()`,
   * so a fresh fit that the failed job had requested stays due.
   */
  #scheduleRetry(): void {
    if (this.#stopped || this.#retryTimer !== undefined) {
      return;
    }
    const delay = Math.min(
      this.#retryMaxMs,
      this.#retryBaseMs * 2 ** this.#retryAttempt,
    );
    this.#retryAttempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.refresh();
    }, delay);
    this.#retryTimer.unref();
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  /** Publish one observable state change; a listener failure never breaks the session. */
  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (cause) {
        console.error("[inspector] a graph change listener failed:", cause);
      }
    }
  }
}
