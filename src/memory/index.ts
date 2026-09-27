import type { JsonValue, Note } from "../note-store/index.js";
import type { MemoryPrompts } from "./prompts.js";

/**
 * Memory public contract: add source content, search for direct matches and bounded linked
 * additions, and inspect stored notes. This module owns the input and result types exchanged with
 * the host.
 *
 * See docs/memory.md and docs/architecture.md#public-contracts.
 */

export {
  assembleConstructionPrompt,
  assembleEvolutionPrompt,
  defaultPrompts,
} from "./prompts.js";
export type {
  ConstructionSource,
  EvolutionSource,
  MemoryPrompts,
} from "./prompts.js";
export {
  constructionResponseSchema,
  evolutionResponseSchema,
  evolutionUpdateSchema,
  ModelResponseError,
  readConstructionResponse,
  readEvolutionResponse,
} from "./response.js";
export type {
  ConstructionResponse,
  EvolutionResponse,
  EvolutionUpdate,
} from "./response.js";

/** Source material accepted for a new note. Provenance is caller-supplied and returned unchanged. */
export interface AddInput {
  content: string;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
}

export interface MemoryOptions {
  neighbors?: number;
  prompts?: Partial<MemoryPrompts>;
}

export interface SearchOptions {
  limit?: number;
  linkedLimit?: number;
}

/** Direct matches keep their score; linked additions are distinct notes found through one hop. */
export type SearchResult =
  { note: Note; via: "match"; score: number } | { note: Note; via: "link" };
