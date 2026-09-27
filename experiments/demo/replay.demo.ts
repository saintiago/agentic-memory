/**
 * Deterministic demonstration of the replay and comparison tools: the committed synthetic fixtures
 * are replayed through the public library with an in-memory store, the deterministic stand-ins and
 * no external service or paid call. Artifacts and the measurement report are written to a fresh run
 * directory under `AMEM_DEMO_RUNS_DIR` (default `.data/evaluations`).
 *
 * Run with `npm run demo:evaluation`.
 *
 * See docs/evaluation.md.
 */
import { describe, expect, it } from "vitest";

import { reportSummaryLines } from "../replay/report-summary.js";
import {
  defaultDemoRunsDirectory,
  demoRunId,
  runDeterministicDemo,
} from "./demo-run.js";

describe("deterministic replay demonstration", () => {
  it("replays the synthetic fixtures and reports the comparison measures", async () => {
    const result = await runDeterministicDemo({
      runsDirectory:
        process.env["AMEM_DEMO_RUNS_DIR"] ?? defaultDemoRunsDirectory,
      runId: process.env["AMEM_DEMO_RUN_ID"] ?? demoRunId(),
      revision: process.env["AMEM_REVISION"] ?? "working-tree",
    });

    for (const line of reportSummaryLines(result.report)) {
      console.log(line);
    }
    console.log(`Artifacts: ${result.directory}`);

    expect(result.status).toBe("completed");
    expect(result.report.checks.every((check) => check.ok)).toBe(true);
    expect(result.report.retrieval["original-content"]?.queries).toBe(8);
  }, 60_000);
});
