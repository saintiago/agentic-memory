/**
 * The quality-baseline operator CLI: capture, restore, account, reproduce, classify and aggregate
 * one private baseline. Every command takes explicit paths and settings; nothing is discovered from
 * Nexus or the environment except the model credential named by `--model-api-key-env`.
 *
 * See docs/evaluation.md#quality-maintenance-procedure.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { defaultPrompts, referenceEncoderSettings } from "../../src/index.js";
import { captureBaseline } from "./capture.js";
import { compareMatchedRuns, type MatchedComparison } from "./matched.js";
import { classifyReproductionRuns } from "./defects.js";
import { readRetainedBaseline } from "./evidence.js";
import { writeJsonFile } from "./io.js";
import { baselinePath } from "./layout.js";
import { aggregateMetrics } from "./metrics.js";
import {
  selectRepresentativeFailures,
  summarizeReceipts,
  writeFailedEvidence,
  writeReproductionFixture,
} from "./receipts.js";
import { reproduceFailures, reproductionSummary } from "./reproduce.js";
import { restoreBaseline } from "./restore.js";
import { runDeclaredRetrieval } from "./retrieval.js";

const usage = `Usage: npm run baseline -- <command> [options]

Commands:
  capture     Copy the live journal, snapshot its collection and retain the settings and queries.
  restore     Restore the retained pair into isolation and validate every retention check.
  receipts    Account for every receipt, state the failed-output limit and build the reproduction fixture.
  reproduce   Replay the retained representative failures in an isolated, recorded run.
  defects     Classify every retained reproduction run.
  compare     Pair two isolated reproduction runs and report their linked-additions comparison.
  retrieval   Run the declared queries against the restored collection.
  metrics     Aggregate the retained evidence into the baseline numbers with denominators.

The evidence root is never overwritten; a second capture needs a new root.`;

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

const required = (value: string | undefined, flag: string): string => {
  if (value === undefined || value === "") {
    throw new CliError(`${flag} is required.`);
  }
  return value;
};

const positiveInteger = (
  value: string | undefined,
  flag: string,
  fallback: number,
): number => {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive safe integer.`);
  }
  return parsed;
};

const options = {
  root: { type: "string" },
  journal: { type: "string" },
  "qdrant-url": { type: "string" },
  "qdrant-api-key": { type: "string" },
  queries: { type: "string" },
  revision: { type: "string" },
  "model-endpoint": { type: "string" },
  "model-id": { type: "string" },
  "model-thinking": { type: "boolean" },
  "model-max-output-tokens": { type: "string" },
  "model-timeout-ms": { type: "string" },
  "model-api-key": { type: "string" },
  "model-api-key-env": { type: "string" },
  "service-url": { type: "string" },
  "allow-active-writers": { type: "boolean" },
  work: { type: "string" },
  collection: { type: "string" },
  "collection-base": { type: "string" },
  cleanup: { type: "boolean" },
  sample: { type: "string", multiple: true },
  "provider-mode": { type: "string" },
  prompts: { type: "string" },
  "embedding-cache": { type: "string" },
  "allow-embedding-downloads": { type: "boolean" },
  "direct-limit": { type: "string" },
  "linked-limit": { type: "string" },
  "call-budget": { type: "string" },
  "token-budget": { type: "string" },
  "run-id": { type: "string" },
  "reverse-order": { type: "boolean" },
  "exclude-source": { type: "string", multiple: true },
  before: { type: "string" },
  after: { type: "string" },
} as const;

const parse = (args: string[]) =>
  parseArgs({ args, options, allowPositionals: true, strict: true });

const qdrantFrom = (values: {
  "qdrant-url"?: string | undefined;
  "qdrant-api-key"?: string | undefined;
}) => ({
  url: required(values["qdrant-url"], "--qdrant-url"),
  ...(values["qdrant-api-key"] === undefined
    ? {}
    : { apiKey: values["qdrant-api-key"] }),
});

const runCapture = async (args: string[]): Promise<void> => {
  const { values } = parse(args);
  const root = required(values.root, "--root");
  const { manifest, receipts } = await captureBaseline({
    root,
    journalPath: required(values.journal, "--journal"),
    qdrant: qdrantFrom(values),
    queriesPath: required(values.queries, "--queries"),
    revision: required(values.revision, "--revision"),
    settings: {
      prompts: { ...defaultPrompts },
      model: {
        endpoint: required(values["model-endpoint"], "--model-endpoint"),
        id: required(values["model-id"], "--model-id"),
        thinking:
          values["model-thinking"] === true
            ? "enabled-external"
            : "disabled-external",
        maxOutputTokens: positiveInteger(
          values["model-max-output-tokens"],
          "--model-max-output-tokens",
          6_000,
        ),
        timeoutMs: positiveInteger(
          values["model-timeout-ms"],
          "--model-timeout-ms",
          120_000,
        ),
        retries: 0,
      },
      encoder: { ...referenceEncoderSettings },
      service: null,
    },
    ...(values["service-url"] === undefined
      ? {}
      : { serviceUrl: values["service-url"] }),
    allowActiveWriters: values["allow-active-writers"] === true,
  });
  const pending =
    manifest.receipts.counts.queued +
    manifest.receipts.counts.processing +
    manifest.receipts.counts.retrying +
    manifest.receipts.counts.blocked;
  console.log(
    `Captured ${String(receipts.length)} receipts from "${manifest.collection.name}".`,
  );
  console.log(
    `Stored ${String(manifest.receipts.counts.stored)}, failed ` +
      `${String(manifest.receipts.counts.failed)}, pending ${String(pending)}.`,
  );
  console.log(`Quiescent capture: ${String(manifest.quiescent)}.`);
  console.log(`Evidence: ${path.dirname(baselinePath(root, "journal"))}`);
};

const runRestore = async (args: string[]): Promise<void> => {
  const { values } = parse(args);
  const root = required(values.root, "--root");
  const report = await restoreBaseline({
    root,
    workDirectory: required(values.work, "--work"),
    qdrant: qdrantFrom(values),
    ...(values.collection === undefined
      ? {}
      : { collection: values.collection }),
    cleanup: values.cleanup === true,
    ...(values.sample === undefined ? {} : { sampleNoteIds: values.sample }),
  });
  for (const check of report.checks) {
    console.log(`${check.ok ? "ok" : "FAIL"}  ${check.name}: ${check.detail}`);
  }
  console.log(
    `Restored ${String(report.counts.restoredNotes)} notes; ` +
      `${String(report.counts.matchedNotes)}/${String(report.counts.storedReceipts)} stored receipts ` +
      `matched a note; ${String(report.counts.unexplainedNotes)} unexplained.`,
  );
  console.log(`Isolated collection: ${report.isolatedCollection}`);
};

const runReceipts = async (args: string[]): Promise<void> => {
  const { values } = parse(args);
  const root = required(values.root, "--root");
  const baseline = await readRetainedBaseline(root);
  const accounting = summarizeReceipts(baseline.receipts, {
    revision: baseline.manifest.revision,
  });
  const selected = selectRepresentativeFailures(baseline.receipts);
  const fixture = await writeReproductionFixture(
    root,
    baseline.receipts,
    selected,
  );
  await writeFailedEvidence({
    root,
    revision: baseline.manifest.revision,
    accounting,
    selected,
    fixture,
    now: new Date(),
  });
  await writeJsonFile(baselinePath(root, "accounting"), accounting);
  const counts = accounting.statusCounts;
  console.log(
    `Accepted ${String(accounting.acceptedObservations.count)}: stored ${String(counts.stored)}, ` +
      `failed ${String(counts.failed)}, pending ` +
      `${String(counts.queued + counts.processing + counts.retrying)}, blocked ${String(counts.blocked)}.`,
  );
  console.log(
    `Cumulative attempts: ${String(accounting.attempts.total)} across ` +
      `${String(accounting.acceptedObservations.count)} accepted observations; ` +
      `${String(accounting.attempts.byCurrentOutcome.failed)} of them fall on the ` +
      `${String(counts.failed)} receipts currently failed. Per-attempt failure history: ` +
      "unavailable (the journal retains cumulative claims and latest errors only).",
  );
  for (const diagnostic of accounting.failedDiagnostics) {
    console.log(
      `- ${String(diagnostic.count)}/${String(diagnostic.denominator)}: ${diagnostic.diagnostic}`,
    );
  }
  console.log(
    `Raw failed output retained: no. Representative reproduction fixture: ` +
      `${String(selected.length)} sources.`,
  );
  console.log(
    `Next: npm run baseline -- reproduce --root ${root} ` +
      `--revision <executing-revision> ` +
      `--qdrant-url ${baseline.journal.binding.endpoint} ` +
      `--model-endpoint ${baseline.manifest.model.endpoint ?? "<endpoint>"} ` +
      `--model-id ${baseline.manifest.model.id} --embedding-cache <cache> ` +
      "[--prompts baseline|current]",
  );
};

const runReproduce = async (args: string[]): Promise<void> => {
  const { values } = parse(args);
  const root = required(values.root, "--root");
  const baseline = await readRetainedBaseline(root);
  const providerMode = values["provider-mode"] ?? "deepseek-json-object";
  if (providerMode !== "unchanged" && providerMode !== "deepseek-json-object") {
    throw new CliError(
      "--provider-mode must be unchanged or deepseek-json-object.",
    );
  }
  const promptMode = values.prompts ?? "baseline";
  if (promptMode !== "baseline" && promptMode !== "current") {
    throw new CliError("--prompts must be baseline or current.");
  }
  const apiKeyEnv = values["model-api-key-env"] ?? "NEXUS_MEMORY_MODEL_API_KEY";
  const apiKey = values["model-api-key"] ?? process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    throw new CliError(
      `No model credential: set ${apiKeyEnv} or pass --model-api-key.`,
    );
  }
  const { result, report } = await reproduceFailures({
    root,
    qdrant: qdrantFrom(values),
    ...(values["collection-base"] === undefined
      ? {}
      : { collectionBaseName: values["collection-base"] }),
    model: {
      endpoint: required(values["model-endpoint"], "--model-endpoint"),
      id: required(values["model-id"], "--model-id"),
      apiKey,
      timeoutMs: positiveInteger(
        values["model-timeout-ms"],
        "--model-timeout-ms",
        120_000,
      ),
      maxOutputTokens: positiveInteger(
        values["model-max-output-tokens"],
        "--model-max-output-tokens",
        6_000,
      ),
      thinking: false,
    },
    providerRequestMode: providerMode,
    embeddingCacheDir: required(values["embedding-cache"], "--embedding-cache"),
    allowEmbeddingDownloads: values["allow-embedding-downloads"] === true,
    callBudget: positiveInteger(values["call-budget"], "--call-budget", 40),
    tokenBudget: positiveInteger(
      values["token-budget"],
      "--token-budget",
      400_000,
    ),
    revision: required(values.revision, "--revision"),
    prompts:
      promptMode === "baseline"
        ? { ...baseline.manifest.prompts }
        : { ...defaultPrompts },
    promptSource:
      promptMode === "baseline" ? "retained-baseline" : "current-defaults",
    ...(values["run-id"] === undefined ? {} : { runId: values["run-id"] }),
    ...(values["reverse-order"] === true
      ? { reverseInsertionOrder: true }
      : {}),
    ...(values["exclude-source"] === undefined
      ? {}
      : { excludeSources: values["exclude-source"] }),
  });
  console.log(`Run ${result.runId}: ${result.status}.`);
  for (const line of reproductionSummary(report)) {
    console.log(line);
  }
  console.log(`Artifacts: ${result.directory}`);
};

const runDefects = async (args: string[]): Promise<void> => {
  const { values } = parse(args);
  const report = await classifyReproductionRuns(
    required(values.root, "--root"),
  );
  console.log(
    `${String(report.runs.length)} reproduction run(s), ` +
      `${String(report.failingCalls)} failing call(s).`,
  );
  for (const source of report.promptSources) {
    console.log(
      `- ${source.promptTextSource ?? "unrecorded prompt source"}: ` +
        `${String(source.runs)} run(s), ${String(source.completed)} completed, ` +
        `${String(source.evolveCalls)} evolve call(s), ` +
        `${String(source.contractViolations)} contract violation(s), ` +
        `${String(source.outputFailures)} output failure(s), ` +
        `${String(source.transportFailures)} transport failure(s), ` +
        `${String(source.inserted)} inserted, ${String(source.failed)} failed.`,
    );
  }
  for (const defect of report.defects) {
    console.log(
      `- ${defect.category} x${String(defect.occurrences)}: ${defect.issue}`,
    );
  }
};

const runCompare = async (args: string[]): Promise<void> => {
  const { values } = parse(args);
  const comparison = await compareMatchedRuns({
    root: required(values.root, "--root"),
    beforeRunId: required(values.before, "--before"),
    afterRunId: required(values.after, "--after"),
  });
  const line = (side: MatchedComparison["before"]): string => {
    const review =
      side.semanticReview === null
        ? "unreviewed"
        : `${String(side.semanticReview.assessed)}/${String(side.semanticReview.denominator)} ` +
          `assessed: useful ${String(side.semanticReview.useful)}, ` +
          `unrelated ${String(side.semanticReview.unrelated)}, ` +
          `unresolved ${String(side.semanticReview.unresolved)}`;
    return (
      `- ${side.runId} (${String(side.promptTextSource)}): ` +
      `${String(side.counts.insertions)} insertions, ` +
      `${String(side.counts.directedLinks)} links, ` +
      `direct first ${String(side.linked.firstResultRequired.recovered)}/` +
      `${String(side.linked.firstResultRequired.denominator)}, top-K ` +
      `${String(side.linked.allRequiredDirectTopK.recovered)}/` +
      `${String(side.linked.allRequiredDirectTopK.denominator)}; ` +
      `linked additions ${String(side.additions.length)} ` +
      `(${String(side.linked.returnedCharacters.linked)} chars); ${review}`
    );
  };
  console.log(
    `Matched comparison of "${values.before}" and "${values.after}":`,
  );
  console.log(line(comparison.before));
  console.log(line(comparison.after));
  console.log(
    `Deltas (after - before): additions ${String(comparison.deltas.linkedAdditions)}, ` +
      `characters ${String(comparison.deltas.linkedCharacters)}, ` +
      `reviewed unrelated ${String(comparison.deltas.reviewedUnrelated)}, ` +
      `direct first-result ${String(comparison.deltas.directFirstResultRecovered)}.`,
  );
  console.log(
    `Evidence: ${baselinePath(required(values.root, "--root"), "matchedComparison")}`,
  );
};

const runRetrieval = async (args: string[]): Promise<void> => {
  const { values } = parse(args);
  const root = required(values.root, "--root");
  const baseline = await runDeclaredRetrieval({
    root,
    qdrant: qdrantFrom(values),
    embeddingCacheDir: required(values["embedding-cache"], "--embedding-cache"),
    allowEmbeddingDownloads: values["allow-embedding-downloads"] === true,
    directLimit: positiveInteger(values["direct-limit"], "--direct-limit", 3),
    linkedLimit: positiveInteger(values["linked-limit"], "--linked-limit", 3),
  });
  console.log(
    `Direct recovery (first result): ` +
      `${String(baseline.summaries.direct.firstResultRequired.recovered)}/` +
      `${String(baseline.summaries.direct.firstResultRequired.denominator)}; ` +
      `all required in direct top K: ` +
      `${String(baseline.summaries.direct.allRequiredDirectTopK.recovered)}/` +
      `${String(baseline.summaries.direct.allRequiredDirectTopK.denominator)}.`,
  );
  console.log(
    `Linked additions: ${String(baseline.linkedAdditions.count)} ` +
      `(${String(baseline.linkedAdditions.characters)} chars) across ` +
      `${String(baseline.linkedAdditions.queriesWithAdditions)}/${String(baseline.queries.declared)} queries; ` +
      `beyond expected: ${String(baseline.linkedAdditions.additionsBeyondExpected.count)}.`,
  );
  console.log(`Evidence: ${baselinePath(root, "retrieval")}`);
};

const runMetrics = async (args: string[]): Promise<void> => {
  const { values } = parse(args);
  const metrics = await aggregateMetrics(required(values.root, "--root"));
  const {
    acceptedObservations,
    storedOutcomes,
    failedOutcomes,
    attempts,
    recovery,
  } = metrics.ingestion;
  console.log(
    `Ingestion: accepted ${String(acceptedObservations.count)}, stored ` +
      `${String(storedOutcomes.count)}, failed ${String(failedOutcomes.count)}; ` +
      `recovery evidence available: ${String(recovery.available)}.`,
  );
  console.log(
    `Cumulative attempts: ${String(attempts.total.count)} ` +
      `(${attempts.total.denominator}); ${String(attempts.failedOutcomeClaims.count)} on ` +
      "receipts currently failed; per-attempt failure history unavailable.",
  );
  if (metrics.retrieval !== null) {
    console.log(
      `Retrieval: direct top-K recovery ` +
        `${String(metrics.retrieval.directRecovery.allRequiredDirectTopK.recovered)}/` +
        `${String(metrics.retrieval.directRecovery.allRequiredDirectTopK.denominator)}; ` +
        `linked additions ${String(metrics.retrieval.linkedAdditions.count)}.`,
    );
    const review = metrics.retrieval.linkedAdditions.semanticReview;
    console.log(
      review === null
        ? "Linked additions semantic review: not retained yet."
        : `Linked additions semantic review: ${String(review.assessed)}/${String(review.denominator)} ` +
            `assessed; useful ${String(review.useful)}, unrelated ${String(review.unrelated)}, ` +
            `unresolved ${String(review.unresolved)}, unassessed ${String(review.unassessed)}.`,
    );
  }
  if (metrics.reproduction !== null) {
    console.log(
      `Reproduction: ${String(metrics.reproduction.runs)} run(s), ` +
        `${String(metrics.reproduction.calls.total)} calls, ` +
        `${String(metrics.reproduction.defects.length)} defect class(es).`,
    );
  }
  console.log(`Metrics written for revision ${metrics.revision}.`);
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "capture":
      return await runCapture(args);
    case "restore":
      return await runRestore(args);
    case "receipts":
      return await runReceipts(args);
    case "reproduce":
      return await runReproduce(args);
    case "defects":
      return await runDefects(args);
    case "compare":
      return await runCompare(args);
    case "retrieval":
      return await runRetrieval(args);
    case "metrics":
      return await runMetrics(args);
    default:
      console.log(usage);
      if (command !== undefined) {
        throw new CliError(`Unknown command "${command}".`);
      }
  }
};

await main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
