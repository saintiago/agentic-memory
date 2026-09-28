/**
 * The real-renderer check of the added-outlier guarantee: the browser applies a completed view
 * whose extent grows far to one side and the memories that were already displayed must keep their
 * viewport positions, without user camera input and without a camera reset.
 *
 * See docs/dashboard.md#live-updates-with-sigma and docs/dashboard.md#large-collections.
 */
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
