/**
 * The real-renderer check of the added-outlier guarantee: the browser applies a completed view
 * whose extent grows far to one side and the memories that were already displayed must keep their
 * viewport positions, without user camera input and without a camera reset.
 *
 * See docs/dashboard.md#live-updates-with-sigma and docs/dashboard.md#large-collections.
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { InspectionSession } from "../../inspector/session.js";
import {
  startInspectionServer,
  type InspectionServer,
} from "../../inspector/server.js";
import { SyntheticMemory, syntheticId, syntheticOutlierId } from "./corpus.js";
import {
  diagnostics,
  display,
  launchChromium,
  maxViewportDrift,
  pollNow,
  settleFrames,
  viewportPositions,
  waitForStableCamera,
} from "./probes.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The far position the growth step adds; its x is far outside the projected disc. */
const outlierPosition = { x: 1400, y: 55 };

describe("inspection dashboard camera", () => {
  it("keeps already displayed memories in place when an outlier grows the extent", async () => {
    const uiDirectory = path.join(repositoryRoot, "inspector/ui");
    const bundle = path.join(uiDirectory, "build/app.js");
    if (!existsSync(bundle)) {
      throw new Error(
        "The dashboard browser bundle is missing. `npm run inspector:responsive` builds it " +
          "first; run `npm run inspector:build` before starting this check directly.",
      );
    }

    const memory = new SyntheticMemory({
      nodes: 120,
      linksPerNode: 1,
      growthNodes: 8,
      growthLinksPerNode: 1,
      growthOutlier: outlierPosition,
      exportDelayMs: 5,
      projectionDelayMs: 10,
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

    let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
    try {
      browser = await launchChromium();
      const page = await browser.newPage({
        viewport: { width: 1180, height: 820 },
      });
      const pageProblems: string[] = [];
      page.on("pageerror", (error) => pageProblems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          pageProblems.push(message.text());
        }
      });

      const baseUrl = `http://127.0.0.1:${String(server.port)}`;
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
          const state = scope.__amemInspector?.diagnostics();
          return (
            state?.status === "ready" &&
            state.nodes === expected.nodes &&
            state.links === expected.links
          );
        },
        { nodes: initial.nodes, links: initial.links },
        { timeout: 120_000 },
      );
      await settleFrames(page);
      const stage = await page.locator("#graph-stage").boundingBox();
      expect(stage).not.toBeNull();

      // A user camera state that the update must not disturb: the fitted view is moved and zoomed.
      const centre = {
        x: (stage?.x ?? 0) + (stage?.width ?? 0) / 2,
        y: (stage?.y ?? 0) + (stage?.height ?? 0) / 2,
      };
      await page.mouse.move(centre.x + 120, centre.y - 60);
      await page.mouse.wheel(0, -240);
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down();
      await page.mouse.move(centre.x + 90, centre.y - 45, { steps: 4 });
      await page.mouse.up();
      await settleFrames(page);
      // Sigma animates zoom and drag inertia; the baseline must come from a settled camera.
      await waitForStableCamera(page);

      const sampleIds = [0, 5, 60, 119].map((index) => syntheticId(index));
      const positionsBefore = await viewportPositions(page, sampleIds);
      expect(positionsBefore.every((position) => position !== undefined)).toBe(
        true,
      );
      for (const position of positionsBefore) {
        expect(position?.x ?? -1).toBeGreaterThan(-(stage?.width ?? 0));
        expect(position?.x ?? -1).toBeLessThan(2 * (stage?.width ?? 0));
        expect(position?.y ?? -1).toBeGreaterThan(-(stage?.height ?? 0));
        expect(position?.y ?? -1).toBeLessThan(2 * (stage?.height ?? 0));
      }

      // The completed view grows the extent far to one side while no user input arrives.
      memory.grow();
      const after = memory.counts();
      const posted = await page.request.post(`${baseUrl}/api/refresh`);
      expect(posted.status()).toBe(202);
      await pollNow(page);
      await page.waitForFunction(
        (expected: { readonly nodes: number; readonly links: number }) => {
          const scope = globalThis as unknown as {
            __amemInspector?: {
              diagnostics(): { readonly nodes: number; readonly links: number };
            };
          };
          const state = scope.__amemInspector?.diagnostics();
          return (
            state?.nodes === expected.nodes && state.links === expected.links
          );
        },
        { nodes: after.nodes, links: after.links },
        { timeout: 120_000 },
      );
      await settleFrames(page);

      // The new memory is displayed at its projected position, so the extent really did grow.
      const outlier = await display(page, [syntheticOutlierId]);
      expect(outlier).toHaveLength(1);
      expect(outlier[0]?.x).toBeCloseTo(outlierPosition.x, 6);
      expect(outlier[0]?.y).toBeCloseTo(outlierPosition.y, 6);

      // Acceptance check 1 extended: unchanged memories keep the viewport positions they had.
      const positionsAfter = await viewportPositions(page, sampleIds);
      const drift = maxViewportDrift(positionsBefore, positionsAfter);
      expect(drift).toBeLessThan(0.5);
      for (const position of positionsAfter) {
        expect(position).toBeDefined();
      }
      const applied = await diagnostics(page);
      expect(applied.nodes).toBe(after.nodes);
      expect(applied.links).toBe(after.links);
      expect(pageProblems).toEqual([]);
    } finally {
      await browser?.close();
      await session.stop();
      await server.close();
    }
  }, 180_000);
});

