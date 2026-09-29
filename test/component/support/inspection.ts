/**
 * Controlled substitutes and small helpers for the inspection host tests. The host itself is not
 * mocked: its session, HTTP server and composition are exercised for real, with an in-memory
 * paged NoteStore, a stub public read surface and a recording projection runner.
 *
 * See docs/testing.md#choosing-scope.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  Cursor,
  EmbeddedNote,
  EmbeddedPage,
  Match,
  Note,
  NoteStore,
  Page,
  SearchOptions,
  SearchResult,
} from "../../../src/index.js";
import type {
  InspectionIdentity,
  InspectionPage,
  InspectionSource,
} from "../../../inspector/source.js";
import type {
  ProjectionArtifact,
  ProjectionRequest,
} from "../../../inspector/projection.js";
import type { ProjectionRunner } from "../../../inspector/projection-runner.js";
import type { InspectionReads } from "../../../inspector/server.js";

/** One artifact that satisfies the recorded projection contract without running a real fit. */
export const scriptedArtifact = (
  request: ProjectionRequest,
): ProjectionArtifact => ({
  schemaVersion: 1,
  collection: request.collection,
  embeddingSpaceId: request.embeddingSpaceId,
  layout: request.inputs.length >= 16 ? "umap" : "non-semantic",
  projectionId: `test-projection:${String(request.inputs.length)}${
    request.rebuild ? ":rebuild" : ""
  }`,
  algorithm: { name: "umap-js", version: "1.4.0" },
  parameters: {
    metric: "cosine",
    nComponents: 2,
    nNeighbors: 15,
    minDist: 0.1,
    seed: 42,
    nEpochs: "library-default",
  },
  builtAt: "2026-09-28T12:00:00.000Z",
  fitInputs: request.inputs.map((input) => ({
    id: input.id.toLowerCase(),
    vectorId: `test-vector:${input.id}`,
  })),
  coordinates: request.inputs.map((input, index) => ({
    id: input.id,
    x: index,
    y: -(index + 1),
    vectorId: `test-vector:${input.id}`,
  })),
});

export interface RunnerControls {
  readonly project: (request: ProjectionRequest) => Promise<ProjectionArtifact>;
  readonly compare: (leftId: string, rightId: string) => Promise<number>;
}

/** A projection runner whose outcomes each case controls; it records every request it receives. */
export class RecordingRunner implements ProjectionRunner {
  readonly projections: ProjectionRequest[] = [];
  readonly comparisons: Array<{
    readonly leftId: string;
    readonly rightId: string;
  }> = [];
  closed = false;
  #project: RunnerControls["project"];
  #compare: RunnerControls["compare"];

  constructor(controls: Partial<RunnerControls> = {}) {
    this.#project =
      controls.project ??
      ((request) => Promise.resolve(scriptedArtifact(request)));
    this.#compare = controls.compare ?? (() => Promise.resolve(0.5));
  }

  /** Replace the controlled outcome between jobs of one case. */
  control(controls: Partial<RunnerControls>): void {
    this.#project =
      controls.project ??
      ((request) => Promise.resolve(scriptedArtifact(request)));
    this.#compare = controls.compare ?? (() => Promise.resolve(0.5));
  }

  project(request: ProjectionRequest): Promise<ProjectionArtifact> {
    this.projections.push(request);
    return this.#project(request);
  }

