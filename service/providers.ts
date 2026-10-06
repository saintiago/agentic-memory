/**
 * Provider lifecycle of the local memory service: the committed collection identity and durable
 * queue exist before any provider is opened, the pinned encoder, note store and model transport
 * initialize in the background with bounded retries, and reads and ingestion work only through
 * the ready stack. Inference enters the shared fair scheduler; one live encoder is shared by
 * insertion and search and replaced only after terminal failure.
 *
 * See docs/service.md#availability-restart-and-shutdown and
 * docs/service.md#async-work-and-resource-sharing.
 */
import {
  AgenticMemory,
  MemoryError,
  openQdrantNoteStore,
  type Cursor,
  type EmbeddedPage,
  type Embedder,
  type EmbeddingSpace,
  type InsertionPlan,
  type LanguageModel,
  type MemoryPreparer,
  type Note,
  type NoteStore,
  type Page,
  type PrepareInput,
  type SearchOptions,
  type SearchResult,
} from "../src/index.js";
import { openWorkerEmbedder } from "./encoder-host.js";
import {
  createHostModelTransport,
  type HostModelTransportOptions,
} from "./model-transport.js";
import { FairScheduler, InferenceOverloadedError } from "./scheduler.js";
import type { ServiceSettings } from "./settings.js";

/** The ready provider operations the service exposes. */
export interface ServiceEngine {
  get(id: string): Promise<Note | undefined>;
  page(limit: number, cursor?: Cursor): Promise<Page>;
  pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage>;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
  prepare(input: PrepareInput): Promise<InsertionPlan>;
  apply(plan: InsertionPlan): Promise<Note>;
}

/** How the service constructs its providers; tests substitute controlled implementations. */
export interface ProviderFactories {
  /** A hosted encoder exposes terminal lifetime failures as a resolving promise. */
  openEmbedder(options: {
    readonly cacheDir: string;
    readonly allowDownloads: boolean;
  }): Promise<Embedder & { readonly failed?: Promise<Error> }>;
  openStore(options: {
    readonly url: string;
    readonly collection: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly space: EmbeddingSpace;
  }): Promise<NoteStore>;
  createModel(options: HostModelTransportOptions): LanguageModel;
  /**
   * Release a loaded encoder on clean shutdown; the worker-backed default terminates its thread.
   * Controlled substitutes without a release step keep the default no-op.
   */
  closeEmbedder?(embedder: Embedder): Promise<void>;
}

/** The provider settings subset of the service settings this runtime consumes. */
export type ProviderSettings = Pick<
  ServiceSettings,
  "qdrant" | "embedding" | "model"
>;

export interface ProviderRuntimeOptions {
  /** The embedding space the durable queue is already bound to. */
  readonly space: EmbeddingSpace;
  readonly settings: ProviderSettings;
  readonly scheduler: FairScheduler;
  /** Controlled construction for component tests; the pinned providers by default. */
  readonly factories?: Partial<ProviderFactories>;
  /** The first retry delay after a failed initialization attempt. */
  readonly retryBaseMs?: number;
  /** The longest retry delay. */
  readonly retryMaxMs?: number;
}

/** A capability the service owns but cannot serve yet. */
export class ProviderUnavailableError extends Error {
  /** A safe diagnostic of the condition that holds the capability. */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ProviderUnavailableError";
    this.reason = reason;
  }
}

/** Whether a loaded encoder owns a thread or another resource the host must release. */
const isClosableEmbedder = (
  embedder: Embedder,
): embedder is Embedder & { close(): Promise<void> } =>
  typeof (embedder as { close?: unknown }).close === "function";

/** The pinned provider implementations every service-owned stack composes; maintenance reuses them. */
export const defaultProviderFactories: ProviderFactories = {
  openEmbedder: (options) => openWorkerEmbedder(options),
  openStore: (options) => openQdrantNoteStore(options),
  createModel: (options) => createHostModelTransport(options),
  closeEmbedder: async (embedder) => {
    if (isClosableEmbedder(embedder)) {
      await embedder.close();
    }
  },
};

/** Whether two declarations describe the same embedding space. */
export const sameEmbeddingSpace = (
  left: EmbeddingSpace,
  right: EmbeddingSpace,
): boolean =>
  left.id === right.id &&
  left.dimensions === right.dimensions &&
  left.distance === right.distance;

/** The provider operations whose failures the status report publishes as capability outages. */
export type ServiceCapability = "retrieval" | "ingestion";

/** The safe diagnostic a status report carries while a capability is known to be failing. */
const outageReason: Record<ServiceCapability, string> = {
  retrieval: "The memory retrieval capability is failing.",
  ingestion: "The memory ingestion capability is failing.",
};

/**
 * Whether a provider operation failure means the capability itself is failing. Invalid input is a
 * client error and temporary admission overload is scheduling pressure; neither is an outage.
 */
const isProviderFailure = (cause: unknown): boolean => {
  if (cause instanceof ProviderUnavailableError) {
    return true;
  }
  if (cause instanceof InferenceOverloadedError) {
    return false;
  }
  if (cause instanceof MemoryError) {
    return cause.stage !== "input";
  }
  return true;
};

