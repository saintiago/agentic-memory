/**
 * Controlled substitutes and helpers for the memory service tests. The service itself is real:
 * its lifecycle, HTTP server, queue, scheduler and error mapping run, while the provider
 * boundaries the service composes are replaced by in-memory implementations with controllable
 * availability and failures.
 *
 * See docs/testing.md#choosing-scope.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  referenceEmbeddingSpace,
  type Cursor,
  type EmbeddedNote,
  type EmbeddedPage,
  type Embedder,
  type EmbeddingSpace,
  type LanguageModel,
  type Match,
  type ModelRequest,
  type Note,
  type NoteStore,
  type Page,
} from "../../../src/index.js";
import {
  startMemoryService,
  type MemoryServiceRuntime,
  type StartMemoryServiceOptions,
} from "../../../service/lifecycle.js";
import type { ProviderFactories } from "../../../service/providers.js";
import type { FairScheduler } from "../../../service/scheduler.js";
import type { ServiceSettings } from "../../../service/settings.js";

/** A deterministic nonnegative vector in the declared reference space. */
export const referenceVector = (seed: number): number[] => {
  const vector = new Array<number>(referenceEmbeddingSpace.dimensions).fill(0);
  vector[0] = seed + 1;
  vector[1] = 1;
  return vector;
};

/** The deterministic vector a text maps to in the controlled embedder. */
export const vectorFor = (text: string): number[] =>
  referenceVector(text.length);

/** A deterministic UUID so cases can build corpora without random identities. */
export const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

/** A complete current note with known update evidence. */
export const note = (value: number, links: string[] = []): Note => ({
  id: uuid(value),
  content: `Source material ${String(value)}.`,
  timestamp: "2026-09-27T15:44:27.001+02:00",
  updatedAt: "2026-09-28T09:00:00.000+02:00",
  context: `Records source material ${String(value)}.`,
  keywords: ["source"],
  tags: ["observation"],
  links,
});

export const record = (value: number, links: string[] = []): EmbeddedNote => ({
  note: note(value, links),
  vector: referenceVector(value),
});

export interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

export const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Await a condition another asynchronous operation satisfies. */
export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${String(timeoutMs)} ms waiting for ${description}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * An in-memory NoteStore with real pagination semantics, recording every write. Write failures
 * and partial writes can be injected to exercise replay at the service level.
 */
export class PagedStore implements NoteStore {
  readonly records = new Map<string, EmbeddedNote>();
  readonly writes: EmbeddedNote[][] = [];
  /** Fail every write attempt until this is cleared. */
  putError: Error | undefined;
  /** Fail the next writes, one per entry, before the store resumes applying records. */
  readonly putFailures: Error[] = [];
  /** Apply every record but the last, then fail, as an interrupted multi-record write can. */
  readonly partialWriteFailures: Error[] = [];
  nearestError: Error | undefined;
  pageEmbeddedError: Error | undefined;
  /** Hold the next put until the gate resolves, to observe an in-flight operation. */
  #putGate: Deferred<void> | undefined;
  /** Hold the next page read until the gate resolves, to observe an in-flight HTTP read. */
  #pageGate: Deferred<void> | undefined;
  /** How many write attempts started, including attempts that are still held or failing. */
  putStarted = 0;
  /** How many page reads started, including a read that is still held. */
  pageStarted = 0;

  holdWrites(): Deferred<void> {
    const gate = deferred<void>();
    this.#putGate = gate;
    return gate;
  }

  holdPages(): Deferred<void> {
    const gate = deferred<void>();
    this.#pageGate = gate;
    return gate;
  }

  seed(...records: EmbeddedNote[]): void {
    for (const entry of records) {
      this.records.set(entry.note.id.toLowerCase(), structuredClone(entry));
    }
  }

  stored(id: string): Note | undefined {
    const entry = this.records.get(id.toLowerCase());
    return entry === undefined ? undefined : structuredClone(entry.note);
  }

  async put(records: EmbeddedNote[]): Promise<void> {
    this.putStarted += 1;
    const partial = this.partialWriteFailures.shift();
    if (partial !== undefined) {
      for (const entry of records.slice(0, -1)) {
        this.records.set(entry.note.id.toLowerCase(), structuredClone(entry));
      }
      throw partial;
    }
    const failure = this.putFailures.shift() ?? this.putError;
    if (failure !== undefined) {
      throw failure;
    }
    const gate = this.#putGate;
    if (gate !== undefined) {
      this.#putGate = undefined;
      await gate.promise;
    }
    this.writes.push(structuredClone(records));
    for (const entry of records) {
      this.records.set(entry.note.id.toLowerCase(), structuredClone(entry));
    }
  }

