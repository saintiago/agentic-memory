/**
 * Embeddings public contract: text-to-vector conversion and the identity of the embedding space.
 *
 * See docs/embeddings.md and docs/architecture.md#public-contracts.
 */

export type { Embedder, EmbeddingSpace } from "./embedder.js";
export {
  embeddingSpaceId,
  openReferenceEmbedder,
  referenceEncoderSettings,
} from "./local-embedder.js";
export type {
  EncoderSettings,
  ReferenceEmbedder,
  ReferenceEmbedderOptions,
  ReferenceEncoderSettings,
} from "./local-embedder.js";