  compare(leftId: string, rightId: string): Promise<number> {
    this.comparisons.push({ leftId, rightId });
    return this.#compare(leftId, rightId);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** Create one disposable directory for a test case. */
export const makeDirectory = (prefix: string): Promise<string> =>
  mkdtemp(path.join(tmpdir(), prefix));

/** Remove a test's disposable directory. */
export const removeDirectory = async (directory: string): Promise<void> => {
  await rm(directory, { recursive: true, force: true });
};

/** Await a condition that another asynchronous operation satisfies. */
export const waitFor = async (
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${String(timeoutMs)} ms waiting for ${description}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** A deterministic UUID so cases can build corpora without random identities. */
export const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

/** A complete current note with fresh update evidence. */
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

/** A deterministic stored vector for one note. */
export const vector = (value: number, dimensions = 4): number[] =>
  Array.from(
    { length: dimensions },
    (_, index) =>
      Math.sin(value + index * 1.3) + Math.cos(value * 0.7 + index * 0.4),
  );

export const record = (value: number, links: string[] = []): EmbeddedNote => ({
  note: note(value, links),
  vector: vector(value),
});

/**
 * An in-memory NoteStore that honors the pagination contract of `pageEmbedded` and refuses every
 * write or vector-free read, so a host that used one would fail loudly.
 */
export class PagedEmbeddedStore implements NoteStore {
  readonly records = new Map<string, EmbeddedNote>();
  readonly exports: Array<{
    readonly limit: number;
    readonly cursor?: Cursor;
  }> = [];
  exportError: Error | undefined;

  seed(...records: EmbeddedNote[]): void {
    for (const entry of records) {
      this.records.set(entry.note.id.toLowerCase(), entry);
    }
  }

  async pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage> {
    this.exports.push(cursor === undefined ? { limit } : { limit, cursor });
    if (this.exportError !== undefined) {
      throw this.exportError;
    }
    const all = [...this.records.values()];
    const start = typeof cursor === "number" ? cursor : 0;
    const page = all.slice(start, start + limit);
    const next = start + limit < all.length ? start + limit : undefined;
    return next === undefined
      ? { records: page }
      : { records: page, cursor: next };
  }

  async put(): Promise<void> {
    throw new Error("The inspection host must never write a memory.");
  }

  async get(): Promise<Note[]> {
    throw new Error(
      "The inspection host reads one note through the public memory API.",
    );
  }

  async nearest(): Promise<Match[]> {
    throw new Error(
      "The inspection host searches through the public memory API.",
    );
  }

  async page(): Promise<Page> {
    throw new Error(
      "The inspection host exports embedded records, not vector-free pages.",
    );
  }
}

/** A recording substitute for the public get/search surface the host composes. */
export class ScriptedReads implements InspectionReads {
  readonly notes = new Map<string, Note>();
  readonly searches: Array<{
    readonly query: string;
    readonly options?: SearchOptions;
  }> = [];
  results: SearchResult[] = [];
  getError: Error | undefined;
  searchError: Error | undefined;

  seed(...notes: Note[]): void {
    for (const stored of notes) {
      this.notes.set(stored.id.toLowerCase(), stored);
    }
  }

  get(id: string): Promise<Note | undefined> {
    if (this.getError !== undefined) {
      return Promise.reject(this.getError);
    }
    return Promise.resolve(this.notes.get(id.toLowerCase()));
  }

  search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    this.searches.push(options === undefined ? { query } : { query, options });
    if (this.searchError !== undefined) {
      return Promise.reject(this.searchError);
    }
    return Promise.resolve(this.results);
  }
}

/**
 * The service-backed read surface the session and browser API compose. It combines the paged
 * embedded export substitute with the scripted note and search reads under one service identity,
 * as the real service does.
 */
export class ScriptedSource implements InspectionSource {
  readonly store: PagedEmbeddedStore;
  readonly reads: ScriptedReads;
  readonly collection: string;
  readonly embeddingSpaceId: string;

  constructor(
    store: PagedEmbeddedStore,
    reads: ScriptedReads = new ScriptedReads(),
    collection = "notes",
    embeddingSpaceId = "space-1",
  ) {
    this.store = store;
    this.reads = reads;
    this.collection = collection;
    this.embeddingSpaceId = embeddingSpaceId;
  }

  identity(): Promise<InspectionIdentity> {
    return Promise.resolve({
      collection: this.collection,
      embeddingSpaceId: this.embeddingSpaceId,
    });
  }

  pageEmbedded(limit: number, cursor?: string): Promise<InspectionPage> {
    return this.store
      .pageEmbedded(limit, cursor === undefined ? undefined : Number(cursor))
      .then((page) => ({
        records: page.records,
        ...(page.cursor === undefined ? {} : { cursor: String(page.cursor) }),
      }));
  }

  get(id: string): Promise<Note | undefined> {
    return this.reads.get(id);
  }

  search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return this.reads.search(query, options);
  }
}
