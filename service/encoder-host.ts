/**
 * Host side of the encoder worker: load the pinned encoder in its own thread, route inference to
 * it and terminate the thread on shutdown. The service event loop only awaits these messages, so
 * blocking encoder loading and inference never stall HTTP requests.
 *
 * See docs/service.md#async-work-and-resource-sharing.
 */
import { Worker } from "node:worker_threads";

import type { Embedder, EmbeddingSpace } from "../src/index.js";
import type {
  EncoderWorkerReady,
  EncoderWorkerRequest,
  EncoderWorkerResponse,
} from "./encoder-protocol.js";

/** Where the worker loads the pinned encoder from; tests point at a substitute worker module. */
export interface WorkerEmbedderOptions {
  readonly cacheDir: string;
  readonly allowDownloads: boolean;
  /** The worker module; this module's sibling encoder worker by default. */
  readonly workerUrl?: URL;
  /** Loader arguments for the worker thread, which executes TypeScript directly. */
  readonly execArgv?: readonly string[];
}

/** A loaded encoder living in its own thread; closing terminates that thread. */
export interface WorkerEmbedder extends Embedder {
  /** Resolves on terminal failure (including idle exits); inference rejections are not terminal. */
  readonly failed: Promise<EncoderWorkerError>;
  close(): Promise<void>;
}

/** The encoder thread could not load the pinned encoder, failed or stopped. */
export class EncoderWorkerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EncoderWorkerError";
  }
}

/** The encoder worker runs TypeScript through the same loader the service is launched with. */
const defaultExecArgv = ["--import", "tsx"] as const;

interface PendingInference {
  readonly resolve: (vector: number[]) => void;
  readonly reject: (reason: unknown) => void;
}

class ThreadEmbedder implements WorkerEmbedder {
  #worker: Worker;
  #pending = new Map<number, PendingInference>();
  #nextRequestId = 1;
  #failure: EncoderWorkerError | undefined;
  #closed = false;
  #space: EmbeddingSpace | undefined;
  readonly #ready: Promise<EmbeddingSpace>;
  #resolveReady!: (space: EmbeddingSpace) => void;
  #rejectReady!: (cause: EncoderWorkerError) => void;
  #resolveFailed!: (cause: EncoderWorkerError) => void;
  readonly failed = new Promise<EncoderWorkerError>((resolve) => {
    this.#resolveFailed = resolve;
  });

  constructor(worker: Worker) {
    this.#worker = worker;
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // The startup failure is also a lifetime failure, so every listener is attached before the
    // worker can report anything and stays attached for the thread's whole life.
    worker.on(
      "message",
      (message: EncoderWorkerReady | EncoderWorkerResponse) => {
        if (message.type === "ready") {
          this.#space = message.space;
          this.#resolveReady(message.space);
          return;
        }
        if (message.type === "load-failed") {
          this.#fail(
            new EncoderWorkerError("The pinned encoder could not be loaded.", {
              cause: new Error(message.message),
            }),
          );
          void worker.terminate();
          return;
        }
        this.#receive(message);
      },
    );
    worker.on("error", (cause: Error) => {
      this.#fail(
        new EncoderWorkerError("The shared encoder failed.", { cause }),
      );
    });
    worker.on("exit", (code) => {
      if (!this.#closed) {
        this.#fail(
          new EncoderWorkerError(
            `The shared encoder stopped unexpectedly with exit code ${String(code)}.`,
          ),
        );
      }
    });
  }

  /** The space the loaded encoder declares; only valid once the startup handshake succeeded. */
  get space(): EmbeddingSpace {
    const space = this.#space;
    if (space === undefined) {
      throw new EncoderWorkerError("The shared encoder is not loaded.");
    }
    return space;
  }

  /** Resolve once the worker reported the loaded pinned encoder. */
  async opened(): Promise<void> {
    await this.#ready;
  }

  embed(text: string): Promise<number[]> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#closed) {
      return Promise.reject(
        new EncoderWorkerError("The shared encoder is closed."),
      );
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<number[]>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      const request: EncoderWorkerRequest = { type: "embed", requestId, text };
      this.#worker.postMessage(request);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#fail(new EncoderWorkerError("The shared encoder was closed."));
    await this.#worker.terminate();
  }

  /** Settle one correlated inference; a single rejection never disables the loaded encoder. */
  #receive(message: EncoderWorkerResponse): void {
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.requestId);
    if (message.type === "embedded") {
      pending.resolve(message.vector);
      return;
    }
    pending.reject(
      new EncoderWorkerError(
        "The shared encoder could not complete the inference.",
        { cause: new Error(message.message) },
      ),
    );
  }

  /** Reject every request still waiting when the worker fails or closes. */
  #fail(cause: EncoderWorkerError): void {
    this.#failure ??= cause;
    this.#resolveFailed(this.#failure);
    // A failure before the startup handshake settles the open call as well.
    this.#rejectReady(this.#failure);
    for (const pending of this.#pending.values()) {
      pending.reject(this.#failure);
    }
    this.#pending.clear();
  }
}

/**
 * Start the encoder worker and resolve once the pinned encoder inside it is ready. A worker that
 * cannot load the encoder rejects with a fixed message; its own diagnostic stays as the cause.
 */
export const openWorkerEmbedder = async (
  options: WorkerEmbedderOptions,
): Promise<WorkerEmbedder> => {
  const worker = new Worker(
    options.workerUrl ?? new URL("./encoder-worker.js", import.meta.url),
    {
      workerData: {
        cacheDir: options.cacheDir,
        allowDownloads: options.allowDownloads,
      },
      execArgv: [...(options.execArgv ?? defaultExecArgv)],
    },
  );
  const embedder = new ThreadEmbedder(worker);
  await embedder.opened();
  return embedder;
};
