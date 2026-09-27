/**
 * A compact human-readable view of one measurement report: counts, retrieval measures of every
 * comparison mode, timing summaries with sample counts and the checks the run performed. The JSON
 * artifacts remain the authoritative record.
 *
 * See docs/evaluation.md#run-artifacts.
 */
import type { ModeSummary, RunReport, TimingSummary } from "./artifacts.js";

const timing = (summary: TimingSummary): string =>
  summary.medianMs === null
    ? "no samples"
    : `median ${summary.medianMs.toFixed(1)} ms, p95 ${summary.p95Ms?.toFixed(1) ?? "?"} ms ` +
      `(${String(summary.samples)} samples)`;

const retrievalLine = (mode: string, summary: ModeSummary): string => {
  const recovered = (entry: ModeSummary["firstResultRequired"]): string =>
    `${String(entry.recovered)}/${String(entry.denominator)}`;
  return (
    `  ${mode.padEnd(16)} first ${recovered(summary.firstResultRequired)}` +
    `  direct-top ${recovered(summary.allRequiredDirectTopK)}` +
    `  with-links ${recovered(summary.allRequiredWithLinks)}` +
    `  link-only sources ${String(summary.linkRecoveredSources)}` +
    `  chars ${String(summary.returnedCharacters.direct)}+${String(
      summary.returnedCharacters.linked,
    )}`
  );
};

/** Render the report the way the demonstration and live scripts print it. */
export const reportSummaryLines = (report: RunReport): string[] => {
  const lines = [
    `Run ${report.runId} (${report.status}) at revision ${report.revision}`,
    `Sources ${String(report.counts.sources)}, queries ${String(
      report.counts.queries,
    )}, insertions ${String(report.counts.insertions)}, failures ${String(
      report.counts.insertionFailures,
    )}, final notes ${String(report.counts.finalNotes)}, links ${String(
      report.counts.directedLinks,
    )}`,
    `Generation calls: ${String(report.counts.modelCalls.total)} ` +
      `(${String(report.counts.modelCalls.construct)} construct, ` +
      `${String(report.counts.modelCalls.evolve)} evolve), successful ` +
      `${String(report.generation.totalSuccessful)}` +
      (report.generation.upperBound === null
        ? " (bound not applicable to this interrupted run)"
        : ` against the documented bound ${String(report.generation.upperBound)}`),
    `Cost: ${
      report.cost.known
        ? String(report.cost.total)
        : report.cost.upperBound === null
          ? "unknown"
          : `unknown (upper bound ${String(report.cost.upperBound)})`
    }`,
    "Retrieval:",
  ];
  for (const [mode, summary] of Object.entries(report.retrieval)) {
    lines.push(retrievalLine(mode, summary));
  }
  lines.push(
    `Startup: encoder ${
      report.timings.startup.encoderLoadMs === null
        ? "unmeasured"
        : `${report.timings.startup.encoderLoadMs.toFixed(1)} ms`
    }; ` +
      `runtime collection ${report.timings.startup.runtimeCollectionMs.toFixed(1)} ms`,
    `Insertions: first ${report.timings.insertions.firstMs?.toFixed(1) ?? "?"} ms; ` +
      `warm ${timing(report.timings.insertions.warm)}`,
    `Stages: generation ${timing(report.timings.insertionStages.generation)}; ` +
      `embedding ${timing(report.timings.insertionStages.embedding)}; ` +
      `candidates ${timing(report.timings.insertionStages.candidateSearch)}; ` +
      `persistence ${timing(report.timings.insertionStages.persistence)}`,
  );
  for (const [mode, summary] of Object.entries(report.timings.search)) {
    lines.push(
      `Search ${mode}: first ${summary.firstMs?.toFixed(1) ?? "?"} ms; ` +
        `warm ${timing(summary.warm)}`,
    );
  }
  if (report.budget !== null) {
    lines.push(
      `Budget: ${String(report.budget.modelCalls)} calls, ` +
        `${report.budget.tokensUsed === null ? "unknown" : String(report.budget.tokensUsed)} tokens ` +
        `against a declared ${String(report.budget.callBudget)}-call / ` +
        `${String(report.budget.tokenBudget)}-token budget` +
        (report.budget.usageComplete ? "" : " (usage incomplete)"),
    );
  }
  for (const check of report.checks) {
    lines.push(
      `Check ${check.ok ? "ok" : "FAILED"} - ${check.name}: ${check.detail}`,
    );
  }
  if (report.stoppingReason !== null) {
    lines.push(`Stopped: ${report.stoppingReason}`);
  }
  for (const failure of report.failures) {
    lines.push(
      `Failure ${failure.sourceId} (${failure.operation}/${failure.stage}, ` +
        `${failure.persistence}): ${failure.reason}`,
    );
  }
  for (const limit of report.limits) {
    lines.push(`Limit: ${limit}`);
  }
  return lines;
};
