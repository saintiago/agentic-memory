/**
 * The recorded representative reproduction: replay the retained failed observations through the
 * same public Memory pipeline against fresh isolated collections, with the pinned encoder, the
 * configured provider transport and full raw-exchange recording. The provider request adjustments
 * the live host applied (JSON-object response format, thinking disabled) are an explicit setting,
 * so the reproduction does not quietly change provider behavior while claiming to reproduce it.
 *
 * See docs/evaluation.md#quality-maintenance-procedure and docs/prompts.md#validation.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  openReferenceEmbedder,
  referenceEncoderSettings,
  type MemoryPrompts,
  type JsonValue,
} from "../../src/index.js";
import { createHostModelTransport } from "../../examples/host-model-transport.js";
import { createLiveEnvironment } from "../live/environment.js";
import { RecordedExchanges, createRecordingFetch } from "../live/exchange.js";
import { recordedThinking } from "../live/settings.js";
import {
  fixtureHash,
  readQueryCases,
  readSourceEntries,
  validateFixture,
} from "../replay/fixture.js";
import { reportSummaryLines } from "../replay/report-summary.js";
import { runReplay, type ReplayResult } from "../replay/runner.js";
import type { RunReport } from "../replay/artifacts.js";
import { readRetainedBaseline } from "./evidence.js";
import { baselinePath } from "./layout.js";
import type { QdrantTarget } from "./qdrant-snapshots.js";

/** The provider request shape one reproduction replay sends. */
export type ProviderRequestMode = "unchanged" | "deepseek-json-object";

/** Which prompt text one reproduction uses. */
export type PromptTextSource = "retained-baseline" | "current-defaults";

/**
 * The conditions one reproduction records: the provider adjustments, the retained baseline
 * revision and which prompt text the executing revision used. The run manifest itself carries the
 * executing revision and the exact prompt text, so before/after evidence stays attributable.
 */
export const reproductionConditions = (input: {
  providerRequestMode: ProviderRequestMode;
  baselineRevision: string;
  promptTextSource: PromptTextSource;
}): Record<string, JsonValue> => ({
  providerRequestMode: input.providerRequestMode,
  providerAdjustments:
    input.providerRequestMode === "deepseek-json-object"
      ? "thinking disabled and JSON-object response format applied"
      : "request sent unchanged",
  baselineRevision: input.baselineRevision,
  promptTextSource: input.promptTextSource,
});

export interface ReproduceOptions {
  root: string;
  qdrant: QdrantTarget;
  /** Prefix of the disposable collections the run may create. */
  collectionBaseName?: string;
  model: {
    endpoint: string;
    id: string;
    apiKey?: string;
    timeoutMs: number;
    maxOutputTokens: number;
    thinking: boolean;
  };
  /** The provider request adjustments the live host applied when the failures occurred. */
  providerRequestMode: ProviderRequestMode;
  embeddingCacheDir: string;
  allowEmbeddingDownloads?: boolean;
  callBudget: number;
  tokenBudget: number;
  /** The executing revision recorded in the run manifest; the operator states it explicitly. */
  revision: string;
  /** The prompt text this run uses, supplied explicitly by the caller. */
  prompts: MemoryPrompts;
  /** Which prompt text `prompts` holds: the retained baseline text or this revision's defaults. */
  promptSource: PromptTextSource;
  runId?: string;
  /**
   * Insert the fixture sources in reverse, so sources that run first in the fixture order get
   * candidate context in this run. Evolution failures need an existing neighborhood; recording
   * both orders gives every representative at least one context-bearing insertion.
   */
  reverseInsertionOrder?: boolean;
}

/**
 * Apply the live host's provider adjustments to the serialized request body. The host wrapper
 * disabled thinking and requested a JSON object for DeepSeek; a reproduction that omitted this
 * would run with different provider settings than the failed attempts.
 */
export const providerFetch = (input: {
  mode: ProviderRequestMode;
  fetch: typeof globalThis.fetch;
}): typeof globalThis.fetch => {
  if (input.mode === "unchanged") {
    return input.fetch;
  }
  return async (request, init) => {
    // Only body parsing may fall back to an unadjusted request: a transport failure must
    // propagate from the single fetch below instead of triggering an implicit second request.
    let adjusted = init;
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        body["thinking"] = { type: "disabled" };
        body["response_format"] = { type: "json_object" };
        adjusted = {
          ...init,
          body: JSON.stringify(body),
        };
      } catch {
        // A non-JSON body is forwarded unchanged; the transport owns its own serialization.
      }
    }
    return await input.fetch(request, adjusted);
  };
};

