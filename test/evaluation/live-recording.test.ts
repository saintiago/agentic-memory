import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createHostModelTransport } from "../../examples/host-model-transport.js";
import {
  createRecordingFetch,
  RecordedExchanges,
} from "../../experiments/live/exchange.js";
import { createInMemoryEnvironment } from "../../experiments/replay/environment.js";
import { runReplay } from "../../experiments/replay/runner.js";
import type { ModelCallRecord } from "../../experiments/replay/artifacts.js";
import {
  modelDescription,
  testSources,
  TokenEmbedder,
} from "./support/harness.js";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});

const run = async (
  fetch: typeof globalThis.fetch,
  keepBodies = false,
  apiKey?: string,
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "amem-live-recording-"));
  directories.push(directory);
  const exchanges = new RecordedExchanges();
  const model = createHostModelTransport({
    endpoint: "https://provider.example/chat/completions",
    model: "controlled",
    timeoutMs: 1000,
    maxOutputTokens: 100,
    ...(apiKey === undefined ? {} : { apiKey }),
    fetch: createRecordingFetch({
      exchanges,
      fetch,
      keepBodies,
      ...(apiKey === undefined ? {} : { apiKey }),
    }),
  });
  const result = await runReplay({
    runId: "controlled",
    revision: "test",
    runsDirectory: directory,
    sources: testSources,
    queries: [],
    sourceHash: "sources",
    queryHash: "queries",
    environment: createInMemoryEnvironment({
      embedder: new TokenEmbedder(),
      model,
      exchangeLog: exchanges,
      modelDescription,
    }),
    recordRawExchanges: keepBodies,
    budget: { callBudget: 10, tokenBudget: 10000 },
    costRates: {
      currency: "USD",
      effectiveDate: "2026-09-01",
      uncachedInputPerMillion: 1,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 2,
    },
  });
  const text = await readFile(
    path.join(result.directory, "calls.jsonl"),
    "utf8",
  );
  const calls = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ModelCallRecord);
  return { result, calls, exchanges };
};

const usage = {
  prompt_tokens: 10,
  completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 0 },
};
const construction = {
  context: "Records an alpha procedure.",
  keywords: ["alpha"],
  tags: [],
};

/** The real transport, recording fetch and replay recorder together, with controlled HTTP responses. */
describe("live call artifacts", () => {
  for (const stage of ["construct", "evolve"] as const) {
    it.each(["length", "invalid-json", "http-error"])(
      `includes measured ${stage} failure usage (%s) in cost and budget`,
      async (failure) => {
        let count = 0;
        const failAt = stage === "construct" ? 1 : 3;
        const { result, calls } = await run(async () => {
          count += 1;
          const failed = count === failAt;
          return new Response(
            JSON.stringify({
              error: failed ? { message: "controlled rejection" } : undefined,
              choices: [
                {
                  finish_reason:
                    failed && failure === "length" ? "length" : "stop",
                  message: {
                    content:
                      failed && failure === "invalid-json"
                        ? "{"
                        : JSON.stringify(construction),
                  },
                },
              ],
              usage,
            }),
            { status: failed && failure === "http-error" ? 401 : 200 },
          );
        });
        expect(result.status).toBe("failed");
        expect(calls.at(-1)).toMatchObject({
          stage,
          usage: { inputTokens: 10, outputTokens: 100, cachedInputTokens: 0 },
        });
        expect(calls.at(-1)?.error).not.toBeNull();
        expect(result.report.usage).toMatchObject({
          known: true,
          inputTokens: 10 * failAt,
          outputTokens: 100 * failAt,
          cachedInputTokens: 0,
        });
        expect(result.report.counts.failedModelCalls).toBe(1);
        expect(result.report.cost.known).toBe(true);
        expect(result.report.cost.total).toBeCloseTo(0.00021 * failAt, 12);
        expect(result.report.budget).toMatchObject({
          tokensUsed: 110 * failAt,
          usageComplete: true,
        });
      },
    );
  }

  for (const keepBodies of [false, true]) {
    it.each(["http-error", "finish-reason"])(
      `redacts credential echoes with body retention ${String(keepBodies)} (%s)`,
      async (failure) => {
        const apiKey = 'synthetic-"key\\value';
        const echo = `Bearer ${apiKey}`;
        const { result, calls, exchanges } = await run(
          async () =>
            new Response(
              JSON.stringify({
                id: echo,
                error: { message: echo },
                choices: [{ finish_reason: echo, message: { content: "{}" } }],
                usage,
              }),
              { status: failure === "http-error" ? 401 : 200 },
            ),
          keepBodies,
          apiKey,
        );
        expect(result.status).toBe("failed");
        expect(calls[0]).toMatchObject({
          finishReason: "[redacted]",
          requestId: "[redacted]",
        });
        expect(calls[0]?.error?.message).toContain("[redacted]");
        expect(exchanges.entries[0]?.responseBody).not.toContain("synthetic-");
        if (keepBodies) expect(calls[0]?.rawResponse).toContain("[redacted]");
        else expect(calls[0]?.rawResponse).toBeNull();
        for (const file of ["calls.jsonl", "changes.jsonl", "report.json"]) {
          expect(
            await readFile(path.join(result.directory, file), "utf8"),
          ).not.toContain("synthetic-");
        }
      },
    );
  }
});
