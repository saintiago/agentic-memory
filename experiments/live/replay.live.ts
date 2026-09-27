/**
 * The opt-in live evaluation: real Qdrant collections, the pinned local encoder and a host model
 * transport over the configured provider endpoint. It declares a call and token budget up front,
 * uses no implicit retries and stops with a recorded reason when the budget is spent.
 *
 * Run with `npm run replay:live` after exporting the `AMEM_LIVE_*` settings; a missing required
 * setting fails instead of reporting a pass. See experiments/README.md.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  openReferenceEmbedder,
  referenceEncoderSettings,
} from "../../src/index.js";
import { createHostModelTransport } from "../../examples/host-model-transport.js";
import {
  fixtureHash,
  readQueryCases,
  readSourceEntries,
  validateFixture,
} from "../replay/fixture.js";
import { reportSummaryLines } from "../replay/report-summary.js";
import { runReplay } from "../replay/runner.js";
import { createLiveEnvironment } from "./environment.js";
import { createRecordingFetch, RecordedExchanges } from "./exchange.js";
import { readLiveSettings, recordedThinking } from "./settings.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The Qdrant version a live run records with its conditions; an unavailable server stays unknown. */
const qdrantVersion = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(new URL("/", url), {
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
};

describe("live replay", () => {
  it("runs the fixture against real Qdrant and the configured model", async () => {
    const settings = readLiveSettings(process.env, repositoryRoot);
    const sourceText = await readFile(settings.sourcesPath, "utf8");
    const queryText = await readFile(settings.queriesPath, "utf8");
    const sources = readSourceEntries(sourceText);
    const queries = readQueryCases(queryText);
    validateFixture(sources, queries);

    // Usage and finish reasons come from the provider exchange; raw prompts and bodies are kept in
    // the artifacts only when the host opted in, because they can contain private source text.
    const exchanges = new RecordedExchanges();
    // The host resolves the transport and the encoder before the replay starts, so their cold cost
    // is measured here and reported apart from the in-run timings.
    const modelStarted = performance.now();
    const model = createHostModelTransport({
      endpoint: settings.modelEndpoint,
      model: settings.modelId,
      timeoutMs: settings.modelTimeoutMs,
      maxOutputTokens: settings.modelMaxOutputTokens,
      fetch: createRecordingFetch({
        exchanges,
        keepBodies: settings.recordRawExchanges,
        ...(settings.modelApiKey === undefined
          ? {}
          : { apiKey: settings.modelApiKey }),
      }),
      ...(settings.modelApiKey === undefined
        ? {}
        : { apiKey: settings.modelApiKey }),
    });
    const modelSetupMs = performance.now() - modelStarted;
    const encoderStarted = performance.now();
    const embedder = await openReferenceEmbedder({
      cacheDir: settings.embeddingCacheDir,
      allowDownloads: settings.allowEmbeddingDownloads,
    });
    const encoderLoadMs = performance.now() - encoderStarted;
    const version = await qdrantVersion(settings.qdrantUrl);
    const environment = createLiveEnvironment({
      url: settings.qdrantUrl,
      baseName: settings.collectionBaseName,
      space: {
        id: embedder.space.id,
        dimensions: embedder.space.dimensions,
        distance: embedder.space.distance,
      },
      embedder,
      model,
      exchanges,
      encoderSettings: { ...referenceEncoderSettings },
      modelDescription: {
        endpoint: settings.modelEndpoint,
        id: settings.modelId,
        thinking: recordedThinking(settings.modelThinking),
        maxOutputTokens: settings.modelMaxOutputTokens,
        timeoutMs: settings.modelTimeoutMs,
        retries: 0,
      },
      timeoutMs: settings.qdrantTimeoutMs,
      cleanup: !settings.keepCollections,
      ...(settings.qdrantApiKey === undefined
        ? {}
        : { apiKey: settings.qdrantApiKey }),
    });

    try {
      const result = await runReplay({
        runId: `live-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        revision: settings.revision,
        runsDirectory: settings.runsDirectory,
        sources,
        queries,
        sourceHash: fixtureHash(sourceText),
        queryHash: fixtureHash(queryText),
        environment,
        startup: { encoderLoadMs, modelSetupMs },
        ...(settings.insertionOrder === null
          ? {}
          : { insertionOrder: settings.insertionOrder }),
        recordRawExchanges: settings.recordRawExchanges,
        budget: {
          callBudget: settings.callBudget,
          tokenBudget: settings.tokenBudget,
        },
        ...(settings.costRates === null
          ? {}
          : { costRates: settings.costRates }),
        ...(version === null ? {} : { conditions: { qdrantVersion: version } }),
        limits: [
          "Live evidence is one stochastic run; repeat it and vary insertion order before " +
            "claiming a quality improvement.",
          "Reported timings include the configured network, provider and hardware conditions; " +
            "they are not a capacity guarantee.",
          "The recorded thinking mode is a host-declared provider setting: this transport sends " +
            "no thinking parameter, so the provider or model ID must honor it.",
        ],
      });
      for (const line of reportSummaryLines(result.report)) {
        console.log(line);
      }
      console.log(`Artifacts: ${result.directory}`);

      // A budget stop is an expected outcome of an opt-in run; an insertion failure is not.
      expect(result.status).not.toBe("failed");
      if (result.status === "stopped") {
        expect(result.stoppingReason).not.toBeNull();
      }
    } finally {
      await environment.dispose();
    }
  }, 3_600_000);
});
