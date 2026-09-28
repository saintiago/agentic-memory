/**
 * The responsiveness report of the scale check: corpus size, link count, hardware and the recorded
 * measurements, written as one JSON artifact and printed as a summary.
 *
 * See docs/dashboard.md#asynchronous-data-updates.
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ResponsivenessReport {
  readonly corpus: {
    readonly nodes: number;
    readonly links: number;
    readonly addedNodes: number;
    readonly addedLinks: number;
  };
  readonly hardware: {
    readonly cpu: string;
    readonly cores: number;
    readonly memoryGb: number;
    readonly platform: string;
  };
  readonly browser: {
    readonly name: string;
    readonly version: string;
    /** The WebGL renderer the run drew with, e.g. a software rasterizer in headless runs. */
    readonly webglRenderer: string;
  };
  readonly measurements: {
    readonly initialLoadMs: number;
    readonly initialApplyMs: number | undefined;
    readonly initialApplyBatches: number | undefined;
    /** Request to applied view, including the interaction window the check held open. */
    readonly updateRequestToAppliedMs: number;
    readonly updateApplyMs: number | undefined;
    readonly updateApplyBatches: number | undefined;
    /** Whether every interaction ran while the completed view was still pending. */
    readonly updatePendingDuringInteractions: boolean;
    /** Handler latency inside the page: request submission to the updated results panel. */
    readonly searchToResultsMs: number;
    /**
     * Handler latency inside the page: selection click to the updated details panel. The panel is
     * updated synchronously for a returned memory; the browser paints it in the next frame.
     */
    readonly clickToSelectionMs: number;
    /** Driver-observed round trips, which include any queued redraws of the page. */
    readonly observedSearchMs: number;
    readonly observedClickMs: number;
    readonly zoomToCameraChangeMs: number;
    readonly panToCameraChangeMs: number;
    readonly longTasks: {
      readonly count: number;
      readonly maxMs: number;
      readonly totalMs: number;
    };
    readonly frameGapsMs: {
      readonly samples: number;
      readonly maxMs: number;
      readonly p95Ms: number;
    };
    /** The largest distance one unchanged memory moved on screen across the update. */
    readonly maxViewportDriftPx: number;
    /** Whether the camera state stayed unchanged across the refresh. */
    readonly cameraStatePreserved: boolean;
    readonly selectionPreservedAcrossUpdate: boolean;
    readonly failedRefreshKeptTheView: boolean;
  };
}

export interface Hardware {
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGb: number;
  readonly platform: string;
}

export const readHardware = (): Hardware => ({
  cpu: os.cpus()[0]?.model ?? "unknown",
  cores: os.cpus().length,
  memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
});

/** The 95th percentile of the frame gaps between two timestamps. */
export const frameGaps = (
  frameTimes: readonly number[],
  from: number,
  to: number,
): readonly number[] => {
  const within = frameTimes.filter((time) => time >= from && time <= to);
  const gaps: number[] = [];
  for (let index = 1; index < within.length; index += 1) {
    const previous = within[index - 1];
    const current = within[index];
    if (previous !== undefined && current !== undefined) {
      gaps.push(current - previous);
    }
  }
  return gaps;
};

export const percentile = (
  values: readonly number[],
  fraction: number,
): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[position] ?? 0;
};

/** Print a short human summary of one report. */
export const summarize = (report: ResponsivenessReport): string => {
  const { corpus, hardware, browser, measurements } = report;
  const lines = [
    `Inspection scale check: ${String(corpus.nodes)} memories, ${String(corpus.links)} directed links ` +
      `(update added ${String(corpus.addedNodes)} memories and ${String(corpus.addedLinks)} links).`,
    `Hardware: ${hardware.cpu}, ${String(hardware.cores)} cores, ${String(hardware.memoryGb)} GiB, ${hardware.platform}.`,
    `Browser: ${browser.name} ${browser.version}, WebGL ${browser.webglRenderer}.`,
    `Initial load: ${String(measurements.initialLoadMs)} ms total, ` +
      `${String(measurements.initialApplyMs ?? -1)} ms to apply the first view in ` +
      `${String(measurements.initialApplyBatches ?? -1)} batches.`,
    `Refresh: ${String(measurements.updateRequestToAppliedMs)} ms from request to applied view ` +
      `(interactions held the update pending: ${String(measurements.updatePendingDuringInteractions)}), ` +
      `${String(measurements.updateApplyMs ?? -1)} ms to apply in ` +
      `${String(measurements.updateApplyBatches ?? -1)} batches.`,
    `Interaction during the update: search→results panel ${String(measurements.searchToResultsMs)} ms, ` +
      `click→panels ${String(measurements.clickToSelectionMs)} ms, ` +
      `wheel→camera ${String(measurements.zoomToCameraChangeMs)} ms, ` +
      `drag→camera ${String(measurements.panToCameraChangeMs)} ms ` +
      `(driver-observed search ${String(measurements.observedSearchMs)} ms, ` +
      `click ${String(measurements.observedClickMs)} ms).`,
    `Main thread: ${String(measurements.longTasks.count)} long tasks ` +
      `(max ${String(measurements.longTasks.maxMs)} ms, total ${String(measurements.longTasks.totalMs)} ms); ` +
      `frame gaps max ${String(measurements.frameGapsMs.maxMs)} ms, ` +
      `p95 ${String(measurements.frameGapsMs.p95Ms)} ms over ${String(measurements.frameGapsMs.samples)} samples.`,
    `Preserved across the update: displayed view (max drift ` +
      `${measurements.maxViewportDriftPx.toFixed(3)} px; camera state preserved ` +
      `${String(measurements.cameraStatePreserved)}), ` +
      `selection ${String(measurements.selectionPreservedAcrossUpdate)}; ` +
      `failed refresh kept the view ${String(measurements.failedRefreshKeptTheView)}.`,
  ];
  return lines.join("\n");
};

/** Write one report under the configured output file or the default artifact directory. */
export const writeReport = async (
  report: ResponsivenessReport,
  outputPath: string | undefined,
  repositoryRoot: string,
): Promise<string> => {
  const file =
    outputPath ??
    path.join(repositoryRoot, ".data/inspector-responsive/report.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return file;
};