  async get(ids: string[]): Promise<Note[]> {
    return ids.flatMap((id) => {
      const entry = this.records.get(id.toLowerCase());
      return entry === undefined ? [] : [structuredClone(entry.note)];
    });
  }

  async nearest(vector: number[], limit: number): Promise<Match[]> {
    if (this.nearestError !== undefined) {
      throw this.nearestError;
    }
    return [...this.records.values()].slice(0, limit).map((entry) => ({
      note: structuredClone(entry.note),
      score: vector.length === entry.vector.length ? 1 : 0,
    }));
  }

  async page(limit: number, cursor?: Cursor): Promise<Page> {
    this.pageStarted += 1;
    const gate = this.#pageGate;
    if (gate !== undefined) {
      this.#pageGate = undefined;
      await gate.promise;
    }
    const exported = this.#slice(limit, cursor);
    return {
      notes: exported.records.map((entry) => structuredClone(entry.note)),
      ...(exported.cursor === undefined ? {} : { cursor: exported.cursor }),
    };
  }

  async pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage> {
    if (this.pageEmbeddedError !== undefined) {
      throw this.pageEmbeddedError;
    }
    const exported = this.#slice(limit, cursor);
    return {
      records: exported.records.map((entry) => structuredClone(entry)),
      ...(exported.cursor === undefined ? {} : { cursor: exported.cursor }),
    };
  }

  /** Traverse insertion order with an offset cursor, so page boundaries are observable. */
  #slice(
    limit: number,
    cursor?: Cursor,
  ): { records: EmbeddedNote[]; cursor?: Cursor } {
    const all = [...this.records.values()];
    const start = typeof cursor === "number" ? cursor : 0;
    const records = all.slice(start, start + limit);
    const next = start + limit < all.length ? start + limit : undefined;
    return next === undefined ? { records } : { records, cursor: next };
  }
}

/** A controlled encoder whose space is the service's declared reference space. */
export class ControlledEmbedder implements Embedder {
  readonly space: EmbeddingSpace = referenceEmbeddingSpace;
  readonly texts: string[] = [];
  failNext: Error | undefined;
  source: (text: string) => number[] = vectorFor;
  /** Hold the next embed until the returned gate resolves, to observe a held preparation. */
  #embedGate: Deferred<void> | undefined;
  /** How many embed calls started, including one that is still held. */
  embedsStarted = 0;

  holdEmbeds(): Deferred<void> {
    const gate = deferred<void>();
    this.#embedGate = gate;
    return gate;
  }

  async embed(text: string): Promise<number[]> {
    this.texts.push(text);
    this.embedsStarted += 1;
    const gate = this.#embedGate;
    if (gate !== undefined) {
      this.#embedGate = undefined;
      await gate.promise;
    }
    const failure = this.failNext;
    if (failure !== undefined) {
      this.failNext = undefined;
      throw failure;
    }
    return this.source(text);
  }
}

/** A deterministic model that answers both memory stages, optionally failing controlled calls. */
export class FixedModel implements LanguageModel {
  readonly requests: ModelRequest[] = [];
  failNext: Error | undefined;
  /** Fail every request until this is cleared. */
  failAll: Error | undefined;
  /** The construct-stage answer; the default satisfies the construction response contract. */
  construction: unknown = {
    context: "Generated context.",
    keywords: ["keyword"],
    tags: ["tag"],
  };
  /** The evolve-stage answer; the default selects no links and changes nothing. */
  evolution: unknown = { links: [], newTags: ["tag"], updates: [] };
  #generateGate: Deferred<void> | undefined;

  /** Hold the next generation call until the returned gate resolves. */
  holdGenerate(): Deferred<void> {
    const gate = deferred<void>();
    this.#generateGate = gate;
    return gate;
  }

  async generate(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    const gate = this.#generateGate;
    if (gate !== undefined) {
      this.#generateGate = undefined;
      await gate.promise;
    }
    const permanent = this.failAll;
    if (permanent !== undefined) {
      throw permanent;
    }
    const failure = this.failNext;
    if (failure !== undefined) {
      this.failNext = undefined;
      throw failure;
    }
    return request.stage === "construct" ? this.construction : this.evolution;
  }
}

/** The controlled provider boundaries one service under test composes. */
export class ControlledProviders {
  readonly store = new PagedStore();
  readonly embedder = new ControlledEmbedder();
  readonly model = new FixedModel();
  /** Hold the next encoder load until the returned gate resolves. */
  #embedderGate: Deferred<void> | undefined;
  #storeGate: Deferred<void> | undefined;
  #embedderFailures: Error[] = [];
  #storeFailures: Error[] = [];
  embedderOpens = 0;
  storeOpens = 0;
  modelBuilds = 0;

