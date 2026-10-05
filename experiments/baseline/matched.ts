/**
 * The matched isolated before/after comparison: two completed reproduction runs over the same
 * fixture, insertion order, included membership, queries, retrieval limits and provider settings,
 * differing only in the prompt text source. The comparison reports each run's direct recovery and
 * linked additions and, when the operator's reviewed verdicts are retained with a run, the
 * useful/unrelated split with its assessed-sample denominator.
 *
 * See docs/evaluation.md#quality-change-acceptance and
 * docs/evaluation.md#retrieval-and-semantic-measures.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ModeSummary,
  RetrievalRecord,
  RunManifest,
  RunReport,
} from "../replay/artifacts.js";
import { readJsonl, sha256File, writeJsonFile } from "./io.js";
import { baselinePath } from "./layout.js";
import {
  linkedAdditionsFromRecords,
  LinkedReviewError,
  linkedReviewSchema,
  summarizeLinkedReviewAgainst,
  type LinkedAddition,
  type LinkedReviewSummary,
} from "./linked-review.js";

/** The review file the operator retains next to one reproduction run's retrieval evidence. */
export const runLinkedReviewFile = "linked-additions-review.json";

/** One linked addition the run returned, with the text the review judged. */
export interface MatchedAddition extends LinkedAddition {
  sourceId: string | null;
  characters: number;
  context: string;
}

/** One run's comparable evidence, read from its retained artifacts. */
export interface MatchedRunEvidence {
  runId: string;
  directory: string;
  status: RunManifest["status"];
  revision: string;
  promptTextSource: string | null;
  excludedSources: string[];
  includedSources: number;
  counts: {
    insertions: number;
    insertionFailures: number;
    finalNotes: number;
    directedLinks: number;
    failedModelCalls: number;
  };
  direct: ModeSummary;
  linked: ModeSummary;
  additions: MatchedAddition[];
  semanticReview: LinkedReviewSummary | null;
}

/** The matched comparison over both runs. */
export interface MatchedComparison {
  formatVersion: 1;
  generatedAt: string;
  revision: string;
  matched: {
    sourceHash: string;
    queryHash: string;
    insertionOrder: string[];
    includedSources: number;
    excludedSources: string[];
    limits: RunManifest["memory"];
    providerRequestMode: string | null;
    model: { endpoint: string | null; id: string };
    encoderSpaceId: string;
    representation: string;
    difference: "prompt text source only";
  };
  before: MatchedRunEvidence;
  after: MatchedRunEvidence;
  deltas: {
    linkedAdditions: number;
    linkedCharacters: number;
    reviewedUseful: number | null;
    reviewedUnrelated: number | null;
    reviewedUnresolved: number | null;
    directFirstResultRecovered: number;
    directTopKRecovered: number;
    linkedOnlyRecoveredSources: number;
  };
  limits: string[];
}

/** A pair of runs that cannot support an isolated prompt comparison. */
export class MatchedComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchedComparisonError";
  }
}

const promptTextSourceOf = (manifest: RunManifest): string | null => {
  const value = manifest.timing.conditions["promptTextSource"];
  return typeof value === "string" && value !== "" ? value : null;
};

const providerRequestModeOf = (manifest: RunManifest): string | null => {
  const value = manifest.timing.conditions["providerRequestMode"];
  return typeof value === "string" ? value : null;
};

/** Every linked addition one isolated run returned, with the returned note's text. */
export const matchedAdditions = (
  records: readonly RetrievalRecord[],
): MatchedAddition[] =>
  linkedAdditionsFromRecords(records).flatMap((addition) => {
    const record = records.find(
      (candidate) => candidate.queryId === addition.queryId,
    );
    const result = record?.results.find(
      (candidate) =>
        candidate.origin === "link" && candidate.noteId === addition.noteId,
    );
    if (result === undefined) {
      return [];
    }
    return [
      {
        ...addition,
        sourceId: result.sourceId,
        characters: result.characters.total,
        context: result.note.context,
      },
    ];
  });

const readRun = async (
  root: string,
  runId: string,
): Promise<{
  manifest: RunManifest;
  report: RunReport;
  records: RetrievalRecord[];
  directory: string;
}> => {
  const directory = path.join(baselinePath(root, "runs"), runId);
  const read = async <T>(name: string): Promise<T> =>
    JSON.parse(await readFile(path.join(directory, name), "utf8")) as T;
  const manifest = await read<RunManifest>("manifest.json");
  const report = await read<RunReport>("report.json");
  const records = await readJsonl<RetrievalRecord>(
    path.join(directory, "retrieval.jsonl"),
  );
  return { manifest, report, records, directory };
};

