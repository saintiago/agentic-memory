/**
 * Memory public contract: add source content, search for direct matches and bounded linked
 * additions, and inspect stored notes. This module owns the input and result types exchanged with
 * the host and the orchestration that implements them.
 *
 * See docs/memory.md and docs/architecture.md#public-contracts.
 */

export { AgenticMemory } from "./agentic-memory.js";
export type {
  AddInput,
  MemoryOptions,
  SearchOptions,
  SearchResult,
} from "./agentic-memory.js";
export { MemoryError } from "./memory-error.js";
export type {
  MemoryErrorDetails,
  MemoryOperation,
  MemoryPersistence,
  MemoryStage,
} from "./memory-error.js";
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
export { embeddingText } from "./representation.js";
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
