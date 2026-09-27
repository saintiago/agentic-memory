/**
 * LanguageModel public contract: transport an assembled request to a model and return parsed JSON
 * or an explicit failure. Provider selection, credentials and operational settings are host
 * settings.
 *
 * See docs/language-model.md and docs/architecture.md#public-contracts.
 */

/** The memory stage a request belongs to. It routes and observes; it is not a provider model name. */
export interface ModelRequest {
  stage: "construct" | "evolve";
  prompt: string;
}

/**
 * A host-supplied model invocation. The returned value is parsed, untrusted JSON: response schemas
 * belong to the caller, so transport success does not imply a valid memory update.
 */
export interface LanguageModel {
  generate(request: ModelRequest): Promise<unknown>;
}
