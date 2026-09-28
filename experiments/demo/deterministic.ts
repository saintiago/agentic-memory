/**
 * Deterministic stand-ins for the demonstration: a token-hashing embedder and a model that answers
 * the fixed prompt envelopes with a simple, reproducible policy. They prove the harness wiring and
 * produce stable artifacts; they are not an encoder, a model or evidence about memory quality.
 *
 * See docs/evaluation.md#input-contract-and-extraction.
 */
import type {
  Embedder,
  EmbeddingSpace,
  LanguageModel,
  ModelRequest,
} from "../../src/index.js";
import {
  readConstructionEnvelope,
  readEvolutionEnvelope,
} from "../replay/envelope.js";

/** The declared space of the demonstration embedder. */
export const demoSpace: EmbeddingSpace = {
  id: "amem-demo-hashing-v1",
  dimensions: 64,
  distance: "Cosine",
};

/** Function words carry no retrieval signal in the demonstration and are ignored. */
const stopWords = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "with",
  "that",
  "this",
  "these",
  "those",
  "from",
  "into",
  "not",
  "does",
  "did",
  "its",
  "than",
  "then",
  "when",
  "before",
  "after",
  "older",
  "above",
]);

/** The significant lowercase tokens of a text, in first-occurrence order. */
export const significantTokens = (text: string): string[] => {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return tokens.filter(
    (token) =>
      token.length >= 3 && !/^\d+$/.test(token) && !stopWords.has(token),
  );
};

/** FNV-1a, so the demonstration vector is identical on every platform and run. */
const hashToken = (token: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/**
 * A deterministic hashing embedder: each significant token adds weight to two positions of the
 * declared space, and the vector is normalized. Equal text always produces the equal vector.
 */
export const createDeterministicEmbedder = (): Embedder => ({
  space: demoSpace,
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(demoSpace.dimensions).fill(0);
    for (const token of significantTokens(text)) {
      const hash = hashToken(token);
      const first = hash % demoSpace.dimensions;
      const second = (hash >>> 8) % demoSpace.dimensions;
      vector[first] = (vector[first] ?? 0) + 1;
      vector[second] = (vector[second] ?? 0) + 0.5;
    }
    const norm = Math.sqrt(
      vector.reduce((total, value) => total + value * value, 0),
    );
    if (norm === 0) {
      vector[0] = 1;
      return vector;
    }
    return vector.map((value) => value / norm);
  },
});

const firstSentence = (text: string): string => {
  const [first = text] = text.split(/(?<=[.!?])\s+/);
  return first.trim();
};

const shorten = (text: string, maximum: number): string =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;

/** The most frequent significant tokens, earliest occurrence first on a tie. */
const frequentTokens = (text: string, count: number): string[] => {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const token of significantTokens(text)) {
    if (!counts.has(token)) {
      order.push(token);
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return order
    .map((token, index) => ({ token, index, count: counts.get(token) ?? 0 }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.token.length - left.token.length ||
        left.index - right.index,
    )
    .slice(0, count)
    .map((entry) => entry.token);
};

const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

const overlap = (left: string, right: string): number => {
  const rightTokens = new Set(significantTokens(right));
  return significantTokens(left).filter((token) => rightTokens.has(token))
    .length;
};

/**
 * A deterministic model stand-in driven by the prompt envelope: construction derives attributes
 * from the source text, and evolution links neighbors that share at least two significant tokens
 * and records the relationship in their context.
 */
export const createFixtureModel = (): LanguageModel => ({
  async generate(request: ModelRequest): Promise<unknown> {
    if (request.stage === "construct") {
      const source = readConstructionEnvelope(request.prompt);
      const keywords = frequentTokens(source.content, 3);
      return {
        context: shorten(`Records: ${firstSentence(source.content)}`, 160),
        keywords,
        tags: dedupe(["synthetic", ...keywords.slice(0, 2)]),
      };
    }
    const envelope = readEvolutionEnvelope(request.prompt);
    const related = envelope.neighbors
      .map((neighbor) => ({
        neighbor,
        shared: overlap(envelope.incoming.content, neighbor.content),
      }))
      .filter((entry) => entry.shared >= 2)
      .sort((left, right) => right.shared - left.shared)
      .slice(0, 3);
    const incomingKeywords = frequentTokens(envelope.incoming.content, 2);
    return {
      links: related.map((entry) => entry.neighbor.id),
      newTags: envelope.incoming.tags,
      updates: related.map((entry) => ({
        id: entry.neighbor.id,
        context: shorten(
          `${entry.neighbor.context} Related material: ${firstSentence(
            envelope.incoming.content,
          )}`,
          240,
        ),
        keywords: dedupe([
          ...entry.neighbor.keywords,
          ...incomingKeywords,
        ]).slice(0, 5),
        tags: entry.neighbor.tags,
      })),
    };
  },
});