  holdEmbedder(): Deferred<void> {
    const gate = deferred<void>();
    this.#embedderGate = gate;
    return gate;
  }

  holdStore(): Deferred<void> {
    const gate = deferred<void>();
    this.#storeGate = gate;
    return gate;
  }

  failEmbedderOnce(error: Error): void {
    this.#embedderFailures.push(error);
  }

  failStoreOnce(error: Error): void {
    this.#storeFailures.push(error);
  }

  readonly factories: ProviderFactories = {
    openEmbedder: async () => {
      this.embedderOpens += 1;
      const failure = this.#embedderFailures.shift();
      if (failure !== undefined) {
        throw failure;
      }
      const gate = this.#embedderGate;
      if (gate !== undefined) {
        this.#embedderGate = undefined;
        await gate.promise;
      }
      return this.embedder;
    },
    openStore: async () => {
      this.storeOpens += 1;
      const failure = this.#storeFailures.shift();
      if (failure !== undefined) {
        throw failure;
      }
      const gate = this.#storeGate;
      if (gate !== undefined) {
        this.#storeGate = undefined;
        await gate.promise;
      }
      return this.store;
    },
    createModel: () => {
      this.modelBuilds += 1;
      return this.model;
    },
  };
}

/** The settings one test service runs with; nothing is discovered from the environment. */
export const serviceSettings = (
  dataDirectory: string,
  overrides: Partial<ServiceSettings> = {},
): ServiceSettings => ({
  port: 0,
  bodyLimitBytes: 1_048_576,
  shutdownGraceMs: 5_000,
  dataDirectory,
  uiDirectory: path.join(dataDirectory, "ui"),
  artifactsDirectory: path.join(dataDirectory, "inspector"),
  qdrant: {
    url: "http://127.0.0.1:6333",
    collection: "service-tests",
    timeoutMs: 1_000,
  },
  embedding: {
    cacheDir: path.join(dataDirectory, "embeddings"),
    allowDownloads: false,
  },
  model: {
    endpoint: "https://model.example/chat/completions",
    model: "test-model",
    timeoutMs: 1_000,
    maxOutputTokens: 128,
  },
  ...overrides,
});

export interface ServiceHarness {
  readonly runtime: MemoryServiceRuntime;
  readonly providers: ControlledProviders;
  readonly settings: ServiceSettings;
  readonly directory: string;
  readonly baseUrl: string;
  url(path: string): string;
  close(): Promise<void>;
}

export interface StartHarnessOptions {
  readonly providers?: ControlledProviders;
  readonly dataDirectory?: string;
  readonly queuePollIntervalMs?: number;
  readonly providerRetryBaseMs?: number;
  readonly supervisionIntervalMs?: number;
  readonly now?: () => Date;
  readonly settings?: Partial<ServiceSettings>;
  readonly factories?: StartMemoryServiceOptions["factories"];
  readonly scheduler?: FairScheduler;
  /** Wait until the provider stack reports readiness before returning; default true. */
  readonly waitForProviders?: boolean;
}

/** Start a real service over controlled providers on an ephemeral loopback port. */
export const startServiceHarness = async (
  options: StartHarnessOptions = {},
): Promise<ServiceHarness> => {
  const providers = options.providers ?? new ControlledProviders();
  const directory =
    options.dataDirectory ??
    (await mkdtemp(path.join(tmpdir(), "amem-service-")));
  const settings = serviceSettings(directory, options.settings ?? {});
  const runtime = await startMemoryService({
    settings,
    factories: options.factories ?? providers.factories,
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
    queuePollIntervalMs: options.queuePollIntervalMs ?? 10,
    providerRetryBaseMs: options.providerRetryBaseMs ?? 20,
    supervisionIntervalMs: options.supervisionIntervalMs ?? 50,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (options.waitForProviders !== false) {
    await waitFor(async () => {
      const response = await fetch(
        `http://127.0.0.1:${String(runtime.port)}/v1/status`,
      );
      const body = (await response.json()) as {
        availability: { retrieval: boolean };
      };
      return body.availability.retrieval;
    }, "the service providers to become ready");
  }
  return {
    runtime,
    providers,
    settings,
    directory,
    baseUrl: `http://127.0.0.1:${String(runtime.port)}`,
    url: (path) => `http://127.0.0.1:${String(runtime.port)}${path}`,
    close: async () => {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

export interface JsonResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

/** Send one request and read the JSON body, when there is one. */
export const requestJson = async (
  url: string,
  init?: RequestInit,
): Promise<JsonResponse> => {
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
  };
};

/** POST one JSON body. */
export const postJson = (url: string, body: unknown): Promise<JsonResponse> =>
  requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
