/**
 * The required responsive scale check of the Sigma dashboard: import and refresh a representative
 * 10,000-memory graph with about 50,000 directed links in a real browser, exercise zoom, pan,
 * selection and a search while a refresh is applied, and record load time, update latency, long
 * tasks, frame gaps and the preservation of the camera and the selection. The real inspection
 * session, HTTP server and browser UI are exercised; the collection and the projection worker are
 * substituted (see corpus.ts), because this check is about the browser, not Qdrant or UMAP.
 *
 * A run without a browser or a built dashboard bundle fails with instructions instead of
 * reporting a pass.
 *
 * See docs/dashboard.md#asynchronous-data-updates and docs/dashboard.md#acceptance-checks.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { InspectionSession } from "../../inspector/session.js";
import {
  startInspectionServer,
  type InspectionServer,
} from "../../inspector/server.js";
import { SyntheticMemory, syntheticId } from "./corpus.js";
import {
  frameGaps,
  percentile,
  readHardware,
  summarize,
  writeReport,
  type ResponsivenessReport,
} from "./report.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The dashboard state the page exposes for this check. */
interface PageDiagnostics {
  readonly status: "loading" | "ready" | "error";
  readonly refreshing: boolean;
  readonly error: string | undefined;
  readonly differUsesWorker: boolean;
  readonly nodes: number;
  readonly links: number;
  readonly selectedId: string | undefined;
  readonly highlightedIds: readonly string[];
  readonly resultOrder: readonly string[];
  readonly unmappedIds: readonly string[];
  readonly lastApply:
    | {
        readonly durationMs: number;
        readonly batches: number;
        readonly addedNodes: number;
        readonly addedLinks: number;
      }
    | undefined;
  readonly lastSearchMs: number | undefined;
  readonly lastSelectionMs: number | undefined;
}

interface PageDisplay {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

interface PageCamera {
  readonly x: number;
  readonly y: number;
  readonly ratio: number;
}

interface PageProbe {
  diagnostics(): PageDiagnostics;
  display(nodeIds: readonly string[]): PageDisplay[];
  cameraState(): PageCamera;
  viewportPosition(
    nodeId: string,
  ): { readonly x: number; readonly y: number } | undefined;
  pollNow(): void;
}

const diagnostics = (page: Page): Promise<PageDiagnostics> =>
  page.evaluate(() => {
    const scope = globalThis as unknown as { __amemInspector: PageProbe };
    return scope.__amemInspector.diagnostics();
  });

const camera = (page: Page): Promise<PageCamera> =>
  page.evaluate(() => {
    const scope = globalThis as unknown as { __amemInspector: PageProbe };
    return scope.__amemInspector.cameraState();
  });

const display = (
  page: Page,
  nodeIds: readonly string[],
): Promise<PageDisplay[]> =>
  page.evaluate((ids: readonly string[]) => {
    const scope = globalThis as unknown as { __amemInspector: PageProbe };
    return scope.__amemInspector.display(ids);
  }, nodeIds);

const viewportPositions = (
  page: Page,
  nodeIds: readonly string[],
): Promise<Array<{ readonly x: number; readonly y: number } | undefined>> =>
  page.evaluate((ids: readonly string[]) => {
    const scope = globalThis as unknown as { __amemInspector: PageProbe };
    return ids.map((id) => scope.__amemInspector.viewportPosition(id));
  }, nodeIds);

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
      const scope = globalThis as unknown as { __amemInspector: PageProbe };
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

const sameCamera = (left: PageCamera, right: PageCamera): boolean =>
  Math.abs(left.x - right.x) < 1e-9 &&
  Math.abs(left.y - right.y) < 1e-9 &&
  Math.abs(left.ratio - right.ratio) < 1e-9;

const browserUnavailable =
  "The responsive scale check needs the Playwright Chromium build. Install it with " +
  "`npx playwright-core install chromium` (or reuse an existing Playwright browser cache) and " +
  "run `npm run inspector:responsive` again.";

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
      browser = await chromium
        .launch({
          args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
        })
        .catch((cause: unknown) => {
          throw new Error(
            `${browserUnavailable} (${cause instanceof Error ? cause.message : String(cause)})`,
          );
        });
      const page = await browser.newPage({
        viewport: { width: 1180, height: 820 },
      });
      const webglRenderer = await page
        .evaluate(() => {
          interface GlContext {
            getExtension(
              name: string,
            ): { UNMASKED_RENDERER_WEBGL: number } | null;
            getParameter(parameter: number): unknown;
          }
          const scope = globalThis as unknown as {
            document?: {
              createElement(tag: string): {
                getContext(id: string): GlContext | null;
              };
            };
          };
          const canvas = scope.document?.createElement("canvas");
          const context = canvas?.getContext("webgl2") ?? null;
          const info =
            context?.getExtension("WEBGL_debug_renderer_info") ?? null;
          if (context === null || info === null) {
            return "unknown";
          }
          const renderer = context.getParameter(info.UNMASKED_RENDERER_WEBGL);
          return typeof renderer === "string" ? renderer : "unknown";
        })
        .catch(() => "unknown");
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
            __amemInspector?: PageProbe;
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

