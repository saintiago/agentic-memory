import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import {
  AgenticMemory,
  MemoryError,
  type Cursor,
  type Embedder,
  type LanguageModel,
  type ModelRequest,
  type Note,
} from "../../../src/index.js";
import {
  dropCollection,
  openStore,
  uniqueCollection,
} from "../support/note-store.js";

/**
 * System journeys for retrieval and inspection with the assembled library and an isolated real
 * Qdrant. The model and embedding outputs are controlled, so the cases assert wiring, ranking,
 * bounded link expansion and persistence rather than model judgment or retrieval quality.
 *
 * See docs/testing.md#system-journeys and docs/memory.md#retrieval-and-inspection.
 */

const NOTE_TIMESTAMP = "2026-09-27T15:44:27.001+02:00";

const created: string[] = [];

const collection = (label: string): string => {
  const name = uniqueCollection(label);
  created.push(name);
  return name;
};

afterAll(async () => {
  for (const name of created) {
    await dropCollection(name);
  }
});

const QUERY = "gamma procedure";
const QUERY_VECTOR = [0.6, 0.8, 0, 0];

/** One deterministic vector per source content, so ranking is controlled by the fixture. */
const CONTENT_VECTORS = new Map<string, number[]>([
  ["Alpha procedure.", [1, 0, 0, 0]],
  ["Beta procedure.", [0.8, 0.6, 0, 0]],
  ["Gamma procedure.", [0.6, 0.8, 0, 0]],
]);

/**
 * Map the canonical embedding text of a fixture note, or the query text, to a fixed vector. The
 * vector depends on the note's original content, so evolving its semantic attributes does not
 * move it in the ranking.
 */
class ContentEmbedder implements Embedder {
  readonly space = {
    id: "amem2-retrieval-space",
    dimensions: 4,
    distance: "Cosine",
  } as const;
  readonly texts: string[] = [];

  async embed(text: string): Promise<number[]> {
    this.texts.push(text);
    if (text === QUERY) {
      return QUERY_VECTOR;
    }
    const newline = text.indexOf("\n");
    const content = newline === -1 ? text : text.slice(0, newline);
    const vector = CONTENT_VECTORS.get(content);
    if (vector === undefined) {
      throw new Error(`No fixture vector for "${content}".`);
    }
    return vector;
  }
}

interface ScriptedStep {
  readonly stage: ModelRequest["stage"];
  readonly produce: () => unknown;
}

class ScriptedModel implements LanguageModel {
  readonly requests: ModelRequest[] = [];
  readonly #steps: ScriptedStep[] = [];

  queue(stage: ModelRequest["stage"], produce: () => unknown): this {
    this.#steps.push({ stage, produce });
    return this;
  }

  async generate(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    const step = this.#steps.shift();
    if (step === undefined || step.stage !== request.stage) {
      throw new Error(`Unexpected ${request.stage} request.`);
    }
    return await step.produce();
  }
}

const idsOf = (notes: readonly Note[]): string[] =>
  notes.map((note) => note.id).sort();

