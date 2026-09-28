/**
 * Explicit host settings of the local memory service. Every value comes from an environment
 * variable supplied by the supervising host; an incomplete or malformed configuration fails
 * before the journal, the HTTP listener or any provider is opened. Provider-owned endpoint and
 * credential rules run here as well, so a typo cannot bind durable state to a configuration the
 * providers would reject later.
 *
 * See docs/service.md#configuration-and-local-access and service/README.md.
 */
import { z } from "zod";

import {
  parseQdrantNoteStoreOptions,
  referenceEmbeddingSpace,
} from "../src/index.js";
import { parseHostModelTransportOptions } from "./model-transport.js";

/** The loopback port the service binds by default. */
export const defaultServicePort = 4748;
/** The default maximum JSON request body size, measured in UTF-8 bytes. */
export const defaultBodyLimitBytes = 1_048_576;
/** How long a graceful shutdown may take before the host forces the process to exit. */
export const defaultShutdownGraceMs = 30_000;

const optionalSetting = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
};

const requiredSetting = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string => {
  const value = optionalSetting(env, name);
  if (value === undefined) {
    throw new Error(`${name} must be supplied by the host.`);
  }
  return value;
};

const integerSetting = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number => {
  const value = optionalSetting(env, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer.`);
  }
  return parsed;
};

const booleanSetting = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
): boolean => {
  const value = optionalSetting(env, name);
  if (value === undefined) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be "true" or "false".`);
};

/**
 * Service settings. The Qdrant connection rules stay owned by the store's public initialization
 * contract and the model request bounds by the transport, which validate them before a request.
 */
const settingsSchema = z.strictObject({
  port: z
    .int("AMEM_SERVICE_PORT must be a safe integer.")
    .min(0, "AMEM_SERVICE_PORT must be between 0 and 65535.")
    .max(65535, "AMEM_SERVICE_PORT must be between 0 and 65535."),
  bodyLimitBytes: z
    .int("AMEM_SERVICE_BODY_LIMIT_BYTES must be a safe integer.")
    .positive("AMEM_SERVICE_BODY_LIMIT_BYTES must be positive."),
  shutdownGraceMs: z
    .int("AMEM_SERVICE_SHUTDOWN_GRACE_MS must be a safe integer.")
    .positive("AMEM_SERVICE_SHUTDOWN_GRACE_MS must be positive."),
  /** The durable queue directory; it must be outside temporary and task directories. */
  dataDirectory: z.string().min(1, "AMEM_SERVICE_DATA_DIR must be nonempty."),
  qdrant: z.strictObject({
    url: z.string().min(1, "AMEM_QDRANT_URL must be nonempty."),
    apiKey: z
      .string()
      .min(1, "AMEM_QDRANT_API_KEY must be nonempty.")
      .optional(),
    collection: z.string().min(1, "AMEM_QDRANT_COLLECTION must be nonempty."),
    timeoutMs: z
      .int("AMEM_QDRANT_TIMEOUT_MS must be a safe integer.")
      .positive("AMEM_QDRANT_TIMEOUT_MS must be positive."),
  }),
  embedding: z.strictObject({
    cacheDir: z.string().min(1, "AMEM_EMBEDDING_CACHE must be nonempty."),
    allowDownloads: z.boolean(),
  }),
  model: z.strictObject({
    endpoint: z.string().min(1, "AMEM_MODEL_ENDPOINT must be nonempty."),
    model: z.string().min(1, "AMEM_MODEL_ID must be nonempty."),
    apiKey: z
      .string()
      .min(1, "AMEM_MODEL_API_KEY must be nonempty.")
      .optional(),
    timeoutMs: z
      .int("AMEM_MODEL_TIMEOUT_MS must be a safe integer.")
      .positive("AMEM_MODEL_TIMEOUT_MS must be positive."),
    maxOutputTokens: z
      .int("AMEM_MODEL_MAX_OUTPUT_TOKENS must be a safe integer.")
      .positive("AMEM_MODEL_MAX_OUTPUT_TOKENS must be positive."),
  }),
});

