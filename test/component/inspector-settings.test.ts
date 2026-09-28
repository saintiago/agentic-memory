import { describe, expect, it } from "vitest";

import {
  defaultInspectionPort,
  defaultPollIntervalMs,
  readInspectionSettings,
} from "../../inspector/settings.js";

/**
 * Component tests for the explicit host settings of the inspection process: defaults, required
 * values and the checks that fail before any provider is opened.
 *
 * See docs/dashboard.md#startup-and-composition.
 */

const required = {
  AMEM_QDRANT_URL: "http://127.0.0.1:16333",
  AMEM_QDRANT_COLLECTION: "notes",
} as const;

describe("inspection host settings", () => {
  it("applies the documented defaults", () => {
    expect(readInspectionSettings(required)).toEqual({
      port: defaultInspectionPort,
      qdrant: {
        url: "http://127.0.0.1:16333",
        collection: "notes",
        timeoutMs: 120_000,
      },
      embedding: { cacheDir: ".data/embeddings", allowDownloads: true },
      pollIntervalMs: defaultPollIntervalMs,
      artifactsDirectory: ".data/inspector",
      uiDirectory: "inspector/ui",
    });
  });

  it("reads every overridden setting, including a free loopback port", () => {
    expect(
      readInspectionSettings({
        ...required,
        AMEM_QDRANT_API_KEY: "key",
        AMEM_QDRANT_TIMEOUT_MS: "1000",
        AMEM_EMBEDDING_CACHE: "/tmp/cache",
        AMEM_ALLOW_EMBEDDING_DOWNLOADS: "false",
        AMEM_INSPECTOR_PORT: "0",
        AMEM_INSPECTOR_POLL_INTERVAL_MS: "0",
        AMEM_INSPECTOR_ARTIFACTS_DIR: "/tmp/artifacts",
        AMEM_INSPECTOR_UI_DIR: "/tmp/ui",
      }),
    ).toEqual({
      port: 0,
      qdrant: {
        url: "http://127.0.0.1:16333",
        collection: "notes",
        timeoutMs: 1000,
        apiKey: "key",
      },
      embedding: { cacheDir: "/tmp/cache", allowDownloads: false },
      pollIntervalMs: 0,
      artifactsDirectory: "/tmp/artifacts",
      uiDirectory: "/tmp/ui",
    });
  });

  it("fails before provider work on missing or malformed values", () => {
    expect(() => readInspectionSettings({})).toThrow(
      "AMEM_QDRANT_URL must be supplied by the host.",
    );
    expect(() =>
      readInspectionSettings({ AMEM_QDRANT_URL: "http://127.0.0.1:16333" }),
    ).toThrow("AMEM_QDRANT_COLLECTION must be supplied by the host.");
    expect(() =>
      readInspectionSettings({ ...required, AMEM_INSPECTOR_PORT: "12345.5" }),
    ).toThrow("AMEM_INSPECTOR_PORT must be a safe integer.");
    expect(() =>
      readInspectionSettings({ ...required, AMEM_INSPECTOR_PORT: "70000" }),
    ).toThrow("AMEM_INSPECTOR_PORT must be between 0 and 65535.");
    expect(() =>
      readInspectionSettings({
        ...required,
        AMEM_INSPECTOR_POLL_INTERVAL_MS: "-1",
      }),
    ).toThrow("AMEM_INSPECTOR_POLL_INTERVAL_MS must not be negative.");
    expect(() =>
      readInspectionSettings({
        ...required,
        AMEM_ALLOW_EMBEDDING_DOWNLOADS: "yes",
      }),
    ).toThrow('AMEM_ALLOW_EMBEDDING_DOWNLOADS must be "true" or "false".');
  });
});