describe("memory retrieval journeys", () => {
  it("searches ranked matches and one-hop links after reopening storage", async () => {
    const name = collection("retrieval");
    const embedder = new ContentEmbedder();
    const store = await openStore(name);

    const firstModel = new ScriptedModel();
    firstModel.queue("construct", () => ({
      context: "Records the alpha procedure.",
      keywords: ["alpha"],
      tags: ["observation"],
    }));
    const alpha = await new AgenticMemory(store, embedder, firstModel).add({
      content: "Alpha procedure.",
      timestamp: NOTE_TIMESTAMP,
    });

    // The related insertion links to the stored note and evolves its current context.
    const secondModel = new ScriptedModel();
    secondModel.queue("construct", () => ({
      context: "Records the beta procedure.",
      keywords: ["beta"],
      tags: ["observation"],
    }));
    secondModel.queue("evolve", () => ({
      links: [alpha.id],
      newTags: ["observation", "linked"],
      updates: [
        {
          id: alpha.id,
          context: "The alpha procedure now supports the beta account.",
          keywords: ["alpha", "support"],
          tags: ["history"],
        },
      ],
    }));
    const beta = await new AgenticMemory(store, embedder, secondModel).add({
      content: "Beta procedure.",
      timestamp: NOTE_TIMESTAMP,
    });

    const thirdModel = new ScriptedModel();
    thirdModel.queue("construct", () => ({
      context: "Records the gamma procedure.",
      keywords: ["gamma"],
      tags: ["observation"],
    }));
    thirdModel.queue("evolve", () => ({
      links: [beta.id, alpha.id],
      newTags: ["observation"],
      updates: [],
    }));
    const gamma = await new AgenticMemory(store, embedder, thirdModel).add({
      content: "Gamma procedure.",
      timestamp: NOTE_TIMESTAMP,
    });

    const reopened = await openStore(name);
    const searchModel = new ScriptedModel();
    const memory = new AgenticMemory(reopened, embedder, searchModel);

    // One direct match; both of its outgoing links are appended in stored order without scores.
    const expanded = await memory.search(QUERY, { limit: 1, linkedLimit: 5 });
    const [directMatch, betaLink, alphaLink] = expanded;

    expect(expanded.map((result) => [result.via, result.note.id])).toEqual([
      ["match", gamma.id],
      ["link", beta.id],
      ["link", alpha.id],
    ]);
    expect(directMatch?.via).toBe("match");
    if (directMatch?.via !== "match") {
      throw new Error("The first search result must be a scored direct match.");
    }
    expect(directMatch.score).toBeCloseTo(1, 5);
    expect(betaLink?.via).toBe("link");
    expect(alphaLink?.via).toBe("link");
    expect("score" in (betaLink ?? {})).toBe(false);
    // The linked addition carries the current evolved attributes of its note.
    expect(alphaLink?.note).toEqual({
      ...alpha,
      context: "The alpha procedure now supports the beta account.",
      keywords: ["alpha", "support"],
      tags: ["history"],
    });
    expect(searchModel.requests).toEqual([]);

    // When the linked notes are already direct matches, no addition repeats them.
    const direct = await memory.search(QUERY, { limit: 3 });

    expect(direct.map((result) => [result.via, result.note.id])).toEqual([
      ["match", gamma.id],
      ["match", beta.id],
      ["match", alpha.id],
    ]);
    const scores = direct.map((result) =>
      result.via === "match" ? result.score : Number.NaN,
    );
    expect(scores[0]).toBeCloseTo(1, 5);
    expect(scores[1]).toBeCloseTo(0.96, 5);
    expect(scores[2]).toBeCloseTo(0.6, 5);

    // A zero linked limit disables expansion entirely.
    const unreleased = await memory.search(QUERY, { limit: 1, linkedLimit: 0 });
    expect(unreleased.map((result) => [result.via, result.note.id])).toEqual([
      ["match", gamma.id],
    ]);
    expect(searchModel.requests).toEqual([]);
  });

  it("reads a current note, a missing note and the whole collection after reopening", async () => {
    const name = collection("inspection");
    const embedder = new ContentEmbedder();
    const store = await openStore(name);
    const firstModel = new ScriptedModel();
    firstModel.queue("construct", () => ({
      context: "Records the alpha procedure.",
      keywords: ["alpha"],
      tags: ["observation"],
    }));
    const alpha = await new AgenticMemory(store, embedder, firstModel).add({
      content: "Alpha procedure.",
      timestamp: NOTE_TIMESTAMP,
      metadata: { origin: "host" },
    });
    const secondModel = new ScriptedModel();
    secondModel.queue("construct", () => ({
      context: "Records the beta procedure.",
      keywords: ["beta"],
      tags: ["observation"],
    }));
    secondModel.queue("evolve", () => ({
      links: [],
      newTags: ["observation"],
      updates: [],
    }));
    const beta = await new AgenticMemory(store, embedder, secondModel).add({
      content: "Beta procedure.",
      timestamp: NOTE_TIMESTAMP,
    });

    const reopened = await openStore(name);
    const memory = new AgenticMemory(reopened, embedder, new ScriptedModel());

    expect(await memory.get(alpha.id)).toEqual(alpha);
    expect(await memory.get(beta.id)).toEqual(beta);
    expect(await memory.get(randomUUID())).toBeUndefined();
    const invalid = await memory.get("not-a-note-id").then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(invalid).toBeInstanceOf(MemoryError);
    expect((invalid as MemoryError).operation).toBe("get");
    expect((invalid as MemoryError).stage).toBe("input");
    expect((invalid as MemoryError).persistence).toBe("unchanged");

    const seen: Note[] = [];
    let cursor: Cursor | undefined;
    let pages = 0;
    do {
      const page = await memory.page(1, cursor);
      expect(page.notes.length).toBeLessThanOrEqual(1);
      seen.push(...page.notes);
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== undefined);

    expect(pages).toBe(2);
    expect(idsOf(seen)).toEqual(idsOf([alpha, beta]));
    expect(new Set(idsOf(seen)).size).toBe(2);
  });
});