// A controlled browser clock makes identical wheel/drag input comparable across two real Sigma
// instances. Updating after 48 ms and observing further movement proves this covers active
// animation, rather than another settled-camera case.
interface CameraFixture {
  reset(): void;
  grow(): void;
  position(): { x: number; y: number };
  fit(): void;
  focus(): void;
  fitResults(): void;
  positionUpper(): { x: number; y: number };
  outlier(): { x: number; y: number };
}

describe("refresh during camera animation", () => {
  it.each(["wheel", "inertia"] as const)(
    "preserves the %s trajectory across bounds growth",
    async (gesture) => {
      const bundle = await build({
        entryPoints: [
          path.join(repositoryRoot, "inspector/ui/tests/camera-fixture.ts"),
        ],
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
      });
      const browser = await launchChromium();
      try {
        const page = await browser.newPage({
          viewport: { width: 800, height: 600 },
        });
        await page.clock.install({ time: new Date("2026-09-28T12:00:00Z") });
        await page.clock.pauseAt(new Date("2026-09-28T12:00:01Z"));
        await page.setContent(
          '<div id="stage" style="position:absolute;inset:0"></div>',
        );
        await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? "" });
        const call = (method: keyof CameraFixture) =>
          page.evaluate((method) => {
            const scope = globalThis as unknown as {
              cameraFixture: CameraFixture;
            };
            return scope.cameraFixture[method]();
          }, method);
        const runs: Array<Array<{ x: number; y: number } | void>> = [];
        for (const grow of [false, true]) {
          await call("reset");
          await page.clock.runFor(32);
          await page.mouse.move(480, 250);
          if (gesture === "wheel") {
            await page.mouse.wheel(0, -240);
          } else {
            await page.mouse.down();
            await page.mouse.move(500, 260);
            await page.clock.runFor(16);
            await page.mouse.move(530, 275);
            await page.mouse.up();
          }
          await page.clock.runFor(48);
          const before = await call("position");
          if (grow) await call("grow");
          const immediate = await call("position");
          await page.clock.runFor(32);
          const during = await call("position");
          // Keep both runs on the same 16 ms animation-frame phase.
          await page.clock.runFor(512);
          const finished = await call("position");
          // The animation advances both after the update and after the next sampled frame.
          expect(during).not.toEqual(before);
          expect(finished).not.toEqual(during);
          expect(
            maxViewportDrift([before ?? undefined], [immediate ?? undefined]),
          ).toBeLessThan(0.5);
          runs.push([before, during, finished]);
        }
        expect(
          maxViewportDrift(
            runs[0]?.map((p) => p ?? undefined) ?? [],
            runs[1]?.map((p) => p ?? undefined) ?? [],
          ),
        ).toBeLessThan(0.5);
        // Stable normalization must not keep explicit Fit all from including the new extent.
        await call("fit");
        await page.clock.runFor(32);
        const outlier = await call("outlier");
        expect(outlier?.x).toBeGreaterThan(0);
        expect(outlier?.x).toBeLessThan(800);
        expect(outlier?.y).toBeGreaterThan(0);
        expect(outlier?.y).toBeLessThan(600);
        expect(await call("positionUpper")).toEqual(await call("position"));
        await call("fitResults");
        await page.clock.runFor(32);
        const result = await call("position");
        expect(result?.x).toBeGreaterThan(0);
        expect(result?.y).toBeLessThan(600);
        await call("focus");
        await page.clock.runFor(32);
        const focused = await call("position");
        expect(focused?.x).toBeCloseTo(400, 2);
        expect(focused?.y).toBeCloseTo(300, 2);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