const readRunReview = async (input: {
  directory: string;
  records: readonly RetrievalRecord[];
}): Promise<LinkedReviewSummary | null> => {
  const file = path.join(input.directory, runLinkedReviewFile);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      (cause as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw cause;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new LinkedReviewError(
      `The linked-addition review ${file} is not valid JSON.`,
    );
  }
  const review = linkedReviewSchema.safeParse(value);
  if (!review.success) {
    throw new LinkedReviewError(
      `The linked-addition review ${file} is invalid: ${review.error.issues
        .map((issue) =>
          issue.path.length === 0
            ? issue.message
            : `${issue.path.map(String).join(".")}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  }
  const retrievalSha256 = await sha256File(
    path.join(input.directory, "retrieval.jsonl"),
  );
  if (review.data.retrievalSha256 !== retrievalSha256) {
    throw new LinkedReviewError(
      `The linked-addition review ${file} does not belong to this run's retrieval evidence.`,
    );
  }
  return summarizeLinkedReviewAgainst({
    additions: linkedAdditionsFromRecords(input.records),
    review: review.data,
  });
};

const modeSummary = (
  report: RunReport,
  mode: string,
  runId: string,
): ModeSummary => {
  const summary = report.retrieval[mode];
  if (summary === undefined) {
    throw new MatchedComparisonError(
      `Run "${runId}" has no "${mode}" retrieval summary; the comparison needs both direct and ` +
        "linked retrieval from each run.",
    );
  }
  return summary;
};

/** Read one run's comparable evidence; the run must have completed insertion and retrieval. */
export const readMatchedRun = async (
  root: string,
  runId: string,
): Promise<MatchedRunEvidence> => {
  const { manifest, report, records, directory } = await readRun(root, runId);
  if (manifest.status !== "completed") {
    throw new MatchedComparisonError(
      `Run "${runId}" is ${manifest.status}, not completed; a matched comparison needs the same ` +
        "source membership on both sides.",
    );
  }
  if (report.counts.insertionFailures > 0) {
    throw new MatchedComparisonError(
      `Run "${runId}" recorded ${String(report.counts.insertionFailures)} insertion failure(s); ` +
        "a matched comparison needs the same source membership on both sides.",
    );
  }
  const includedSources =
    manifest.fixture.sourceCount - (report.exclusions?.sources.length ?? 0);
  if (
    report.counts.insertions !== includedSources ||
    report.counts.finalNotes !== includedSources
  ) {
    throw new MatchedComparisonError(
      `Run "${runId}" did not persist every included source ` +
        `(${String(report.counts.insertions)} inserted, ${String(report.counts.finalNotes)} ` +
        `final for ${String(includedSources)} included).`,
    );
  }
  const direct = modeSummary(report, "evolved-direct", runId);
  const linked = modeSummary(report, "evolved-linked", runId);
  const linkedRecords = records.filter(
    (record) => record.mode === "evolved-linked",
  );
  return {
    runId,
    directory,
    status: manifest.status,
    revision: manifest.revision,
    promptTextSource: promptTextSourceOf(manifest),
    excludedSources: [...(report.exclusions?.sources ?? [])].sort(),
    includedSources,
    counts: {
      insertions: report.counts.insertions,
      insertionFailures: report.counts.insertionFailures,
      finalNotes: report.counts.finalNotes,
      directedLinks: report.counts.directedLinks,
      failedModelCalls: report.counts.failedModelCalls,
    },
    direct,
    linked,
    additions: matchedAdditions(linkedRecords),
    semanticReview: await readRunReview({
      directory,
      records: linkedRecords,
    }),
  };
};

const sameOrder = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * Compare two completed reproduction runs and write the matched comparison under the evidence
 * root. Every condition that could explain a difference other than the prompt text fails instead
 * of producing an unpaired comparison.
 */
export const compareMatchedRuns = async (input: {
  root: string;
  beforeRunId: string;
  afterRunId: string;
  /**
   * A short label for the pair; the comparison is written as `matched-comparison-<label>.json`.
   * Omitted, the canonical `matched-comparison.json` is written.
   */
  label?: string;
  now?: () => Date;
}): Promise<MatchedComparison> => {
  const before = await readMatchedRun(input.root, input.beforeRunId);
  const after = await readMatchedRun(input.root, input.afterRunId);
  const { manifest: beforeManifest } = await readRun(
    input.root,
    input.beforeRunId,
  );
  const { manifest: afterManifest } = await readRun(
    input.root,
    input.afterRunId,
  );
  const problem = (detail: string): never => {
    throw new MatchedComparisonError(
      `Runs "${input.beforeRunId}" and "${input.afterRunId}" are not matched: ${detail}`,
    );
  };
  if (
    before.promptTextSource === null ||
    after.promptTextSource === null ||
    before.promptTextSource === after.promptTextSource
  ) {
    problem(
      "the recorded prompt text sources do not identify two distinct sources " +
        `(${String(before.promptTextSource)} and ${String(after.promptTextSource)}).`,
    );
  }
  if (before.revision !== after.revision) {
    problem(
      `they were executed by different revisions (${before.revision} and ${after.revision}).`,
    );
  }
  if (
    beforeManifest.fixture.sourceHash !== afterManifest.fixture.sourceHash ||
    beforeManifest.fixture.queryHash !== afterManifest.fixture.queryHash ||
    beforeManifest.fixture.sourceCount !== afterManifest.fixture.sourceCount ||
    beforeManifest.fixture.queryCount !== afterManifest.fixture.queryCount
  ) {
    problem("they replay different fixtures.");
  }
  if (
    !sameOrder(before.excludedSources, after.excludedSources) ||
    before.includedSources !== after.includedSources
  ) {
    problem("they do not include the same source membership.");
  }
  if (
    !sameOrder(
      beforeManifest.fixture.insertionOrder,
      afterManifest.fixture.insertionOrder,
    )
  ) {
    problem("they insert the same sources in a different order.");
  }
  if (
    JSON.stringify(beforeManifest.memory) !==
    JSON.stringify(afterManifest.memory)
  ) {
    problem("they use different neighbor, direct or linked limits.");
  }
  if (
    providerRequestModeOf(beforeManifest) !==
    providerRequestModeOf(afterManifest)
  ) {
    problem("they used different provider request modes.");
  }
  if (
    beforeManifest.model.endpoint !== afterManifest.model.endpoint ||
    beforeManifest.model.id !== afterManifest.model.id
  ) {
    problem("they used different model transports.");
  }
  if (
    beforeManifest.encoder.spaceId !== afterManifest.encoder.spaceId ||
    beforeManifest.encoder.dimensions !== afterManifest.encoder.dimensions
  ) {
    problem("they used different encoder spaces.");
  }
  if (
    beforeManifest.storage.representation !==
    afterManifest.storage.representation
  ) {
    problem("they stored different representations.");
  }

  const reviewed = (
    beforeReport: LinkedReviewSummary | null,
    afterReport: LinkedReviewSummary | null,
    verdict: "useful" | "unrelated" | "unresolved",
  ): number | null =>
    beforeReport === null || afterReport === null
      ? null
      : afterReport[verdict] - beforeReport[verdict];
  const comparison: MatchedComparison = {
    formatVersion: 1,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    revision: before.revision,
    matched: {
      sourceHash: beforeManifest.fixture.sourceHash,
      queryHash: beforeManifest.fixture.queryHash,
      insertionOrder: [...beforeManifest.fixture.insertionOrder],
      includedSources: before.includedSources,
      excludedSources: [...before.excludedSources],
      limits: { ...beforeManifest.memory },
      providerRequestMode: providerRequestModeOf(beforeManifest),
      model: { ...beforeManifest.model },
      encoderSpaceId: beforeManifest.encoder.spaceId,
      representation: beforeManifest.storage.representation,
      difference: "prompt text source only",
    },
    before,
    after,
    deltas: {
      linkedAdditions: after.additions.length - before.additions.length,
      linkedCharacters:
        after.linked.returnedCharacters.linked -
        before.linked.returnedCharacters.linked,
      reviewedUseful: reviewed(
        before.semanticReview,
        after.semanticReview,
        "useful",
      ),
      reviewedUnrelated: reviewed(
        before.semanticReview,
        after.semanticReview,
        "unrelated",
      ),
      reviewedUnresolved: reviewed(
        before.semanticReview,
        after.semanticReview,
        "unresolved",
      ),
      directFirstResultRecovered:
        after.linked.firstResultRequired.recovered -
        before.linked.firstResultRequired.recovered,
      directTopKRecovered:
        after.linked.allRequiredDirectTopK.recovered -
        before.linked.allRequiredDirectTopK.recovered,
      linkedOnlyRecoveredSources:
        after.linked.linkRecoveredSources - before.linked.linkRecoveredSources,
    },
    limits: [
      "The comparison isolates the recorded instruction-text source; both runs execute the same " +
        "revision and therefore the same envelope, validation and retrieval policy.",
      "A linked addition is counted once per query and note; verdicts come from the operator's " +
        "retained review of that run's retrieval evidence.",
    ],
  };
  const comparisonFile = baselinePath(input.root, "matchedComparison");
  const artifact =
    input.label === undefined
      ? comparisonFile
      : comparisonFile.replace(/\.json$/, `-${input.label}.json`);
  await writeJsonFile(artifact, comparison);
  return comparison;
};