/** Run one recorded reproduction of the retained representative failures. */
export const reproduceFailures = async (
  options: ReproduceOptions,
): Promise<{ result: ReplayResult; report: RunReport }> => {
  const baseline = await readRetainedBaseline(options.root);
  const baselineRevision = baseline.manifest.revision;
  const sourcesText = await readFile(
    baselinePath(options.root, "reproductionSources"),
    "utf8",
  );
  const queriesText = await readFile(
    baselinePath(options.root, "reproductionQueries"),
    "utf8",
  );
  const sources = readSourceEntries(sourcesText);
  const queries = readQueryCases(queriesText);
  validateFixture(sources, queries);
  if (sources.length === 0) {
    throw new Error(
      "The retained reproduction fixture is empty; inspect the receipts again.",
    );
  }
  const insertionOrder =
    options.reverseInsertionOrder === true
      ? sources.map((source) => source.sourceId).reverse()
      : undefined;

  const exchanges = new RecordedExchanges();
  const model = createHostModelTransport({
    endpoint: options.model.endpoint,
    model: options.model.id,
    timeoutMs: options.model.timeoutMs,
    maxOutputTokens: options.model.maxOutputTokens,
    fetch: createRecordingFetch({
      exchanges,
      keepBodies: true,
      fetch: providerFetch({
        mode: options.providerRequestMode,
        fetch: globalThis.fetch,
      }),
      ...(options.model.apiKey === undefined
        ? {}
        : { apiKey: options.model.apiKey }),
    }),
    ...(options.model.apiKey === undefined
      ? {}
      : { apiKey: options.model.apiKey }),
  });
  const embedder = await openReferenceEmbedder({
    cacheDir: options.embeddingCacheDir,
    allowDownloads: options.allowEmbeddingDownloads ?? false,
  });
  const runId =
    options.runId ??
    `reproduction-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const environment = createLiveEnvironment({
    url: options.qdrant.url,
    baseName: options.collectionBaseName ?? "amem-baseline-reproduction",
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
      endpoint: options.model.endpoint,
      id: options.model.id,
      thinking: recordedThinking(options.model.thinking),
      maxOutputTokens: options.model.maxOutputTokens,
      timeoutMs: options.model.timeoutMs,
      retries: 0,
    },
    ...(options.qdrant.apiKey === undefined
      ? {}
      : { apiKey: options.qdrant.apiKey }),
    ...(options.qdrant.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.qdrant.timeoutMs }),
    cleanup: true,
  });
  try {
    const result = await runReplay({
      runId,
      revision: options.revision,
      runsDirectory: baselinePath(options.root, "runs"),
      sources,
      queries,
      prompts: options.prompts,
      sourceHash: fixtureHash(sourcesText),
      queryHash: fixtureHash(queriesText),
      ...(insertionOrder === undefined ? {} : { insertionOrder }),
      environment,
      recordRawExchanges: true,
      artifactCredentials: [options.model.apiKey].filter(
        (credential): credential is string => credential !== undefined,
      ),
      budget: {
        callBudget: options.callBudget,
        tokenBudget: options.tokenBudget,
      },
      conditions: reproductionConditions({
        providerRequestMode: options.providerRequestMode,
        baselineRevision,
        promptTextSource: options.promptSource,
      }),
      limits: [
        "This reproduction rebuilds candidate context from the selected failed sources; it does " +
          "not restore the live corpus neighborhood of the original attempt.",
        "A reproduction that does not fail is one stochastic isolated run, not evidence that the " +
          "original failure was unreal.",
        options.promptSource === "retained-baseline"
          ? `The run uses the prompt text retained for baseline revision ${baselineRevision}; ` +
            "the code that executes and validates responses is the executing revision."
          : "The run uses the executing revision's default prompt text, not the prompt text " +
            "retained with the historical baseline.",
      ],
    });
    const report = JSON.parse(
      await readFile(path.join(result.directory, "report.json"), "utf8"),
    ) as RunReport;
    return { result, report };
  } finally {
    await environment.dispose();
  }
};

/** The sanitized report lines the CLI prints after a reproduction run. */
export const reproductionSummary = (report: RunReport): string[] =>
  reportSummaryLines(report);
