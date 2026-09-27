import type { JsonValue, Note } from "../note-store/index.js";

/**
 * Memory public contract: add source content, search for direct matches and bounded linked
 * additions, and inspect stored notes. This module owns the input and result types exchanged with
 * the host.
 *
 * See docs/memory.md and docs/architecture.md#public-contracts.
 */

/** Source material accepted for a new note. Provenance is caller-supplied and returned unchanged. */
export interface AddInput {
  content: string;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
}

/** The construction and evolution instruction texts a host may configure independently. */
export interface MemoryPrompts {
  construction: string;
  evolution: string;
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
