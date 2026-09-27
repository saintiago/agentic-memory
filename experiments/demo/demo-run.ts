/**
 * The deterministic demonstration itself: load the committed synthetic fixtures, replay them with
 * an in-memory store and the deterministic stand-ins, and return the written artifacts. It needs no
 * external service, credential or paid call, and repeated runs produce the same decisions.
 *
 * See docs/evaluation.md.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createInMemoryEnvironment } from "../replay/environment.js";
import {
  fixtureHash,
  readQueryCases,
  readSourceEntries,
  validateFixture,
} from "../replay/fixture.js";
import { runReplay, type ReplayResult } from "../replay/runner.js";
import {
  createDeterministicEmbedder,
  createFixtureModel,
} from "./deterministic.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The committed fixture files of the demonstration. */
export const demoFixtureFiles = {
  sources: path.join(
    repositoryRoot,
    "experiments",
    "fixtures",
    "synthetic-sources.jsonl",
  ),
  queries: path.join(
    repositoryRoot,
    "experiments",
    "fixtures",
    "synthetic-queries.jsonl",
  ),
};

/** The default run directory of the demonstration, ignored by Git like other local data. */
export const defaultDemoRunsDirectory = path.join(
  repositoryRoot,
  ".data",
  "evaluations",
);

/** A run ID unique per invocation, so an earlier run directory is never reused. */
export const demoRunId = (): string =>
  `demo-${new Date().toISOString().replace(/[:.]/g, "-")}`;

/** Run the committed demonstration fixtures into one fresh run directory. */
export const runDeterministicDemo = async (options: {
  runsDirectory: string;
  runId?: string;
  revision?: string;
}): Promise<ReplayResult> => {
  const sourceText = await readFile(demoFixtureFiles.sources, "utf8");
  const queryText = await readFile(demoFixtureFiles.queries, "utf8");
  const sources = readSourceEntries(sourceText);
  const queries = readQueryCases(queryText);
  validateFixture(sources, queries);
  const embedder = createDeterministicEmbedder();
  return await runReplay({
    runId: options.runId ?? demoRunId(),
    revision: options.revision ?? "working-tree",
    runsDirectory: options.runsDirectory,
    sources,
    queries,
    sourceHash: fixtureHash(sourceText),
    queryHash: fixtureHash(queryText),
    environment: createInMemoryEnvironment({
      embedder,
      model: createFixtureModel(),
      encoderSettings: {
        kind: "deterministic-token-hashing",
        dimensions: embedder.space.dimensions,
      },
      modelDescription: {
        endpoint: null,
        id: "fixture-driven-stand-in",
        thinking: "disabled-external",
        maxOutputTokens: null,
        timeoutMs: null,
        retries: 0,
      },
    }),
    directLimit: 2,
    linkedLimit: 3,
    recordRawExchanges: true,
    limits: [
      "The demonstration uses an in-memory store, a token-hashing embedder and a fixture-driven " +
        "model stand-in; it exercises the harness, not encoder, model or retrieval quality.",
      "Its timings measure in-process components, not storage or provider performance.",
      "No encoder or provider transport is loaded and the in-memory store exposes no collection " +
        "index, so the startup durations, indexed-vector count and storage configuration are " +
        "reported as unmeasured rather than invented.",
    ],
  });
};
