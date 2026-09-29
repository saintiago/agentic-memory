/**
 * The example host model transport re-exports the minimal OpenAI-compatible transport the local
 * memory service owns, so host composition and the service share one implementation. A consumer
 * copies, adapts or replaces it; the library never constructs a provider.
 *
 * See docs/language-model.md#transport-behavior and examples/README.md.
 */
export * from "../service/model-transport.js";
