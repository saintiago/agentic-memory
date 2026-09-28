/**
 * Explicit host settings of the local memory inspection host. Nothing is discovered: every value
 * comes from an environment variable supplied by the host, and an incomplete configuration fails
 * before any provider is opened.
 *
 * See docs/dashboard.md#startup-and-composition and inspector/README.md.
 */
import { z } from "zod";

/** The loopback port the inspection host binds by default. */
export const defaultInspectionPort = 4747;
/** The interval between periodic inspection refreshes by default, in milliseconds. */
export const defaultPollIntervalMs = 30_000;

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
 * Host settings the inspection process needs. The collection connection settings describe the
 * same NoteStore the runtime consumer uses; the Qdrant URL, credential and timeout rules stay
 * owned by the store's public initialization contract, which validates them before a request.
 */
const settingsSchema = z.strictObject({
  port: z
    .int("AMEM_INSPECTOR_PORT must be a safe integer.")
    .min(0, "AMEM_INSPECTOR_PORT must be between 0 and 65535.")
    .max(65535, "AMEM_INSPECTOR_PORT must be between 0 and 65535."),
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
  pollIntervalMs: z
    .int("AMEM_INSPECTOR_POLL_INTERVAL_MS must be a safe integer.")
    .nonnegative("AMEM_INSPECTOR_POLL_INTERVAL_MS must not be negative."),
  artifactsDirectory: z
    .string()
    .min(1, "AMEM_INSPECTOR_ARTIFACTS_DIR must be nonempty."),
  uiDirectory: z.string().min(1, "AMEM_INSPECTOR_UI_DIR must be nonempty."),
});

/** Everything the inspection host needs to open providers, project vectors and serve the browser. */
export type InspectionSettings = z.infer<typeof settingsSchema>;

/**
 * Read and validate every host setting. A missing or malformed value fails here, before an encoder
 * download, a collection creation or any other provider work.
 */
export const readInspectionSettings = (
  env: Readonly<Record<string, string | undefined>>,
): InspectionSettings => {
  const apiKey = optionalSetting(env, "AMEM_QDRANT_API_KEY");
  const candidate = {
    port: integerSetting(env, "AMEM_INSPECTOR_PORT", defaultInspectionPort),
    qdrant: {
      url: requiredSetting(env, "AMEM_QDRANT_URL"),
      collection: requiredSetting(env, "AMEM_QDRANT_COLLECTION"),
      timeoutMs: integerSetting(env, "AMEM_QDRANT_TIMEOUT_MS", 120_000),
      ...(apiKey === undefined ? {} : { apiKey }),
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
    pollIntervalMs: integerSetting(
      env,
      "AMEM_INSPECTOR_POLL_INTERVAL_MS",
      defaultPollIntervalMs,
    ),
    artifactsDirectory:
      optionalSetting(env, "AMEM_INSPECTOR_ARTIFACTS_DIR") ?? ".data/inspector",
    uiDirectory:
      optionalSetting(env, "AMEM_INSPECTOR_UI_DIR") ?? "inspector/ui",
  };
  const parsed = settingsSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`The inspection host settings are not valid (${issues}).`);
  }
  return parsed.data;
};
