/**
 * Memory public contract: add source content, search for direct matches and bounded linked
 * additions, inspect stored notes, and prepare reviewed corrections of existing note contexts and
 * outgoing links. This module owns the input and result types exchanged with the host and the
 * orchestration that implements them.
 *
 * See docs/memory.md and docs/architecture.md#public-contracts.
 */

export { AgenticMemory } from "./agentic-memory.js";
export type {
  AddInput,
  MemoryOptions,
  PrepareInput,
  SearchOptions,
  SearchResult,
} from "./agentic-memory.js";
export { MemoryError } from "./memory-error.js";
export type {
  CorrectionReadOutcome,
  MemoryErrorDetails,
  MemoryOperation,
  MemoryPersistence,
  MemoryStage,
} from "./memory-error.js";
export { contextCorrectionInputSchema } from "./context-correction.js";
export type {
  ContextCorrectionInput,
  ContextCorrectionPreparation,
  ContextCorrectionPreparer,
} from "./context-correction.js";
export { linkCorrectionInputSchema } from "./link-correction.js";
export type {
  LinkCorrectionInput,
  LinkCorrectionPreparer,
} from "./link-correction.js";
export { insertionPlanSchema, insertionPlanVersion } from "./insertion-plan.js";
export type { InsertionPlan } from "./insertion-plan.js";
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
export { embeddingText, representationVersion } from "./representation.js";
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
