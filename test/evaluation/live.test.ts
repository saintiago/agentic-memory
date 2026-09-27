import { describe, expect, it } from "vitest";

import {
  createRecordingFetch,
  readProviderDetails,
  RecordedExchanges,
} from "../../experiments/live/exchange.js";
import {
  LiveSettingsError,
  readLiveSettings,
} from "../../experiments/live/settings.js";

/**
 * The opt-in live plumbing that is testable without a provider: explicit settings parsing and raw
 * exchange recording. The real boundary lives in the integration scope.
 *
 * See docs/evaluation.md#performance-and-cost and docs/testing.md#live-boundaries-and-performance.
 */

const requiredEnvironment = {
  AMEM_LIVE_QDRANT_URL: "http://127.0.0.1:16333",
  AMEM_LIVE_MODEL_ENDPOINT: "https://provider.example/chat/completions",
  AMEM_LIVE_MODEL_ID: "reference-model",
  AMEM_LIVE_CALL_BUDGET: "40",
  AMEM_LIVE_TOKEN_BUDGET: "60000",
};

describe("live settings", () => {
  it("names every missing required setting and starts nothing", () => {
    expect(() => readLiveSettings({}, "/repo")).toThrowError(
      /AMEM_LIVE_QDRANT_URL[\s\S]*AMEM_LIVE_TOKEN_BUDGET/,
    );
    let error: LiveSettingsError | undefined;
    try {
      readLiveSettings({}, "/repo");
    } catch (cause) {
      error = cause as LiveSettingsError;
    }
    expect(error).toBeInstanceOf(LiveSettingsError);
    expect(error?.message).toContain("AMEM_LIVE_MODEL_ENDPOINT");
  });

  it("reads the required settings with documented defaults", () => {
    const settings = readLiveSettings(requiredEnvironment, "/repo");
    expect(settings).toMatchObject({
      qdrantUrl: "http://127.0.0.1:16333",
      qdrantApiKey: undefined,
      modelEndpoint: "https://provider.example/chat/completions",
      modelId: "reference-model",
      modelTimeoutMs: 120_000,
      modelMaxOutputTokens: 6_000,
      modelThinking: false,
      allowEmbeddingDownloads: true,
      callBudget: 40,
      tokenBudget: 60_000,
      recordRawExchanges: false,
      keepCollections: false,
      costRates: null,
      revision: "unknown",
    });
    expect(settings.embeddingCacheDir).toBe("/repo/.data/embeddings");
    expect(settings.runsDirectory).toBe("/repo/.data/evaluations");
  });

  it("reads explicit values and declared cost rates", () => {
    const settings = readLiveSettings(
      {
        ...requiredEnvironment,
        AMEM_LIVE_MODEL_API_KEY: "secret",
        AMEM_LIVE_MODEL_THINKING: "false",
        AMEM_LIVE_RECORD_RAW_EXCHANGES: "true",
        AMEM_LIVE_KEEP_COLLECTIONS: "true",
        AMEM_LIVE_REVISION: "abc123",
        AMEM_LIVE_INSERTION_ORDER: "second, first",
        AMEM_LIVE_CALL_BUDGET: "5",
        AMEM_LIVE_COST_RATES: JSON.stringify({
          currency: "USD",
          effectiveDate: "2026-09-01",
          uncachedInputPerMillion: 0.28,
          cachedInputPerMillion: 0.028,
          outputPerMillion: 0.42,
        }),
      },
      "/repo",
    );
    expect(settings.costRates).toEqual({
      currency: "USD",
      effectiveDate: "2026-09-01",
      uncachedInputPerMillion: 0.28,
      cachedInputPerMillion: 0.028,
      outputPerMillion: 0.42,
    });
    expect(settings.recordRawExchanges).toBe(true);
    expect(settings.keepCollections).toBe(true);
    expect(settings.revision).toBe("abc123");
    expect(settings.insertionOrder).toEqual(["second", "first"]);
  });

  it("rejects malformed budgets, booleans and rates", () => {
    expect(() =>
      readLiveSettings(
        { ...requiredEnvironment, AMEM_LIVE_CALL_BUDGET: "0" },
        "/repo",
      ),
    ).toThrowError(/AMEM_LIVE_CALL_BUDGET must be a positive safe integer/);
    expect(() =>
      readLiveSettings(
        { ...requiredEnvironment, AMEM_LIVE_RECORD_RAW_EXCHANGES: "yes" },
        "/repo",
      ),
    ).toThrowError(/must be "true" or "false"/);
    expect(() =>
      readLiveSettings(
        { ...requiredEnvironment, AMEM_LIVE_COST_RATES: "{" },
        "/repo",
      ),
    ).toThrowError(/must be a JSON object/);
    expect(() =>
      readLiveSettings(
        {
          ...requiredEnvironment,
          AMEM_LIVE_COST_RATES: JSON.stringify({ currency: "USD" }),
        },
        "/repo",
      ),
    ).toThrowError(/AMEM_LIVE_COST_RATES is invalid/);
  });
});

describe("provider exchange recording", () => {
  const providerBody = JSON.stringify({
    id: "chatcmpl-1",
    choices: [{ finish_reason: "stop", message: { content: "{}" } }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 20 },
    },
  });

  it("reads usage, finish reason and request ID, and leaves the response readable", async () => {
    const exchanges = new RecordedExchanges();
    const recording = createRecordingFetch({
      exchanges,
      fetch: (async () =>
        new Response(providerBody, { status: 200 })) as typeof globalThis.fetch,
    });
    const response = await recording("https://provider.example/chat", {
      method: "POST",
      body: '{"model":"m"}',
    });
    expect(await response.text()).toBe(providerBody);
    expect(exchanges.entries).toHaveLength(1);
    expect(exchanges.entries[0]).toMatchObject({
      requestBody: '{"model":"m"}',
      status: 200,
      finishReason: "stop",
      requestId: "chatcmpl-1",
      usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 },
    });
    expect(exchanges.index()).toBe(1);
    expect(exchanges.since(0)).toHaveLength(1);
    expect(exchanges.since(1)).toHaveLength(0);
  });

  it("keeps bodies out of the log when the run did not opt in", async () => {
    const exchanges = new RecordedExchanges();
    const recording = createRecordingFetch({
      exchanges,
      keepBodies: false,
      fetch: (async () =>
        new Response(providerBody, { status: 200 })) as typeof globalThis.fetch,
    });
    await recording("https://provider.example/chat", {
      body: "private prompt",
    });
    expect(exchanges.entries[0]).toMatchObject({
      requestBody: "",
      usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 },
    });
  });

  it("keeps unknown usage unknown for a body it cannot read", () => {
    expect(readProviderDetails("not json")).toEqual({
      usage: null,
      finishReason: null,
      requestId: null,
    });
    expect(readProviderDetails(JSON.stringify({ choices: [] }))).toEqual({
      usage: null,
      finishReason: null,
      requestId: null,
    });
  });
});
