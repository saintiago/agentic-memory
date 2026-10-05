/**
 * Classify the recorded calls of the representative reproduction runs: validate every parsed
 * response against the very response contracts Memory enforces, using the candidate identities the
 * recorder captured for evolution calls, and report the concrete defects (missing or wrong fields,
 * unknown candidate IDs, duplicate updates, unusable output, provider failures) with the run
 * evidence behind each.
 *
 * See docs/evaluation.md#quality-maintenance-procedure and docs/prompts.md#validation.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  ModelResponseError,
  evolutionResponseSchema,
  readConstructionResponse,
  readEvolutionResponse,
  type ModelRequest,
} from "../../src/index.js";
import type {
  ChangeRecord,
  ModelCallRecord,
  RunManifest,
  SourceRecord,
} from "../replay/artifacts.js";
import { readJsonl, sha256Text, writeJsonFile } from "./io.js";
import { baselinePath } from "./layout.js";

/** One model call's validation outcome. */
export interface CallFinding {
  callId: number;
  stage: ModelRequest["stage"];
  sourceId: string | null;
  noteId: string | null;
  outcome:
    | "valid"
    | "contract-violation"
    | "output-failure"
    | "transport-failure"
    | "unchecked";
  categories: string[];
  issues: string[];
  rawResponseRecorded: boolean;
  candidateIdsRecorded: boolean;
}

/** One concrete defect class aggregated across the reproduction runs. */
export interface DefectAggregate {
  category: string;
  issue: string;
  occurrences: number;
  callIds: number[];
  sourceIds: string[];
}

/** One insertion failure recorded by the replay runner. */
export interface RecordedFailure {
  sourceId: string;
  operation: string;
  stage: string;
  reason: string;
  affectedNoteIds: string[];
}

/** One classified reproduction run. */
export interface ClassifiedRun {
  runId: string;
  directory: string;
  status: RunManifest["status"];
  revision: string;
  fixtureMatches: boolean;
  calls: {
    total: number;
    construct: number;
    evolve: number;
    outputFailures: number;
    transportFailures: number;
    withRawResponse: number;
    withCandidateIds: number;
  };
  outcomes: {
    inserted: number;
    failed: number;
    stopped: number;
    unattempted: number;
    excluded: number;
  };
  findings: CallFinding[];
  failures: RecordedFailure[];
}

/** The defect report over every reproduction run retained in the evidence root. */
export interface DefectReport {
  generatedAt: string;
  revision: string;
  runs: ClassifiedRun[];
  defects: DefectAggregate[];
  limits: string[];
}

const issueText = (error: ModelResponseError): string => {
  const marker = "documented contract: ";
  const at = error.message.indexOf(marker);
  const text =
    at === -1 ? error.message : error.message.slice(at + marker.length);
  return text.endsWith(".") ? text.slice(0, -1) : text;
};

const categorize = (reason: string): string[] => {
  const categories: string[] = [];
  if (reason.includes("is not a supplied candidate ID")) {
    categories.push("unknown-candidate");
  }
  if (reason.includes("repeats an updated candidate ID")) {
    categories.push("duplicate-update");
  }
  if (categories.length === 0) {
    categories.push("structure");
  }
  return categories;
};

export const classifyModelCall = (call: ModelCallRecord): CallFinding => {
  const base = {
    callId: call.callId,
    stage: call.stage,
    sourceId: call.sourceId,
    noteId: call.noteId,
    rawResponseRecorded: call.rawResponse !== null,
    candidateIdsRecorded: (call.candidateIds ?? null) !== null,
  };
  if (call.error !== null) {
    const category = call.error.category ?? null;
    if (category === "output") {
      return {
        ...base,
        outcome: "output-failure",
        categories: ["output"],
        issues: [call.error.message],
      };
    }
    return {
      ...base,
      outcome: "transport-failure",
      categories: [category ?? "transport"],
      issues: [call.error.message],
    };
  }
  try {
    if (call.stage === "construct") {
      readConstructionResponse(call.response);
    } else {
      const candidates = call.candidateIds ?? null;
      if (candidates === null) {
        const parsed = evolutionResponseSchema.safeParse(call.response);
        if (!parsed.success) {
          const reason = parsed.error.issues
            .map((issue) =>
              issue.path.length === 0
                ? issue.message
                : `${issue.path.map(String).join(".")}: ${issue.message}`,
            )
            .join("; ");
          return {
            ...base,
            outcome: "contract-violation",
            categories: categorize(reason),
            issues: [reason],
          };
        }
        return { ...base, outcome: "valid", categories: [], issues: [] };
      }
      readEvolutionResponse(call.response, candidates);
    }
    return { ...base, outcome: "valid", categories: [], issues: [] };
  } catch (cause) {
    if (cause instanceof ModelResponseError) {
      const reason = issueText(cause);
      return {
        ...base,
        outcome: "contract-violation",
        categories: categorize(reason),
        issues: [reason],
      };
    }
    return {
      ...base,
      outcome: "unchecked",
      categories: [],
      issues: [cause instanceof Error ? cause.message : String(cause)],
    };
  }
};