      // A search during the update runs through the real form and results list.
      const centre = {
        x: (stage?.x ?? 0) + (stage?.width ?? 0) / 2,
        y: (stage?.y ?? 0) + (stage?.height ?? 0) / 2,
      };
      const searchStarted = Date.now();
      await page.fill("#query", "synthetic scale query");
      await page.press("#query", "Enter");
      await page.waitForFunction(
        () => {
          const scope = globalThis as unknown as { __amemInspector: PageProbe };
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

      // The update grows the corpus while the interactions run.
      memory.grow();
      const after = memory.counts();
      const refreshStarted = Date.now();
      const post = await page.request.post(`${baseUrl}/api/refresh`);
      expect(post.status()).toBe(202);

      const clickStarted = Date.now();
      await page.click("#results-list .result button");
      await page.waitForFunction(
        () => {
          const scope = globalThis as unknown as { __amemInspector: PageProbe };
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

      const zoomLatencies: number[] = [];
      const panLatencies: number[] = [];
      let cameraBeforeApply = await camera(page);
      let appliedAt = 0;
      const deadline = Date.now() + 180_000;
      for (let round = 0; ; round += 1) {
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
        cameraBeforeApply = await camera(page);
        const current = await diagnostics(page);
        if (current.nodes === after.nodes && current.links === after.links) {
          appliedAt = Date.now();
          break;
        }
        // A human-paced interaction rate; the update must stay pending while it runs.
        await page.waitForTimeout(150);
        if (Date.now() > deadline) {
          throw new Error(
            `The refresh never applied: the display kept ${String(current.nodes)} of ${String(after.nodes)} memories.`,
          );
        }
      }
      const updateRequestToAppliedMs = appliedAt - refreshStarted;
      const updateCamera = await camera(page);
      const updateDiagnostics = await diagnostics(page);

      expect(updateDiagnostics.nodes).toBe(after.nodes);
      expect(updateDiagnostics.links).toBe(after.links);
      expect(updateDiagnostics.selectedId).toBe(selectedDuringUpdate);
      expect(sameCamera(updateCamera, cameraBeforeApply)).toBe(true);
      const changed = await display(page, [syntheticId(0)]);
      expect(changed[0]?.label).toContain("remains the same subject");
      expect(pageProblems).toEqual([]);

      // A failed refresh keeps the last completed view instead of emptying the map.
      const beforeFailure = await diagnostics(page);
      memory.failExport = "The synthetic export failed.";
      const failed = await page.request.post(`${baseUrl}/api/refresh`);
      expect(failed.status()).toBe(202);
      await page.waitForFunction(
        () => {
          const scope = globalThis as unknown as { __amemInspector: PageProbe };
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
          cameraPreservedAcrossUpdate: sameCamera(
            updateCamera,
            cameraBeforeApply,
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
      await browser?.close();
      await session.stop();
      await server.close();
    }
  }, 480_000);
});
