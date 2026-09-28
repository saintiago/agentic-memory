/**
 * The required responsive scale check of the Sigma dashboard: import and refresh a representative
 * 10,000-memory graph with about 50,000 directed links in a real browser, exercise zoom, pan,
 * selection and a search while a refresh is provably pending, and record load time, update
 * latency, long tasks, frame gaps and the preservation of the displayed view and the selection.
 * The real inspection session, HTTP server and browser UI are exercised; the collection and the
 * projection worker are substituted (see corpus.ts), because this check is about the browser, not
 * Qdrant or UMAP.
 *
 * The next export is held open while the interactions run, so the update window is explicit
 * instead of racing the poll loop, and the preservation baseline is taken while the held export
 * proves the update has not been applied yet.
 *
 * A run without a browser or a built dashboard bundle fails with instructions instead of
 * reporting a pass.
 *
 * See docs/dashboard.md#asynchronous-data-updates and docs/dashboard.md#acceptance-checks.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { InspectionSession } from "../../inspector/session.js";
import {
  startInspectionServer,
  type InspectionServer,
} from "../../inspector/server.js";
import { SyntheticMemory, syntheticId } from "./corpus.js";
import {
  camera,
  diagnostics,
  display,
  launchChromium,
  maxViewportDrift,
  pollNow,
  settleFrames,
  viewportPositions,
  waitForStableCamera,
  webglRendererDescription,
  type PageCamera,
} from "./probes.js";
import {
  frameGaps,
  percentile,
  readHardware,
  summarize,
  writeReport,
  type ResponsivenessReport,
} from "./report.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Install the frame and long-task recorders before the bundle runs. */
const installProbes = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    interface TaskEntry {
      readonly startTime: number;
      readonly duration: number;
    }
    const scope = globalThis as unknown as {
      __frames: number[];
      __longTasks: TaskEntry[];
      requestAnimationFrame(callback: (time: number) => void): number;
      PerformanceObserver:
        | (new (callback: (list: { getEntries(): TaskEntry[] }) => void) => {
            observe(options: { entryTypes: string[] }): void;
          })
        | undefined;
    };
    scope.__frames = [];
    scope.__longTasks = [];
    const tick = (): void => {
      scope.__frames.push(Date.now());
      scope.requestAnimationFrame(tick);
    };
    scope.requestAnimationFrame(tick);
    const Observer = scope.PerformanceObserver;
    if (Observer !== undefined) {
      try {
        new Observer((list) => {
          for (const entry of list.getEntries()) {
            scope.__longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
          }
        }).observe({ entryTypes: ["longtask"] });
      } catch {
        // Long-task observation is optional; the frame gaps stay recorded either way.
      }
    }
  });
};

const frameTimes = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const scope = globalThis as unknown as { __frames: number[] };
    return [...scope.__frames];
  });

const performanceTimeOrigin = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const scope = globalThis as unknown as {
      performance: { timeOrigin: number };
    };
    return scope.performance.timeOrigin;
  });

const longTasks = async (
  page: Page,
): Promise<
  Array<{ readonly startTime: number; readonly duration: number }>
> => {
  const timeOrigin = await performanceTimeOrigin(page);
  return page.evaluate((origin: number) => {
    const scope = globalThis as unknown as {
      __longTasks: Array<{ startTime: number; duration: number }>;
    };
    return scope.__longTasks.map((entry) => ({
      startTime: origin + entry.startTime,
      duration: entry.duration,
    }));
  }, timeOrigin);
};

/** Wait until the camera reflects an interaction and return how long that took. */
const timeCameraChange = async (
  page: Page,
  previous: PageCamera,
  interact: () => Promise<void>,
): Promise<number> => {
  const started = Date.now();
  await interact();
  await page.waitForFunction(
    (before: PageCamera) => {
      const scope = globalThis as unknown as {
        __amemInspector: {
          cameraState(): {
            readonly x: number;
            readonly y: number;
            readonly ratio: number;
          };
        };
      };
      const state = scope.__amemInspector.cameraState();
      return (
        state.x !== before.x ||
        state.y !== before.y ||
        state.ratio !== before.ratio
      );
    },
    previous,
    { timeout: 10_000 },
  );
  return Date.now() - started;
};

