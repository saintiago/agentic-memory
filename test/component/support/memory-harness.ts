/**
 * Controlled substitutes for the Memory and ingestion-queue component tests: an in-memory
 * NoteStore that records the interactions performed through the contract, a deterministic embedder
 * and a scripted language model. Ordinary internal collaborators stay real; only the provider
 * boundaries are replaced.
 *
 * See docs/testing.md#choosing-scope.
 */
import {
  MemoryError,
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

/** The deterministic vector a text maps to in the controlled embedder. */
export const vectorFor = (text: string): number[] => [text.length, 1, 0, 0];

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Let pending microtasks run without relying on timers. */
export const flush = async (): Promise<void> => {
  for (let step = 0; step < 20; step += 1) {
    await Promise.resolve();
  }
};

/** Capture one rejection so a failed promise cannot mask the assertion that follows. */
export const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

export const expectMemoryError = (cause: unknown): MemoryError => {
  if (!(cause instanceof MemoryError)) {
    throw new Error(`Expected a MemoryError, received ${String(cause)}.`);
  }
  return cause;
};

/** An in-memory NoteStore that records the interactions Memory performs through the contract. */
export class RecordingStore implements NoteStore {
  readonly records = new Map<string, EmbeddedNote>();
  readonly calls: string[] = [];
  readonly writes: EmbeddedNote[][] = [];
  /** Fail every write attempt until this is cleared. */
  putError: Error | undefined;
  /** Fail the next writes, one per entry, before the store resumes applying records. */
  readonly putFailures: Error[] = [];
  /**
   * Apply every record but the last, then fail, as an interrupted multi-record write can. One
   * entry is consumed per write attempt.
   */
  readonly partialWriteFailures: Error[] = [];
  nearestError: Error | undefined;
  /** Retain the references handed to `put`, as a replacement store is allowed to do. */
  retainWrites = false;
  #putGate: Deferred<void> | undefined;

  /** Hold the next put until the returned gate resolves, to observe write acknowledgment. */
  holdWrites(): Deferred<void> {
    const gate = deferred<void>();
    this.#putGate = gate;
    return gate;
  }

  /** Fail this many of the following write attempts, in order. */
  failNextWrites(...failures: Error[]): void {
    this.putFailures.push(...failures);
  }

  seed(record: EmbeddedNote): Note {
    this.records.set(record.note.id.toLowerCase(), structuredClone(record));
    return record.note;
  }

  stored(id: string): Note | undefined {
    const record = this.records.get(id.toLowerCase());
    return record === undefined ? undefined : structuredClone(record.note);
  }

  storedVector(id: string): number[] | undefined {
    return this.records.get(id.toLowerCase())?.vector;
  }

  async put(records: EmbeddedNote[]): Promise<void> {
    this.calls.push("put");
    const partial = this.partialWriteFailures.shift();
    if (partial !== undefined) {
      for (const record of records.slice(0, -1)) {
        this.records.set(record.note.id.toLowerCase(), structuredClone(record));
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
    for (const record of records) {
      this.records.set(
        record.note.id.toLowerCase(),
        this.retainWrites ? record : structuredClone(record),
      );
    }
  }

  async get(ids: string[]): Promise<Note[]> {
    this.calls.push("get");
    return ids.flatMap((id) => {
      const record = this.records.get(id.toLowerCase());
      return record === undefined ? [] : [structuredClone(record.note)];
    });
  }

  async nearest(vector: number[], limit: number): Promise<Match[]> {
    this.calls.push(`nearest:${limit}:${vector.length}`);
    if (this.nearestError !== undefined) {
      throw this.nearestError;
    }
    return [...this.records.values()]
      .slice(0, limit)
      .map((record) => ({ note: structuredClone(record.note), score: 1 }));
  }

  async page(limit: number): Promise<Page> {
    this.calls.push("page");
    return {
      notes: [...this.records.values()]
        .slice(0, limit)
        .map((record) => structuredClone(record.note)),
    };
  }

  async pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage> {
    this.calls.push(`pageEmbedded:${limit}:${String(cursor)}`);
    return {
      records: [...this.records.values()].slice(0, limit).map((record) => ({
        note: structuredClone(record.note),
        vector: [...record.vector],
      })),
    };
  }
}

/** A deterministic embedder whose output a case can replace or fail. */
export class ControlledEmbedder implements Embedder {
  readonly space: EmbeddingSpace;
  readonly texts: string[] = [];
  failNext: Error | undefined;
  source: (text: string) => number[] = vectorFor;

  constructor(
    space: EmbeddingSpace = {
      id: "amem-test-space",
      dimensions: 4,
      distance: "Cosine",
    },
  ) {
    this.space = space;
  }

  async embed(text: string): Promise<number[]> {
    this.texts.push(text);
    const failure = this.failNext;
    if (failure !== undefined) {
      this.failNext = undefined;
      throw failure;
    }
    return this.source(text);
  }
}

interface ScriptedStep {
  readonly stage: ModelRequest["stage"];
  readonly produce: () => unknown;
}

/** A LanguageModel that answers scripted steps in order and records every request. */
export class ScriptedModel implements LanguageModel {
  readonly requests: ModelRequest[] = [];
  readonly #steps: ScriptedStep[] = [];

  queue(stage: ModelRequest["stage"], produce: () => unknown): this {
    this.#steps.push({ stage, produce });
    return this;
  }

  async generate(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    const step = this.#steps.shift();
    if (step === undefined) {
      throw new Error(`Unexpected ${request.stage} request.`);
    }
    if (step.stage !== request.stage) {
      throw new Error(
        `The script expected a ${step.stage} request but received ${request.stage}.`,
      );
    }
    return await step.produce();
  }
}