const classifyRun = async (input: {
  directory: string;
  fixtureSourceHash: string;
}): Promise<ClassifiedRun> => {
  const manifest = JSON.parse(
    await readFile(path.join(input.directory, "manifest.json"), "utf8"),
  ) as RunManifest;
  const calls = await readJsonl<ModelCallRecord>(
    path.join(input.directory, "calls.jsonl"),
  );
  const changes = await readJsonl<ChangeRecord>(
    path.join(input.directory, "changes.jsonl"),
  );
  const sources = await readJsonl<SourceRecord>(
    path.join(input.directory, "sources.jsonl"),
  );
  const findings = calls.map(classifyModelCall);
  const outcomes = {
    inserted: 0,
    failed: 0,
    stopped: 0,
    unattempted: 0,
    excluded: 0,
  };
  for (const source of sources) {
    outcomes[source.outcome] += 1;
  }
  const failures = changes
    .filter(
      (change): change is Extract<ChangeRecord, { kind: "failure" }> =>
        change.kind === "failure",
    )
    .map((change) => ({
      sourceId: change.sourceId,
      operation: change.operation,
      stage: change.stage,
      reason: change.reason,
      affectedNoteIds: [...change.affectedNoteIds],
    }));
  return {
    runId: manifest.runId,
    directory: input.directory,
    status: manifest.status,
    revision: manifest.revision,
    fixtureMatches: manifest.fixture.sourceHash === input.fixtureSourceHash,
    calls: {
      total: calls.length,
      construct: calls.filter((call) => call.stage === "construct").length,
      evolve: calls.filter((call) => call.stage === "evolve").length,
      outputFailures: findings.filter(
        (finding) => finding.outcome === "output-failure",
      ).length,
      transportFailures: findings.filter(
        (finding) => finding.outcome === "transport-failure",
      ).length,
      withRawResponse: calls.filter((call) => call.rawResponse !== null).length,
      withCandidateIds: calls.filter(
        (call) => (call.candidateIds ?? null) !== null,
      ).length,
    },
    outcomes,
    findings,
    failures,
  };
};

/** Classify every reproduction run under the evidence root's `runs/` directory. */
export const classifyReproductionRuns = async (
  root: string,
  options: { now?: () => Date } = {},
): Promise<DefectReport> => {
  const runsDirectory = baselinePath(root, "runs");
  const entries = await readdir(runsDirectory, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDirectory, entry.name))
    .sort();
  if (directories.length === 0) {
    throw new Error(
      `No reproduction runs are retained under ${runsDirectory}; run the recorded replay first.`,
    );
  }
  const fixtureText = await readFile(
    baselinePath(root, "reproductionSources"),
    "utf8",
  );
  const fixtureSourceHash = sha256Text(fixtureText);
  const runs: ClassifiedRun[] = [];
  for (const directory of directories) {
    runs.push(await classifyRun({ directory, fixtureSourceHash }));
  }
  const defects = new Map<string, DefectAggregate>();
  for (const run of runs) {
    for (const finding of run.findings) {
      if (
        finding.outcome === "contract-violation" ||
        finding.outcome === "output-failure" ||
        finding.outcome === "transport-failure"
      ) {
        for (const category of finding.categories) {
          const key = `${category}\u0000${finding.issues.join(" | ")}`;
          const aggregate = defects.get(key) ?? {
            category,
            issue: finding.issues.join(" | "),
            occurrences: 0,
            callIds: [],
            sourceIds: [],
          };
          aggregate.occurrences += 1;
          aggregate.callIds.push(finding.callId);
          if (finding.sourceId !== null) {
            aggregate.sourceIds.push(finding.sourceId);
          }
          defects.set(key, aggregate);
        }
      }
    }
  }
  const report: DefectReport = {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    revision: runs[0]?.revision ?? "unknown",
    runs,
    defects: [...defects.values()],
    limits: [
      "Contract checks re-validate every recorded parsed response, null included, with the same " +
        "public schemas Memory uses; a recorded response is not re-interpreted as a different " +
        "defect class.",
      "A recorded failure the transport categorized as output is an unusable-model-output " +
        "defect; other failure categories are provider or connectivity failures, not response " +
        "defects. Failures recorded before the category was retained stay uncategorized.",
      "Reference checks use the candidate identities captured at the store boundary of the " +
        "reproduction run, not the live corpus of the original failure.",
      "A reproduction that returns no violations is not proof that the original failure was " +
        "unreal; it is one stochastic isolated run on rebuilt candidate context.",
    ],
  };
  await writeJsonFile(baselinePath(root, "defects"), report);
  return report;
};
