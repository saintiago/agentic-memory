/**
 * Supported public exports of the Agentic Memory library. Each component owns its public
 * `index.ts`; this root re-exports the surface consumers may use.
 *
 * See docs/development.md#repository-layout-and-public-boundaries.
 */
export * from "./embeddings/index.js";
export * from "./ingestion-queue/index.js";
export * from "./language-model/index.js";
export * from "./memory/index.js";
export * from "./note-store/index.js";
