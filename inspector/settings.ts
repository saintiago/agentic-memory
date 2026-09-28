/**
 * Explicit host settings of the local memory inspection host. Nothing is discovered: every value
 * comes from an environment variable supplied by the host, and an incomplete configuration fails
 * before the service is contacted or any local file is read.
 *
 * See docs/dashboard.md#startup-and-composition and inspector/README.md.
 */
import { z } from "zod";

/** The loopback port the inspection host binds by default. */
export const defaultInspectionPort = 4747;
/** The interval between periodic inspection refreshes by default, in milliseconds. */
export const defaultPollIntervalMs = 30_000;
/** The whole-request timeout of every memory service call by default. */
export const defaultServiceTimeoutMs = 120_000;

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

/**
 * Host settings the inspection process needs. The service URL is the only data access it owns;
 * the service itself stays the owner of the collection, providers and credentials.
 */
const settingsSchema = z.strictObject({
  port: z
    .int("AMEM_INSPECTOR_PORT must be a safe integer.")
    .min(0, "AMEM_INSPECTOR_PORT must be between 0 and 65535.")
    .max(65535, "AMEM_INSPECTOR_PORT must be between 0 and 65535."),
  service: z.strictObject({
    url: z.string().min(1, "AMEM_SERVICE_URL must be nonempty."),
    timeoutMs: z
      .int("AMEM_SERVICE_TIMEOUT_MS must be a safe integer.")
      .positive("AMEM_SERVICE_TIMEOUT_MS must be positive."),
  }),
  pollIntervalMs: z
    .int("AMEM_INSPECTOR_POLL_INTERVAL_MS must be a safe integer.")
    .nonnegative("AMEM_INSPECTOR_POLL_INTERVAL_MS must not be negative."),
  artifactsDirectory: z
    .string()
    .min(1, "AMEM_INSPECTOR_ARTIFACTS_DIR must be nonempty."),
  uiDirectory: z.string().min(1, "AMEM_INSPECTOR_UI_DIR must be nonempty."),
});

/** Everything the inspection host needs to reach the service, project vectors and serve the browser. */
export type InspectionSettings = z.infer<typeof settingsSchema>;

/**
 * Read and validate every host setting. A missing or malformed value fails here, before the host
 * contacts the service or reads a stored projection artifact.
 */
export const readInspectionSettings = (
  env: Readonly<Record<string, string | undefined>>,
): InspectionSettings => {
  const candidate = {
    port: integerSetting(env, "AMEM_INSPECTOR_PORT", defaultInspectionPort),
    service: {
      url: requiredSetting(env, "AMEM_SERVICE_URL"),
      timeoutMs: integerSetting(
        env,
        "AMEM_SERVICE_TIMEOUT_MS",
        defaultServiceTimeoutMs,
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
