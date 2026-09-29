/**
 * A deterministic synthetic corpus and the controlled host stack around it for the responsive
 * scale check: paged embedded export, an index-derived projection, one growth step, one forced
 * export failure and a scripted search. The real inspection session, HTTP server and browser UI
 * are exercised; only the collection, the projection worker and provider reads are substituted,
 * because neither Qdrant nor the pinned encoder belongs in this check.
 *
 * See docs/dashboard.md#asynchronous-data-updates and docs/testing.md#choosing-scope.
 */
import type {
  Cursor,
  EmbeddedPage,
  Note,
  NoteStore,
  SearchResult,
} from "../../src/index.js";
import type { InspectionSource } from "../../inspector/source.js";
import type { ProjectionArtifactStore } from "../../inspector/artifacts.js";
import type {
  ProjectionArtifact,
  ProjectionInput,
  ProjectionRequest,
} from "../../inspector/projection.js";
import type { ProjectionRunner } from "../../inspector/projection-runner.js";
import type { InspectionReads } from "../../inspector/server.js";

export interface CorpusSize {
  readonly nodes: number;
  readonly links: number;
}

export interface SyntheticOptions {
  readonly nodes: number;
  readonly linksPerNode: number;
  /** Nodes and links one growth step adds; the check grows the corpus once. */
  readonly growthNodes: number;
  readonly growthLinksPerNode: number;
  /** One far, asymmetric position the growth step adds as an extra memory; absent adds none. */
  readonly growthOutlier:
    { readonly x: number; readonly y: number } | undefined;
  /** Milliseconds one export page waits, keeping the export asynchronous. */
  readonly exportDelayMs: number;
  /** Milliseconds one projection run waits. */
  readonly projectionDelayMs: number;
}

