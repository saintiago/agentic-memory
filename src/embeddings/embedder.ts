/**
 * Embeddings public contract: text-to-vector conversion and the identity of the embedding space.
 *
 * See docs/embeddings.md and docs/architecture.md#public-contracts.
 */

/**
 * The declared embedding space a store's vectors belong to. The ID identifies the exact encoding
 * configuration, not just a model family; equal dimensions are insufficient evidence of
 * compatibility.
 */
export interface EmbeddingSpace {
  readonly id: string;
  readonly dimensions: number;
  readonly distance: "Cosine";
}

/** A ready encoder. Inference failures reject explicitly rather than returning substituted vectors. */
export interface Embedder {
  readonly space: EmbeddingSpace;
  embed(text: string): Promise<number[]>;
}