describe("inspection dashboard at scale", () => {
  it("keeps 10,000 memories interactive through import, refresh, interaction and failure", async () => {
    const uiDirectory = path.join(repositoryRoot, "inspector/ui");
    const bundle = path.join(uiDirectory, "build/app.js");
    if (!existsSync(bundle)) {
      throw new Error(
        "The dashboard browser bundle is missing. `npm run inspector:responsive` builds it " +
          "first; run `npm run inspector:build` before starting this check directly.",
      );
    }

    const memory = new SyntheticMemory({
      nodes: 10_000,
      linksPerNode: 5,
      growthNodes: 500,
      growthLinksPerNode: 5,
      exportDelayMs: 20,
      projectionDelayMs: 100,
    });
    const initial = memory.counts();
    const session = new InspectionSession({
      collection: memory.collection,
      embeddingSpaceId: memory.embeddingSpaceId,
      store: memory.store,
      runner: memory.runner,
      artifacts: memory.artifacts,
      pollIntervalMs: 0,
      pageLimit: 500,
    });
    const server: InspectionServer = await startInspectionServer({
      reads: memory.reads,
      session,
      uiDirectory,
      port: 0,
    });
    session.start();

    let browser: Browser | undefined;
    try {
      browser = await launchChromium();
      const page = await browser.newPage({
        viewport: { width: 1180, height: 820 },
      });
      const webglRenderer = await webglRendererDescription(page);
      const pageProblems: string[] = [];
      page.on("pageerror", (error) => pageProblems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          pageProblems.push(message.text());
        }
      });
      await installProbes(page);

      const baseUrl = `http://127.0.0.1:${String(server.port)}`;
      const navigationStart = Date.now();
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (expected: { readonly nodes: number; readonly links: number }) => {
          const scope = globalThis as unknown as {
            __amemInspector?: {
              diagnostics(): {
                readonly status: string;
                readonly nodes: number;
                readonly links: number;
              };
            };
          };
          // The first completed view arrives in bounded batches; the import is done when every
          // served memory is displayed, not when the first status line appears.
          const state = scope.__amemInspector?.diagnostics();
          return (
            state?.status === "ready" &&
            state.nodes === expected.nodes &&
            state.links === expected.links
          );
        },
        { nodes: initial.nodes, links: initial.links },
        { timeout: 240_000 },
      );
      const initialLoadMs = Date.now() - navigationStart;
      const firstView = await diagnostics(page);
      expect(pageProblems).toEqual([]);
      expect((await page.textContent("#notice")) ?? "").toBe("");
      expect(firstView.differUsesWorker).toBe(true);
      expect(firstView.nodes).toBe(initial.nodes);
      expect(firstView.links).toBe(initial.links);
      expect(firstView.lastApply).toBeDefined();

      // Acceptance check 1: the browser displays the served identities and positions.
      const sampleIndexes = [0, 1, 1234, 5000, 9999];
      const sampleIds = sampleIndexes.map((index) => syntheticId(index));
      for (const drawn of await display(page, sampleIds)) {
        const index = sampleIndexes[sampleIds.indexOf(drawn.id)] ?? 0;
        const expected = memory.position(index);
        expect(drawn.x).toBeCloseTo(expected.x, 6);
        expect(drawn.y).toBeCloseTo(expected.y, 6);
      }
      const stage = await page.locator("#graph-stage").boundingBox();
      expect(stage).not.toBeNull();
      const positions = await viewportPositions(page, sampleIds);
      for (const position of positions) {
        expect(position).toBeDefined();
        expect(position?.x ?? -1).toBeGreaterThan(-0.05 * (stage?.width ?? 0));
        expect(position?.x ?? -1).toBeLessThan(1.05 * (stage?.width ?? 0));
        expect(position?.y ?? -1).toBeGreaterThan(-0.05 * (stage?.height ?? 0));
        expect(position?.y ?? -1).toBeLessThan(1.05 * (stage?.height ?? 0));
      }
      const centre = {
        x: (stage?.x ?? 0) + (stage?.width ?? 0) / 2,
        y: (stage?.y ?? 0) + (stage?.height ?? 0) / 2,
      };

      // The update grows the corpus; the next export is held open so the interactive window is
      // explicit. Every interaction below happens while the completed view is provably pending.
      memory.grow();
      const after = memory.counts();
      memory.holdNextExport();
      const refreshStarted = Date.now();
      const post = await page.request.post(`${baseUrl}/api/refresh`);
      expect(post.status()).toBe(202);
      await pollNow(page);
      await page.waitForFunction(
        () => {
          const scope = globalThis as unknown as {
            __amemInspector: {
              diagnostics(): { readonly refreshing: boolean };
            };
          };
          return scope.__amemInspector.diagnostics().refreshing;
        },
        undefined,
        { timeout: 60_000 },
      );
      const pending = await diagnostics(page);
      expect(pending.nodes).toBe(initial.nodes);
      expect(pending.links).toBe(initial.links);

      // A search during the update runs through the real form and results list.
      const searchStarted = Date.now();
      await page.fill("#query", "synthetic scale query");
      await page.press("#query", "Enter");
      await page.waitForFunction(
        () => {
          const scope = globalThis as unknown as {
            __amemInspector: {
              diagnostics(): { readonly resultOrder: readonly string[] };
            };
          };
          return scope.__amemInspector.diagnostics().resultOrder.length > 0;
        },
        undefined,
        { timeout: 20_000 },
      );
      const observedSearchMs = Date.now() - searchStarted;
      const returned = await diagnostics(page);
      const searchToResultsMs = returned.lastSearchMs ?? observedSearchMs;
      expect(returned.resultOrder).toEqual([
        syntheticId(10),
        syntheticId(20),
        syntheticId(30),
        memory.unmappedId,
      ]);
      expect(returned.unmappedIds).toEqual([memory.unmappedId]);
      // The results arrived while the completed view was still pending.
      expect((await diagnostics(page)).nodes).toBe(initial.nodes);

      const clickStarted = Date.now();
      await page.click("#results-list .result button");
      await page.waitForFunction(
        () => {
          const scope = globalThis as unknown as {
            __amemInspector: {
              diagnostics(): { readonly selectedId: string | undefined };
            };
          };
          return scope.__amemInspector.diagnostics().selectedId !== undefined;
        },
        undefined,
        { timeout: 20_000 },
      );
      const observedClickMs = Date.now() - clickStarted;
      const afterClick = await diagnostics(page);
      const clickToSelectionMs = afterClick.lastSelectionMs ?? observedClickMs;
      const selectedDuringUpdate = afterClick.selectedId;
      expect(selectedDuringUpdate).toBe(syntheticId(10));
      expect(afterClick.nodes).toBe(initial.nodes);

      const zoomLatencies: number[] = [];
      const panLatencies: number[] = [];
      for (let round = 0; round < 2; round += 1) {
        const zoomIn = round % 2 === 0;
        zoomLatencies.push(
          await timeCameraChange(page, await camera(page), async () => {
            await page.mouse.move(centre.x, centre.y);
            await page.mouse.wheel(0, zoomIn ? -240 : 240);
          }),
        );
        panLatencies.push(
          await timeCameraChange(page, await camera(page), async () => {
            const offset = round % 2 === 0 ? 36 : -36;
            await page.mouse.move(centre.x, centre.y);
            await page.mouse.down();
            await page.mouse.move(centre.x + offset, centre.y + offset / 2, {
              steps: 3,
            });
            await page.mouse.up();
          }),
        );
      }
      await waitForStableCamera(page);
      const pendingAfterInteractions = await diagnostics(page);
      const updatePendingDuringInteractions =
        pendingAfterInteractions.nodes === initial.nodes &&
        pendingAfterInteractions.links === initial.links;
      expect(updatePendingDuringInteractions).toBe(true);

      // The genuine pre-application baseline: the held export proves no completed view has been
      // applied yet, so these samples describe the interactive state the update must preserve.
      const cameraBeforeApply = await camera(page);
      const positionsBefore = await viewportPositions(page, sampleIds);
      expect(positionsBefore.every((position) => position !== undefined)).toBe(
        true,
      );

      memory.releaseExport();
      await page.waitForFunction(
        (expected: { readonly nodes: number; readonly links: number }) => {
          const scope = globalThis as unknown as {
            __amemInspector: {
              diagnostics(): {
                readonly nodes: number;
                readonly links: number;
              };
            };
          };
          const state = scope.__amemInspector.diagnostics();
          return (
            state.nodes === expected.nodes && state.links === expected.links
          );
        },
        { nodes: after.nodes, links: after.links },
        { timeout: 180_000 },
      );
      const appliedAt = Date.now();
      const updateRequestToAppliedMs = appliedAt - refreshStarted;
      await settleFrames(page);
      const updateDiagnostics = await diagnostics(page);
      const updateCamera = await camera(page);
      const positionsAfter = await viewportPositions(page, sampleIds);
      const maxViewportDriftPx = maxViewportDrift(
        positionsBefore,
        positionsAfter,
      );

      expect(updateDiagnostics.nodes).toBe(after.nodes);
      expect(updateDiagnostics.links).toBe(after.links);
      expect(updateDiagnostics.selectedId).toBe(selectedDuringUpdate);
      // The displayed view is preserved; the camera state itself may be re-expressed for the new
      // normalization box, so unchanged memories keeping their viewport positions is the evidence.
      expect(maxViewportDriftPx).toBeLessThan(1);
      const changed = await display(page, [syntheticId(0)]);
      expect(changed[0]?.label).toContain("remains the same subject");
      expect(pageProblems).toEqual([]);

      // A failed refresh keeps the last completed view instead of emptying the map.
      await session.settled();
      const beforeFailure = await diagnostics(page);
      memory.failExport = "The synthetic export failed.";
      const failed = await page.request.post(`${baseUrl}/api/refresh`);
      expect(failed.status()).toBe(202);
      await page.waitForFunction(
        () => {
          const scope = globalThis as unknown as {
            __amemInspector: {
              diagnostics(): { readonly error: string | undefined };
            };
          };
          return scope.__amemInspector.diagnostics().error !== undefined;
        },
        undefined,
        { timeout: 60_000 },
      );
      const afterFailure = await diagnostics(page);
      const statusText = (await page.textContent("#view-status")) ?? "";
      expect(afterFailure.nodes).toBe(beforeFailure.nodes);
      expect(afterFailure.links).toBe(beforeFailure.links);
      expect(statusText).toContain("failed");
      expect(statusText).toContain("still displayed");

      // Record the main-thread evidence of the update window.
      const windowStart = refreshStarted;
      const windowEnd = appliedAt;
      const gaps = frameGaps(await frameTimes(page), windowStart, windowEnd);
      const tasks = (await longTasks(page)).filter(
        (entry) =>
          entry.startTime >= windowStart && entry.startTime <= windowEnd,
      );
      const report: ResponsivenessReport = {
        corpus: {
          nodes: initial.nodes,
          links: initial.links,
          addedNodes: after.nodes - initial.nodes,
          addedLinks: after.links - initial.links,
        },
        hardware: readHardware(),
        browser: {
          name: "chromium",
          version: browser.version(),
          webglRenderer,
        },
        measurements: {
          initialLoadMs,
          initialApplyMs: firstView.lastApply?.durationMs,
          initialApplyBatches: firstView.lastApply?.batches,
          updateRequestToAppliedMs,
          updateApplyMs: updateDiagnostics.lastApply?.durationMs,
          updateApplyBatches: updateDiagnostics.lastApply?.batches,
          updatePendingDuringInteractions,
          searchToResultsMs,
          clickToSelectionMs,
          observedSearchMs,
          observedClickMs,
          zoomToCameraChangeMs: Math.max(...zoomLatencies, 0),
          panToCameraChangeMs: Math.max(...panLatencies, 0),
          longTasks: {
            count: tasks.length,
            maxMs: Math.max(...tasks.map((entry) => entry.duration), 0),
            totalMs: tasks.reduce((total, entry) => total + entry.duration, 0),
          },
          frameGapsMs: {
            samples: gaps.length,
            maxMs: Math.max(...gaps, 0),
            p95Ms: percentile(gaps, 0.95),
          },
          maxViewportDriftPx,
          cameraStateChangedByNormalization: !(
            updateCamera.x === cameraBeforeApply.x &&
            updateCamera.y === cameraBeforeApply.y &&
            updateCamera.ratio === cameraBeforeApply.ratio
          ),
          selectionPreservedAcrossUpdate:
            updateDiagnostics.selectedId === selectedDuringUpdate,
          failedRefreshKeptTheView:
            afterFailure.nodes === beforeFailure.nodes &&
            afterFailure.links === beforeFailure.links,
        },
      };
      const reportFile = await writeReport(
        report,
        process.env.AMEM_INSPECTOR_RESPONSIVE_OUT,
        repositoryRoot,
      );
      console.log(`${summarize(report)}\nReport: ${reportFile}`);

      // Responsiveness bounds: the required check is the record above, and these bounds only
      // fail a run whose main thread was blocked rather than merely busy.
      expect(report.measurements.longTasks.maxMs).toBeLessThan(3_000);
      expect(report.measurements.frameGapsMs.maxMs).toBeLessThan(3_000);
      // Handler latencies: the page answered the request and the selection without waiting.
      // The recorded values are the evidence; a page whose main thread is frozen exceeds these.
      expect(report.measurements.searchToResultsMs).toBeLessThan(10_000);
      expect(report.measurements.clickToSelectionMs).toBeLessThan(10_000);
      // Driver-observed round trips include every redraw already queued on the main thread; a
      // frozen page exceeds these widely. The recorded values, not these bounds, are the
      // evidence this check produces.
      expect(report.measurements.observedSearchMs).toBeLessThan(15_000);
      expect(report.measurements.observedClickMs).toBeLessThan(15_000);
      expect(report.measurements.zoomToCameraChangeMs).toBeLessThan(15_000);
      expect(report.measurements.panToCameraChangeMs).toBeLessThan(15_000);
    } finally {
      // A held export must not outlive the check, even when an assertion failed while it was open.
      memory.releaseExport();
      await browser?.close();
      await session.stop();
      await server.close();
    }
  }, 480_000);
});
