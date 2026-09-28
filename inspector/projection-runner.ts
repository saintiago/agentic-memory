/**
 * The host side of the projection worker: send one request at a time, correlate responses and
 * release the thread on shutdown. The HTTP event loop only awaits these messages, so a long fit
 * cannot block requests or interaction.
 *
 * See docs/dashboard.md#asynchronous-data-updates.
 */
import { Worker } from "node:worker_threads";

import type {
  ProjectionArtifact,
  ProjectionErrorCode,
  ProjectionRequest,
} from "./projection.js";
import type {
  ProjectionWorkerRequest,
  ProjectionWorkerResponse,
} from "./projection-protocol.js";

/** CPU-heavy inspection work, executed away from the HTTP event loop. */
export interface ProjectionRunner {
  /** Project a complete export; the returned artifact describes the published coordinates. */
  project(request: ProjectionRequest): Promise<ProjectionArtifact>;
  /** Cosine similarity of two notes of the latest completed projection. */
  compare(leftId: string, rightId: string): Promise<number>;
  close(): Promise<void>;
}

/** A projection or comparison request the worker could not serve. */
export class ProjectionRunnerError extends Error {
  readonly code: ProjectionErrorCode | "worker-failed";

  constructor(code: ProjectionErrorCode | "worker-failed", message: string) {
    super(message);
    this.name = "ProjectionRunnerError";
    this.code = code;
  }
}

export interface ThreadProjectionRunnerOptions {
  /** The worker module; this module's sibling projection worker by default. */
  readonly workerUrl?: URL;
  /** Loader arguments for the worker thread, which executes TypeScript directly. */
  readonly execArgv?: readonly string[];
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/** The projection worker runs TypeScript through the same loader the host is launched with. */
const defaultExecArgv = ["--import", "tsx"] as const;

class ThreadProjectionRunner implements ProjectionRunner {
  #worker: Worker;
  #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #failure: Error | undefined;
  #closed = false;

  constructor(options: ThreadProjectionRunnerOptions = {}) {
    this.#worker = new Worker(
      options.workerUrl ?? new URL("./projection-worker.js", import.meta.url),
      { execArgv: [...(options.execArgv ?? defaultExecArgv)] },
    );
    this.#worker.on("message", (message: ProjectionWorkerResponse) => {
      this.#receive(message);
    });
    this.#worker.on("error", (error: Error) => {
      this.#fail(error);
    });
    this.#worker.on("exit", (code) => {
      if (!this.#closed) {
        this.#fail(
          new Error(
            `The projection worker stopped unexpectedly with exit code ${String(code)}.`,
          ),
        );
      }
    });
  }

  project(request: ProjectionRequest): Promise<ProjectionArtifact> {
    return this.#request((requestId) => ({
      type: "project",
      requestId,
      request,
    })) as Promise<ProjectionArtifact>;
  }

  compare(leftId: string, rightId: string): Promise<number> {
    return this.#request((requestId) => ({
      type: "compare",
      requestId,
      leftId,
      rightId,
    })) as Promise<number>;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#fail(new Error("The projection worker was closed."));
    await this.#worker.terminate();
  }

  /** Send one request and await its correlated response. */
  #request(
    build: (requestId: number) => ProjectionWorkerRequest,
  ): Promise<unknown> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#closed) {
      return Promise.reject(new Error("The projection worker is closed."));
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#worker.postMessage(build(requestId));
    });
  }

  #receive(message: ProjectionWorkerResponse): void {
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.requestId);
    if (message.type === "failed") {
      pending.reject(new ProjectionRunnerError(message.code, message.message));
      return;
    }
    if (message.type === "projected") {
      pending.resolve(message.artifact);
      return;
    }
    pending.resolve(message.similarity);
  }

  /** Reject every request still waiting when the worker fails or closes. */
  #fail(cause: Error): void {
    this.#failure ??= cause;
    for (const pending of this.#pending.values()) {
      pending.reject(cause);
    }
    this.#pending.clear();
  }
}

/** Start the projection worker of the inspection host. */
export const createThreadProjectionRunner = (
  options: ThreadProjectionRunnerOptions = {},
): ProjectionRunner => new ThreadProjectionRunner(options);
