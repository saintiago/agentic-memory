/**
 * Live-run settings, read explicitly from the host environment. A live run is opt-in: it refuses to
 * start when a required setting is missing and it declares a call and token budget up front.
 *
 * See docs/evaluation.md#performance-and-cost and docs/development.md#toolchain-and-validation-commands.
 */
import path from "node:path";

import { z } from "zod";

import type { CostRates } from "../replay/artifacts.js";

const line = (name: string): string => `- ${name}`;

/** The host settings one live evaluation needs. */
export interface LiveSettings {
  qdrantUrl: string;
  qdrantApiKey: string | undefined;
  qdrantTimeoutMs: number;
  collectionBaseName: string;
  modelEndpoint: string;
  modelId: string;
  modelApiKey: string | undefined;
  modelTimeoutMs: number;
  modelMaxOutputTokens: number;
  modelThinking: boolean;
  embeddingCacheDir: string;
  allowEmbeddingDownloads: boolean;
  runsDirectory: string;
  sourcesPath: string;
  queriesPath: string;
  /** An explicit insertion order, or `null` for the fixture order. */
  insertionOrder: string[] | null;
  revision: string;
  callBudget: number;
  tokenBudget: number;
  recordRawExchanges: boolean;
  keepCollections: boolean;
  costRates: CostRates | null;
}

/** A missing or malformed live setting; the message names the environment variables. */
export class LiveSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveSettingsError";
  }
}

const costRatesSchema: z.ZodType<CostRates> = z.strictObject({
  currency: z.string().min(1, "A currency must be nonempty."),
  effectiveDate: z.string().min(1, "An effective date must be nonempty."),
  uncachedInputPerMillion: z
    .number()
    .nonnegative("A rate must be nonnegative."),
  cachedInputPerMillion: z.number().nonnegative("A rate must be nonnegative."),
  outputPerMillion: z.number().nonnegative("A rate must be nonnegative."),
});

const optional = (
  env: Record<string, string | undefined>,
  name: string,
): string | undefined => {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
};

const requiredSetting = (
  env: Record<string, string | undefined>,
  name: string,
): string => {
  const value = optional(env, name);
  if (value === undefined) {
    throw new LiveSettingsError(`${name} must be supplied by the host.`);
  }
  return value;
};

const booleanSetting = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean => {
  const value = optional(env, name);
  if (value === undefined) {
    return fallback;
  }
  if (value !== "true" && value !== "false") {
    throw new LiveSettingsError(`${name} must be "true" or "false".`);
  }
  return value === "true";
};

const integerSetting = (
  env: Record<string, string | undefined>,
  name: string,
  fallback?: number,
): number => {
  const value = optional(env, name);
  if (value === undefined) {
    if (fallback === undefined) {
      throw new LiveSettingsError(`${name} must be supplied by the host.`);
    }
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new LiveSettingsError(`${name} must be a positive safe integer.`);
  }
  return parsed;
};

/**
 * Read the live settings. Every required value must be supplied; a schema problem or a missing
 * value fails before an encoder download, a collection or a paid call.
 */
export const readLiveSettings = (
  env: Record<string, string | undefined>,
  repositoryRoot: string,
): LiveSettings => {
  const required = [
    "AMEM_LIVE_QDRANT_URL",
    "AMEM_LIVE_MODEL_ENDPOINT",
    "AMEM_LIVE_MODEL_ID",
    "AMEM_LIVE_CALL_BUDGET",
    "AMEM_LIVE_TOKEN_BUDGET",
  ].filter((name) => optional(env, name) === undefined);
  if (required.length > 0) {
    throw new LiveSettingsError(
      "A live evaluation is explicit opt-in; supply the missing host settings:\n" +
        required.map(line).join("\n") +
        "\nSee docs/evaluation.md#performance-and-cost.",
    );
  }
  const rawRates = optional(env, "AMEM_LIVE_COST_RATES");
  let costRates: CostRates | null = null;
  if (rawRates !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawRates);
    } catch {
      throw new LiveSettingsError(
        "AMEM_LIVE_COST_RATES must be a JSON object with currency, effectiveDate and " +
          "per-million-token rates.",
      );
    }
    const result = costRatesSchema.safeParse(parsed);
    if (!result.success) {
      throw new LiveSettingsError(
        `AMEM_LIVE_COST_RATES is invalid: ${result.error.issues
          .map(
            (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
          )
          .join("; ")}.`,
      );
    }
    costRates = result.data;
  }
  const rawOrder = optional(env, "AMEM_LIVE_INSERTION_ORDER");
  const insertionOrder =
    rawOrder === undefined
      ? null
      : rawOrder
          .split(",")
          .map((sourceId) => sourceId.trim())
          .filter((sourceId) => sourceId !== "");
  if (insertionOrder !== null && insertionOrder.length === 0) {
    throw new LiveSettingsError(
      "AMEM_LIVE_INSERTION_ORDER must list at least one source ID.",
    );
  }
  return {
    qdrantUrl: requiredSetting(env, "AMEM_LIVE_QDRANT_URL"),
    qdrantApiKey: optional(env, "AMEM_LIVE_QDRANT_API_KEY"),
    qdrantTimeoutMs: integerSetting(
      env,
      "AMEM_LIVE_QDRANT_TIMEOUT_MS",
      120_000,
    ),
    collectionBaseName:
      optional(env, "AMEM_LIVE_COLLECTION_BASE") ?? "amem-live-evaluation",
    modelEndpoint: requiredSetting(env, "AMEM_LIVE_MODEL_ENDPOINT"),
    modelId: requiredSetting(env, "AMEM_LIVE_MODEL_ID"),
    modelApiKey: optional(env, "AMEM_LIVE_MODEL_API_KEY"),
    modelTimeoutMs: integerSetting(env, "AMEM_LIVE_MODEL_TIMEOUT_MS", 120_000),
    modelMaxOutputTokens: integerSetting(
      env,
      "AMEM_LIVE_MODEL_MAX_OUTPUT_TOKENS",
      6_000,
    ),
    modelThinking: booleanSetting(env, "AMEM_LIVE_MODEL_THINKING", false),
    embeddingCacheDir:
      optional(env, "AMEM_LIVE_EMBEDDING_CACHE") ??
      path.join(repositoryRoot, ".data", "embeddings"),
    allowEmbeddingDownloads: booleanSetting(
      env,
      "AMEM_LIVE_ALLOW_EMBEDDING_DOWNLOADS",
      true,
    ),
    runsDirectory:
      optional(env, "AMEM_LIVE_RUNS_DIR") ??
      path.join(repositoryRoot, ".data", "evaluations"),
    sourcesPath:
      optional(env, "AMEM_LIVE_SOURCES") ??
      path.join(
        repositoryRoot,
        "experiments",
        "fixtures",
        "synthetic-sources.jsonl",
      ),
    queriesPath:
      optional(env, "AMEM_LIVE_QUERIES") ??
      path.join(
        repositoryRoot,
        "experiments",
        "fixtures",
        "synthetic-queries.jsonl",
      ),
    insertionOrder,
    revision: optional(env, "AMEM_LIVE_REVISION") ?? "unknown",
    callBudget: integerSetting(env, "AMEM_LIVE_CALL_BUDGET"),
    tokenBudget: integerSetting(env, "AMEM_LIVE_TOKEN_BUDGET"),
    recordRawExchanges: booleanSetting(
      env,
      "AMEM_LIVE_RECORD_RAW_EXCHANGES",
      false,
    ),
    keepCollections: booleanSetting(env, "AMEM_LIVE_KEEP_COLLECTIONS", false),
    costRates,
  };
};