/**
 * One service instance's provider stack. Initialization starts when the host asks and keeps
 * retrying with bounded exponential backoff until the service stops. A healthy encoder is retained
 * between attempts; terminal thread failures trigger replacement. Availability is reported per
 * capability from initialization and each operation's outcome; failure detail stays on stderr.
 */
export class ProviderRuntime {
  readonly #space: EmbeddingSpace;
  readonly #settings: ProviderSettings;
  readonly #scheduler: FairScheduler;
  readonly #factories: ProviderFactories;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #preparer: MemoryPreparer;

  #embedder: Embedder | undefined;
  #store: NoteStore | undefined;
  #engine: ServiceEngine | undefined;
  #error: string | undefined;
  /** Failed operations; only a success of the same operation demonstrates recovery. */
  readonly #outages = new Map<keyof ServiceEngine, ServiceCapability>();
  #encoderFailure: Error | undefined;
  #running = false;
  #stopped = false;
  #initialization: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: ProviderRuntimeOptions) {
    this.#space = options.space;
    this.#settings = options.settings;
    this.#scheduler = options.scheduler;
    this.#factories = { ...defaultProviderFactories, ...options.factories };
    this.#retryBaseMs = options.retryBaseMs ?? 1_000;
    this.#retryMaxMs = options.retryMaxMs ?? 60_000;
    this.#preparer = {
      prepare: async (input) => (await this.engine()).prepare(input),
      apply: async (plan) => (await this.engine()).apply(plan),
    };
  }

  /** Whether the full read and ingestion stack is ready. */
  get ready(): boolean {
    return this.#engine !== undefined;
  }

  /**
   * The current availability of each capability the provider stack serves. An observed outage
   * keeps the capability unavailable until the failed operation serves again; initialization alone
   * never clears it.
   */
  availability(): Record<ServiceCapability, boolean> {
    const ready = this.ready && !this.#stopped;
    return {
      retrieval: ready && ![...this.#outages.values()].includes("retrieval"),
      ingestion: ready && ![...this.#outages.values()].includes("ingestion"),
    };
  }

  /** The safe diagnostic of the condition that holds initialization or a capability, if any. */
  error(): string | undefined {
    const capability = this.#outages.values().next().value;
    return (
      this.#error ??
      (capability === undefined ? undefined : outageReason[capability])
    );
  }

  /** Begin loading providers in the background; repeated calls join the same attempt loop. */
  start(): void {
    if (this.#initialization === undefined && !this.#stopped) {
      this.#running = true;
      this.#initialization = this.#initialize();
    }
  }

  /** Stop retrying, let an in-flight attempt settle and release the loaded encoder. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    this.#wake?.();
    await this.#initialization?.catch(() => undefined);
    this.#store = undefined;
    this.#engine = undefined;
    await this.#releaseEmbedder();
  }

  async #releaseEmbedder(): Promise<void> {
    const embedder = this.#embedder;
    this.#embedder = undefined;
    if (embedder !== undefined) {
      try {
        await this.#factories.closeEmbedder?.(embedder);
      } catch (cause) {
        console.error(
          "[service] the shared encoder could not be released:",
          cause,
        );
      }
    }
  }

  /** The ready engine, or an explicit capability failure while providers are unavailable. */
  async engine(): Promise<ServiceEngine> {
    const engine = this.#engine;
    if (engine === undefined) {
      throw new ProviderUnavailableError(
        this.#error ?? "The memory providers are still starting.",
      );
    }
    return engine;
  }

  /** The durable queue's prepare/apply path over the same shared provider stack. */
  memory(): MemoryPreparer {
    return this.#preparer;
  }

  async #initialize(): Promise<void> {
    let attempt = 0;
    while (this.#running && !this.#stopped) {
      try {
        await this.#open();
        if (this.#stopped) {
          return;
        }
        if (this.#encoderFailure !== undefined) {
          throw new ProviderStepError(
            "The shared encoder stopped unexpectedly.",
            this.#encoderFailure,
          );
        }
        this.#error = undefined;
        // Stay alive after readiness: a terminal encoder failure wakes this same retry loop.
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        this.#wake = undefined;
        if (this.#stopped) {
          return;
        }
        throw new ProviderStepError(
          "The shared encoder stopped unexpectedly.",
          this.#encoderFailure,
        );
      } catch (cause) {
        if (this.#stopped) {
          return;
        }
        if (cause instanceof SpaceMismatchError) {
          this.#running = false;
          this.#error = cause.message;
          console.error(`[service] ${cause.message}`);
          return;
        }
        // Only the fixed, credential-free description is published; the cause stays on stderr.
        this.#error =
          cause instanceof ProviderStepError
            ? cause.message
            : "The memory providers could not be initialized.";
        console.error("[service] provider initialization failed:", cause);
        if (this.#encoderFailure !== undefined) {
          this.#engine = undefined;
          await this.#releaseEmbedder();
          this.#encoderFailure = undefined;
        }
        attempt += 1;
        await this.#delay(
          Math.min(this.#retryBaseMs * 2 ** (attempt - 1), this.#retryMaxMs),
        );
      }
    }
  }

  /** Open the missing providers, reusing every provider that already opened successfully. */
  async #open(): Promise<void> {
    const embedder = await this.#openEmbedder();
    const store = await this.#openStore(embedder.space);
    if (this.#encoderFailure !== undefined) {
      throw new ProviderStepError(
        "The shared encoder stopped unexpectedly.",
        this.#encoderFailure,
      );
    }
    if (this.#engine === undefined) {
      try {
        this.#engine = this.#compose(store, embedder);
      } catch (cause) {
        throw new ProviderStepError(
          "The language-model transport could not be created.",
          cause,
        );
      }
    }
  }

  /** Load one encoder and confirm it declares the space the queue owns. */
  async #openEmbedder(): Promise<Embedder> {
    let embedder = this.#embedder;
    if (embedder === undefined) {
      try {
        const opened = await this.#factories.openEmbedder({
          cacheDir: this.#settings.embedding.cacheDir,
          allowDownloads: this.#settings.embedding.allowDownloads,
        });
        embedder = opened;
        void opened.failed?.then((cause) => {
          if (this.#stopped || this.#embedder !== opened) {
            return;
          }
          this.#encoderFailure = cause;
          this.#engine = undefined;
          this.#error = "The shared encoder stopped unexpectedly.";
          this.#wake?.();
        });
      } catch (cause) {
        throw new ProviderStepError(
          "The pinned encoder could not be loaded.",
          cause,
        );
      }
      this.#embedder = embedder;
    }
    if (!sameEmbeddingSpace(embedder.space, this.#space)) {
      throw new SpaceMismatchError();
    }
    return embedder;
  }

  /** Open the collection with the loaded encoder's declared space. */
  async #openStore(space: EmbeddingSpace): Promise<NoteStore> {
    let store = this.#store;
    if (store === undefined) {
      try {
        store = await this.#factories.openStore({
          url: this.#settings.qdrant.url,
          collection: this.#settings.qdrant.collection,
          timeoutMs: this.#settings.qdrant.timeoutMs,
          space,
          ...(this.#settings.qdrant.apiKey === undefined
            ? {}
            : { apiKey: this.#settings.qdrant.apiKey }),
        });
      } catch (cause) {
        throw new ProviderStepError(
          "The note store could not be opened.",
          cause,
        );
      }
      this.#store = store;
    }
    return store;
  }

  /** One ready stack: the shared encoder, the store and the host model transport. */
  #compose(store: NoteStore, embedder: Embedder): ServiceEngine {
    const model = this.#factories.createModel({
      endpoint: this.#settings.model.endpoint,
      model: this.#settings.model.model,
      timeoutMs: this.#settings.model.timeoutMs,
      maxOutputTokens: this.#settings.model.maxOutputTokens,
      ...(this.#settings.model.apiKey === undefined
        ? {}
        : { apiKey: this.#settings.model.apiKey }),
    });
    const memory = new AgenticMemory(store, embedder, model);
    const scheduler = this.#scheduler;
    return {
      get: (id) => this.#serve("get", "retrieval", () => memory.get(id)),
      page: (limit, cursor) =>
        this.#serve("page", "retrieval", () => memory.page(limit, cursor)),
      pageEmbedded: (limit, cursor) =>
        this.#serve("pageEmbedded", "retrieval", () =>
          store.pageEmbedded(limit, cursor),
        ),
      search: (query, options) =>
        this.#serve("search", "retrieval", () =>
          scheduler.run(() => memory.search(query, options)),
        ),
      prepare: (input) =>
        this.#serve("prepare", "ingestion", () =>
          scheduler.run(() => memory.prepare(input)),
        ),
      apply: (plan) =>
        this.#serve("apply", "ingestion", () => memory.apply(plan)),
    };
  }

  /**
   * Run one provider operation, recording whether the capability served it. A provider failure of
   * a ready stack marks the capability as failing until that same operation succeeds; invalid input
   * and scheduler overload leave availability alone.
   */
  async #serve<Value>(
    operation: keyof ServiceEngine,
    capability: ServiceCapability,
    run: () => Promise<Value>,
  ): Promise<Value> {
    try {
      const value = await run();
      this.#outages.delete(operation);
      return value;
    } catch (cause) {
      if (this.ready && isProviderFailure(cause)) {
        this.#outages.set(operation, capability);
      }
      throw cause;
    }
  }

  /** Wait for the next attempt, or return at once when the service stops. */
  #delay(ms: number): Promise<void> {
    if (this.#stopped) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        this.#wake = undefined;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref();
      this.#wake = finish;
    });
  }
}

/** The loaded encoder declares another space than the queue's binding. */
class SpaceMismatchError extends Error {
  constructor() {
    super(
      "The loaded encoder declares a different embedding space than the collection this " +
        "service owns.",
    );
    this.name = "SpaceMismatchError";
  }
}

/** One initialization step failed; only the fixed description is published. */
class ProviderStepError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ProviderStepError";
  }
}
