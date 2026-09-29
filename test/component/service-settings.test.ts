import { describe, expect, it } from "vitest";

import {
  defaultBodyLimitBytes,
  defaultServicePort,
  defaultShutdownGraceMs,
  readServiceSettings,
} from "../../service/settings.js";

/**
 * Component tests for the explicit host settings of the memory service: documented defaults,
 * every override and the checks that fail before the journal or a provider is touched.
 *
 * See service/README.md and docs/service.md#configuration-and-local-access.
 */

const required = {
  AMEM_QDRANT_URL: "http://127.0.0.1:16333",
  AMEM_QDRANT_COLLECTION: "notes",
  AMEM_MODEL_ENDPOINT: "https://model.example/chat/completions",
  AMEM_MODEL_ID: "deepseek-chat",
} as const;

describe("memory service settings", () => {
  it("applies the documented defaults", () => {
    expect(readServiceSettings(required)).toEqual({
      port: defaultServicePort,
      bodyLimitBytes: defaultBodyLimitBytes,
      shutdownGraceMs: defaultShutdownGraceMs,
      dataDirectory: ".data/service",
      qdrant: {
        url: "http://127.0.0.1:16333",
        collection: "notes",
        timeoutMs: 120_000,
      },
      embedding: { cacheDir: ".data/embeddings", allowDownloads: true },
      model: {
        endpoint: "https://model.example/chat/completions",
        model: "deepseek-chat",
        timeoutMs: 120_000,
        maxOutputTokens: 6_000,
      },
    });
  });

  it("reads every overridden setting, including a free loopback port", () => {
    expect(
      readServiceSettings({
        ...required,
        AMEM_SERVICE_PORT: "0",
        AMEM_SERVICE_BODY_LIMIT_BYTES: "2048",
        AMEM_SERVICE_SHUTDOWN_GRACE_MS: "5000",
        AMEM_SERVICE_DATA_DIR: "/var/lib/amem/service",
        AMEM_QDRANT_API_KEY: "qdrant-key",
        AMEM_QDRANT_TIMEOUT_MS: "1000",
        AMEM_EMBEDDING_CACHE: "/tmp/embeddings",
        AMEM_ALLOW_EMBEDDING_DOWNLOADS: "false",
        AMEM_MODEL_API_KEY: "model-key",
        AMEM_MODEL_TIMEOUT_MS: "2000",
        AMEM_MODEL_MAX_OUTPUT_TOKENS: "512",
      }),
    ).toEqual({
      port: 0,
      bodyLimitBytes: 2048,
      shutdownGraceMs: 5000,
      dataDirectory: "/var/lib/amem/service",
      qdrant: {
        url: "http://127.0.0.1:16333",
        collection: "notes",
        timeoutMs: 1000,
        apiKey: "qdrant-key",
      },
      embedding: { cacheDir: "/tmp/embeddings", allowDownloads: false },
      model: {
        endpoint: "https://model.example/chat/completions",
        model: "deepseek-chat",
        timeoutMs: 2000,
        maxOutputTokens: 512,
        apiKey: "model-key",
      },
    });
  });

  it("fails before journal or provider work on missing or malformed values", () => {
    expect(() => readServiceSettings({})).toThrow(
      "AMEM_QDRANT_URL must be supplied by the host.",
    );
    expect(() =>
      readServiceSettings({ AMEM_QDRANT_URL: "http://127.0.0.1:16333" }),
    ).toThrow("AMEM_QDRANT_COLLECTION must be supplied by the host.");
    expect(() =>
      readServiceSettings({
        AMEM_QDRANT_URL: "http://127.0.0.1:16333",
        AMEM_QDRANT_COLLECTION: "notes",
      }),
    ).toThrow("AMEM_MODEL_ENDPOINT must be supplied by the host.");
    expect(() =>
      readServiceSettings({
        AMEM_QDRANT_URL: "http://127.0.0.1:16333",
        AMEM_QDRANT_COLLECTION: "notes",
        AMEM_MODEL_ENDPOINT: "https://model.example/chat/completions",
      }),
    ).toThrow("AMEM_MODEL_ID must be supplied by the host.");
    expect(() =>
      readServiceSettings({ ...required, AMEM_SERVICE_PORT: "not-a-port" }),
    ).toThrow("AMEM_SERVICE_PORT must be a safe integer.");
    expect(() =>
      readServiceSettings({ ...required, AMEM_SERVICE_PORT: "70000" }),
    ).toThrow("AMEM_SERVICE_PORT must be between 0 and 65535.");
    expect(() =>
      readServiceSettings({ ...required, AMEM_SERVICE_BODY_LIMIT_BYTES: "0" }),
    ).toThrow("AMEM_SERVICE_BODY_LIMIT_BYTES must be positive.");
    expect(() =>
      readServiceSettings({ ...required, AMEM_QDRANT_TIMEOUT_MS: "0" }),
    ).toThrow("AMEM_QDRANT_TIMEOUT_MS must be positive.");
    expect(() =>
      readServiceSettings({
        ...required,
        AMEM_ALLOW_EMBEDDING_DOWNLOADS: "yes",
      }),
    ).toThrow('AMEM_ALLOW_EMBEDDING_DOWNLOADS must be "true" or "false".');
  });

  it("rejects the provider endpoints and credentials the providers would refuse", () => {
    // The store and the model transport own these rules; reading the settings runs them, so a
    // malformed configuration never reaches the journal or a provider.
    expect(() =>
      readServiceSettings({ ...required, AMEM_QDRANT_URL: "not-a-url" }),
    ).toThrow(
      /Qdrant provider settings are not valid: A Qdrant URL must start with http:\/\/ or https:\/\//,
    );
    const embedded = (() => {
      try {
        readServiceSettings({
          ...required,
          AMEM_QDRANT_URL: "http://user:secret@127.0.0.1:6333",
        });
        return undefined;
      } catch (cause) {
        return cause as Error;
      }
    })();
    expect(embedded?.message).toMatch(/Qdrant provider settings are not valid/);
    // The rejected credential never appears in the diagnostic.
    expect(embedded?.message).not.toContain("secret");

    expect(() =>
      readServiceSettings({ ...required, AMEM_MODEL_ENDPOINT: "not-a-url" }),
    ).toThrow(/model provider settings are not valid/);
    const credential = "sk-live-SECRET";
    const refused = (() => {
      try {
        readServiceSettings({
          ...required,
          AMEM_MODEL_API_KEY: `unusable\n${credential}`,
        });
        return undefined;
      } catch (cause) {
        return cause as Error;
      }
    })();
    expect(refused?.message).toMatch(/model provider settings are not valid/);
    expect(refused?.message).not.toContain(credential);
  });
});
