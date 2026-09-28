/**
 * Provider lifecycle of the local memory service: the committed collection identity and durable
 * queue exist before any provider is opened, the pinned encoder, note store and model transport
 * initialize in the background with bounded retries, and reads and ingestion work only through
 * the ready stack. Inference enters the shared fair scheduler; the encoder is loaded once and
 * shared by insertion and search.
 *
 * See docs/service.md#availability-restart-and-shutdown and
 * docs/service.md#async-work-and-resource-sharing.
 */
import {
  AgenticMemory,
  openQdrantNoteStore,
  openReferenceEmbedder,
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
import {
  createHostModelTransport,
  type HostModelTransportOptions,
} from "./model-transport.js";
import { FairScheduler } from "./scheduler.js";
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
  openEmbedder(options: {
    readonly cacheDir: string;
    readonly allowDownloads: boolean;
  }): Promise<Embedder>;
  openStore(options: {
    readonly url: string;
    readonly collection: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly space: EmbeddingSpace;
  }): Promise<NoteStore>;
  createModel(options: HostModelTransportOptions): LanguageModel;
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

const defaultFactories: ProviderFactories = {
  openEmbedder: (options) => openReferenceEmbedder(options),
  openStore: (options) => openQdrantNoteStore(options),
  createModel: (options) => createHostModelTransport(options),
};

const sameSpace = (left: EmbeddingSpace, right: EmbeddingSpace): boolean =>
  left.id === right.id &&
  left.dimensions === right.dimensions &&
  left.distance === right.distance;

/**
 * One service instance's provider stack. Initialization starts when the host asks and keeps
 * retrying with bounded exponential backoff until it succeeds or the service stops; a loaded
 * encoder is never discarded between attempts. Availability is reported per capability and the
 * failure detail stays on the host's stderr.
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
  #running = false;
  #stopped = false;
  #initialization: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: ProviderRuntimeOptions) {
    this.#space = options.space;
    this.#settings = options.settings;
    this.#scheduler = options.scheduler;
    this.#factories = { ...defaultFactories, ...options.factories };
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

  /** The safe diagnostic of the condition that holds initialization, if any. */
  error(): string | undefined {
    return this.#error;
  }

  /** Begin loading providers in the background; repeated calls join the same attempt loop. */
  start(): void {
    if (this.#initialization === undefined && !this.#stopped) {
      this.#running = true;
      this.#initialization = this.#initialize();
    }
  }

  /** Stop retrying and let an in-flight attempt settle. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    this.#wake?.();
    await this.#initialization?.catch(() => undefined);
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
        this.#error = undefined;
        return;
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

  /** Load the pinned encoder once and confirm it declares the space the queue owns. */
  async #openEmbedder(): Promise<Embedder> {
    let embedder = this.#embedder;
    if (embedder === undefined) {
      try {
        embedder = await this.#factories.openEmbedder({
          cacheDir: this.#settings.embedding.cacheDir,
          allowDownloads: this.#settings.embedding.allowDownloads,
        });
      } catch (cause) {
        throw new ProviderStepError(
          "The pinned encoder could not be loaded.",
          cause,
        );
      }
      this.#embedder = embedder;
    }
    if (!sameSpace(embedder.space, this.#space)) {
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
      get: (id) => memory.get(id),
      page: (limit, cursor) => memory.page(limit, cursor),
      pageEmbedded: (limit, cursor) => store.pageEmbedded(limit, cursor),
      search: (query, options) =>
        scheduler.run(() => memory.search(query, options)),
      prepare: (input) => scheduler.run(() => memory.prepare(input)),
      apply: (plan) => memory.apply(plan),
    };
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