/** Everything the service needs to own its collection, queue, providers and HTTP surface. */
export type ServiceSettings = z.infer<typeof settingsSchema>;

/** The message of one initialization or validation failure, without a provider's own values. */
const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Join one zod or ordinary failure into the single diagnostic a settings failure publishes. */
const describeIssues = (cause: unknown): string => {
  const issues = (cause as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    const messages = issues.flatMap((issue: unknown) =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as { message?: unknown }).message === "string"
        ? [(issue as { message: string }).message]
        : [],
    );
    if (messages.length > 0) {
      return messages.join(" ");
    }
  }
  return describeCause(cause);
};

/**
 * Validate the provider-owned configuration rules before the durable journal or a provider is
 * touched. The store and the model transport own these rules; this module only runs them, so no
 * provider value (including a rejected credential) is echoed into the failure.
 */
export const validateProviderSettings = (
  settings: Pick<ServiceSettings, "qdrant" | "model">,
): void => {
  const steps: readonly [string, () => void][] = [
    [
      "The Qdrant provider settings",
      () => {
        parseQdrantNoteStoreOptions({
          ...settings.qdrant,
          space: referenceEmbeddingSpace,
        });
      },
    ],
    [
      "The model provider settings",
      () => {
        parseHostModelTransportOptions({ ...settings.model });
      },
    ],
  ];
  for (const [name, validate] of steps) {
    try {
      validate();
    } catch (cause) {
      throw new Error(`${name} are not valid: ${describeIssues(cause)}.`, {
        cause,
      });
    }
  }
};

/**
 * Read and validate every service setting. A missing or malformed value fails here, before the
 * durable journal, the listener or any provider is touched.
 */
export const readServiceSettings = (
  env: Readonly<Record<string, string | undefined>>,
): ServiceSettings => {
  const qdrantApiKey = optionalSetting(env, "AMEM_QDRANT_API_KEY");
  const modelApiKey = optionalSetting(env, "AMEM_MODEL_API_KEY");
  const candidate = {
    port: integerSetting(env, "AMEM_SERVICE_PORT", defaultServicePort),
    bodyLimitBytes: integerSetting(
      env,
      "AMEM_SERVICE_BODY_LIMIT_BYTES",
      defaultBodyLimitBytes,
    ),
    shutdownGraceMs: integerSetting(
      env,
      "AMEM_SERVICE_SHUTDOWN_GRACE_MS",
      defaultShutdownGraceMs,
    ),
    dataDirectory:
      optionalSetting(env, "AMEM_SERVICE_DATA_DIR") ?? ".data/service",
    qdrant: {
      url: requiredSetting(env, "AMEM_QDRANT_URL"),
      collection: requiredSetting(env, "AMEM_QDRANT_COLLECTION"),
      timeoutMs: integerSetting(env, "AMEM_QDRANT_TIMEOUT_MS", 120_000),
      ...(qdrantApiKey === undefined ? {} : { apiKey: qdrantApiKey }),
    },
    embedding: {
      cacheDir:
        optionalSetting(env, "AMEM_EMBEDDING_CACHE") ?? ".data/embeddings",
      allowDownloads: booleanSetting(
        env,
        "AMEM_ALLOW_EMBEDDING_DOWNLOADS",
        true,
      ),
    },
    model: {
      endpoint: requiredSetting(env, "AMEM_MODEL_ENDPOINT"),
      model: requiredSetting(env, "AMEM_MODEL_ID"),
      timeoutMs: integerSetting(env, "AMEM_MODEL_TIMEOUT_MS", 120_000),
      maxOutputTokens: integerSetting(
        env,
        "AMEM_MODEL_MAX_OUTPUT_TOKENS",
        6_000,
      ),
      ...(modelApiKey === undefined ? {} : { apiKey: modelApiKey }),
    },
  };
  const parsed = settingsSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`The memory service settings are not valid (${issues}).`);
  }
  validateProviderSettings(parsed.data);
  return parsed.data;
};