const defaults: SyntheticOptions = {
  nodes: 10_000,
  linksPerNode: 5,
  growthNodes: 500,
  growthLinksPerNode: 5,
  growthOutlier: undefined,
  exportDelayMs: 20,
  projectionDelayMs: 100,
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** The stable, UUID-shaped identity of one synthetic memory. */
export const syntheticId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/** The identity of the far memory the optional growth outlier adds. */
export const syntheticOutlierId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * The projected position of one synthetic memory: a deterministic sunflower disc, so a stable
 * identity always keeps its coordinate and a growth step places new memories slightly outside the
 * previous extent.
 */
export const syntheticPosition = (
  index: number,
  nodes: number,
): { readonly x: number; readonly y: number } => {
  const angle = index * 2.399963229728653;
  const radius = Math.sqrt((index + 1) / (nodes + 1)) * 100;
  return {
    x: Math.round(radius * Math.cos(angle) * 1e6) / 1e6,
    y: Math.round(radius * Math.sin(angle) * 1e6) / 1e6,
  };
};

const links = (index: number, count: number, nodes: number): string[] => {
  const targets: string[] = [];
  for (let step = 0; step < count; step += 1) {
    const target = (index * 7 + step * 13 + 1) % nodes;
    if (target !== index && !targets.includes(syntheticId(target))) {
      targets.push(syntheticId(target));
    }
  }
  return targets;
};

/** One synthetic note; the growth step rewrites the first note's stored content. */
const syntheticNote = (
  index: number,
  options: {
    /** The frozen size the original memories keep for links and positions. */
    readonly baseNodes: number;
    readonly size: number;
    readonly linksPerNode: number;
    readonly growthLinksPerNode: number;
    readonly grown: boolean;
  },
): Note => ({
  id: syntheticId(index),
  content:
    index === 0 && options.grown
      ? "Memory 0 remains the same subject but its stored text changed"
      : `Memory ${String(index)} records a synthetic statement used for the inspection scale check`,
  timestamp: "2026-09-20T10:00:00.000Z",
  // Even memories carry an update time; odd ones stay unknown, exercising both freshness paths.
  ...(index % 2 === 0
    ? {
        updatedAt: new Date(
          Date.parse("2026-09-28T12:00:00.000Z") - index * 1_000,
        ).toISOString(),
      }
    : {}),
  context: `Synthetic context ${String(index)}`,
  keywords: [`synthetic keyword ${String(index)}`],
  tags: ["scale-check"],
  links: links(
    index,
    index < options.baseNodes
      ? options.linksPerNode
      : options.growthLinksPerNode,
    // Existing memories keep their stored targets; only grown memories use the new extent.
    index < options.baseNodes ? options.baseNodes : options.size,
  ),
});

/**
 * The far memory one growth step can add: it sits outside the previous extent, so the completed
 * view's bounds grow to one side.
 */
const syntheticOutlier = (): Note => ({
  id: syntheticOutlierId,
  content: "Memory far outside the previous extent, added by the growth step",
  timestamp: "2026-09-20T10:00:00.000Z",
  context: "Synthetic outlier context",
  keywords: ["synthetic outlier"],
  tags: ["scale-check"],
  links: [],
});

/** The corpus, its paged export and the projection and read substitutes one run needs. */
export class SyntheticMemory {
  readonly options: SyntheticOptions;
  readonly collection = "synthetic-scale-collection";
  readonly embeddingSpaceId = "synthetic-scale-space";
  /** A returned memory that no export contains, so the UI reports it as not yet mapped. */
  readonly unmappedId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  /** Whether the next export must fail instead of returning pages. */
  failExport: string | undefined;
  #grown = false;
  #notes: Note[] | undefined;
  /** An export the check holds open, so the update window is explicit instead of racy. */
  #held: Promise<void> | undefined;
  #releaseHeld: (() => void) | undefined;

  constructor(options: Partial<SyntheticOptions> = {}) {
    this.options = { ...defaults, ...options };
  }

  /** The memories the current corpus holds. */
  get nodes(): number {
    return this.options.nodes + (this.#grown ? this.options.growthNodes : 0);
  }

  /** The exact memory and stored-link counts of the current corpus. */
  counts(): CorpusSize {
    const notes = this.#allNotes();
    return {
      nodes: notes.length,
      links: notes.reduce((total, note) => total + note.links.length, 0),
    };
  }

  /** The position of one memory; memories present before the growth step never move. */
  position(index: number): { readonly x: number; readonly y: number } {
    return syntheticPosition(
      index,
      index < this.options.nodes ? this.options.nodes : this.nodes,
    );
  }

  /** The projected position of one identity, including the optional far growth outlier. */
  positionOf(id: string): { readonly x: number; readonly y: number } {
    if (id === syntheticOutlierId) {
      const outlier = this.options.growthOutlier;
      if (outlier !== undefined) {
        return outlier;
      }
    }
    return this.position(indexOf(id));
  }

  /** Add the growth step once: new memories and links, plus one changed memory. */
  grow(): void {
    if (this.#grown) {
      return;
    }
    this.#grown = true;
    this.#notes = undefined;
  }

  /** Hold the next export until `releaseExport()`; the session then reports a running refresh. */
  holdNextExport(): void {
    this.#held = new Promise<void>((resolve) => {
      this.#releaseHeld = resolve;
    });
  }

  /** Release an export held by `holdNextExport()`. */
  releaseExport(): void {
    const release = this.#releaseHeld;
    this.#releaseHeld = undefined;
    this.#held = undefined;
    release?.();
  }

  note(index: number): Note {
    const notes = this.#allNotes();
    const note = notes[index];
    if (note === undefined) {
      throw new Error(`The synthetic corpus has no memory ${String(index)}.`);
    }
    return note;
  }

  /** The reads the host exposes: the current notes and one scripted search. */
  get reads(): InspectionReads {
    return {
      get: (id: string): Promise<Note | undefined> =>
        Promise.resolve(this.#allNotes().find((note) => note.id === id)),
      search: (query: string): Promise<SearchResult[]> => {
        if (query.trim() === "") {
          return Promise.reject(new Error("The search request is not valid."));
        }
        const direct = [10, 20, 30].map((index) => ({
          note: this.note(index),
          via: "match" as const,
          score: 0.9 - index / 1_000,
        }));
        return Promise.resolve([
          ...direct,
          {
            note: { ...this.note(40), id: this.unmappedId },
            via: "link" as const,
          },
        ]);
      },
    };
  }

  /** The service-backed read surface the inspection host composes in these checks. */
  get source(): InspectionSource {
    const store = this.store;
    const reads = this.reads;
    return {
      identity: () =>
        Promise.resolve({
          collection: this.collection,
          embeddingSpaceId: this.embeddingSpaceId,
        }),
      pageEmbedded: async (limit, cursor) => {
        const page = await store.pageEmbedded(
          limit,
          cursor === undefined ? undefined : Number(cursor),
        );
        return {
          records: page.records,
          ...(page.cursor === undefined ? {} : { cursor: String(page.cursor) }),
        };
      },
      get: (id) => reads.get(id),
      search: (query, options) => reads.search(query, options),
    };
  }

  /** The paged embedded export of the host, with its optional delay and forced failure. */
  get store(): Pick<NoteStore, "pageEmbedded"> {
    return {
      pageEmbedded: async (
        limit: number,
        cursor?: Cursor,
      ): Promise<EmbeddedPage> => {
        const held = this.#held;
        if (held !== undefined) {
          await held;
        }
        if (this.options.exportDelayMs > 0) {
          await delay(this.options.exportDelayMs);
        }
        const failure = this.failExport;
        if (failure !== undefined) {
          this.failExport = undefined;
          throw new Error(failure);
        }
        const start = typeof cursor === "number" ? cursor : 0;
        const notes = this.#allNotes();
        const page = notes.slice(start, start + limit);
        const next = start + limit;
        return {
          records: page.map((note, offset) => ({
            note,
            // The substituted collection declares no space; the vector only carries identity.
            vector: [
              Math.sin(start + offset),
              Math.cos(start + offset),
              (start + offset) / 1_000,
              1,
            ],
          })),
          ...(next < notes.length ? { cursor: next } : {}),
        };
      },
    };
  }

  /** The projection and comparison worker substitute: coordinates derive from the identity. */
  get runner(): ProjectionRunner {
    return {
      project: async (
        request: ProjectionRequest,
      ): Promise<ProjectionArtifact> => {
        if (this.options.projectionDelayMs > 0) {
          await delay(this.options.projectionDelayMs);
        }
        const points = request.inputs.map((input) => {
          const position = this.positionOf(input.id);
          return {
            id: input.id,
            x: position.x,
            y: position.y,
            vectorId: `synthetic-vector:${input.id}`,
          };
        });
        return {
          schemaVersion: 1,
          collection: request.collection,
          embeddingSpaceId: request.embeddingSpaceId,
          layout: request.inputs.length >= 16 ? "umap" : "non-semantic",
          projectionId: `synthetic-projection:${String(points.length)}`,
          algorithm: { name: "umap-js", version: "1.4.0" },
          parameters: {
            metric: "cosine",
            nComponents: 2,
            nNeighbors: 15,
            minDist: 0.1,
            seed: 42,
            nEpochs: "library-default",
          },
          builtAt: new Date().toISOString(),
          fitInputs: request.inputs.map((input: ProjectionInput) => ({
            id: input.id.toLowerCase(),
            vectorId: `synthetic-vector:${input.id}`,
          })),
          coordinates: points,
        };
      },
      compare: (): Promise<number> => Promise.resolve(0.5),
      close: (): Promise<void> => Promise.resolve(),
    };
  }

  /** The disposable artifact store of the check: nothing is persisted between runs. */
  get artifacts(): ProjectionArtifactStore {
    return {
      load: () => Promise.resolve(undefined),
      save: () => Promise.resolve(),
    };
  }

  #allNotes(): Note[] {
    this.#notes ??= [
      ...Array.from({ length: this.nodes }, (_, index) =>
        syntheticNote(index, {
          baseNodes: this.options.nodes,
          size: this.nodes,
          linksPerNode: this.options.linksPerNode,
          growthLinksPerNode: this.options.growthLinksPerNode,
          grown: this.#grown,
        }),
      ),
      ...(this.#grown && this.options.growthOutlier !== undefined
        ? [syntheticOutlier()]
        : []),
    ];
    return this.#notes;
  }
}

/** The corpus index of one identity; the synthetic ids end in the zero-padded index. */
const indexOf = (id: string): number => {
  const digits = id.slice(id.lastIndexOf("-") + 1);
  const index = Number.parseInt(digits, 10);
  return Number.isNaN(index) ? 0 : index;
};
