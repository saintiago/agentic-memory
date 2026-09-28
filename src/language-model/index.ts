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

/**
 * The machine-readable failure categories a model transport reports, so a caller decides how to
 * react without reading provider text: a rejected credential, a missing provider resource, a
 * temporary outage, and output that cannot be used as an answer.
 */
export type ModelFailureCategory =
  "authentication" | "resource" | "unavailable" | "output";

/**
 * A failed model request as the transport boundary reports it: the stage that failed, one
 * machine-readable category and a safe description that never contains credentials or complete
 * prompts. Memory preserves the error as the underlying cause of its operation failure, and the
 * ingestion queue classifies the receipt by category instead of by provider text.
 */
export class ModelRequestError extends Error {
  readonly stage: ModelRequest["stage"];
  readonly category: ModelFailureCategory;

  constructor(
    stage: ModelRequest["stage"],
    category: ModelFailureCategory,
    reason: string,
  ) {
    super(`The ${stage} model request failed: ${reason}.`);
    this.name = "ModelRequestError";
    this.stage = stage;
    this.category = category;
  }
}
