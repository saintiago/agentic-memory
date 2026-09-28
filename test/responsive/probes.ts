/**
 * The browser probes the responsive checks share: the dashboard hook of the served page, the
 * controlled Chromium launch and the small sampling helpers that read what the real renderer
 * currently shows.
 *
 * See docs/dashboard.md#asynchronous-data-updates and docs/testing.md#choosing-scope.
 */
import { chromium, type Browser, type Page } from "playwright-core";

/** The dashboard state the page exposes for the responsive checks. */
export interface PageDiagnostics {
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

export interface PageDisplay {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

export interface PageCamera {
  readonly x: number;
  readonly y: number;
  readonly ratio: number;
}

export interface PageProbe {
  diagnostics(): PageDiagnostics;
  display(nodeIds: readonly string[]): PageDisplay[];
  cameraState(): PageCamera;
  viewportPosition(
    nodeId: string,
  ): { readonly x: number; readonly y: number } | undefined;
  pollNow(): void;
}

export const browserUnavailable =
  "The responsive checks need the Playwright Chromium build. Install it with " +
  "`npx playwright-core install chromium` (or reuse an existing Playwright browser cache) and " +
  "run the check again.";

/** Launch the pinned Chromium or fail with instructions instead of reporting a pass. */
export const launchChromium = async (): Promise<Browser> =>
  chromium
    .launch({ args: ["--no-sandbox", "--enable-unsafe-swiftshader"] })
    .catch((cause: unknown) => {
      throw new Error(
        `${browserUnavailable} (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    });

/** The WebGL renderer of the launched browser; software rasterizers are reported as such. */
export const webglRendererDescription = (page: Page): Promise<string> =>
  page
    .evaluate(() => {
      interface GlContext {
        getExtension(name: string): { UNMASKED_RENDERER_WEBGL: number } | null;
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
      const info = context?.getExtension("WEBGL_debug_renderer_info") ?? null;
      if (context === null || info === null) {
        return "unknown";
      }
      const renderer = context.getParameter(info.UNMASKED_RENDERER_WEBGL);
      return typeof renderer === "string" ? renderer : "unknown";
    })
    .catch(() => "unknown");

export const diagnostics = (page: Page): Promise<PageDiagnostics> =>
  page.evaluate(() => {
    const scope = globalThis as unknown as { __amemInspector: PageProbe };
    return scope.__amemInspector.diagnostics();
  });

export const camera = (page: Page): Promise<PageCamera> =>
  page.evaluate(() => {
    const scope = globalThis as unknown as { __amemInspector: PageProbe };
    return scope.__amemInspector.cameraState();
  });

export const display = (
  page: Page,
  nodeIds: readonly string[],
): Promise<PageDisplay[]> =>
  page.evaluate((ids: readonly string[]) => {
    const scope = globalThis as unknown as { __amemInspector: PageProbe };
    return scope.__amemInspector.display(ids);
  }, nodeIds);

export const viewportPositions = (
  page: Page,
  nodeIds: readonly string[],
): Promise<Array<{ readonly x: number; readonly y: number } | undefined>> =>
  page.evaluate((ids: readonly string[]) => {
    const scope = globalThis as unknown as { __amemInspector: PageProbe };
    return ids.map((id) => scope.__amemInspector.viewportPosition(id));
  }, nodeIds);

export const pollNow = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const scope = globalThis as unknown as {
      __amemInspector?: { pollNow(): void };
    };
    scope.__amemInspector?.pollNow();
  });

const sameCamera = (left: PageCamera, right: PageCamera): boolean =>
  left.x === right.x && left.y === right.y && left.ratio === right.ratio;

/**
 * Wait until the camera stops moving. Sigma animates wheel zoom and drag inertia over several
 * frames, so a preservation baseline must be taken from a settled camera, not mid-animation.
 */
export const waitForStableCamera = async (page: Page): Promise<PageCamera> => {
  const deadline = Date.now() + 10_000;
  let previousAt = 0;
  let previous: PageCamera | undefined;
  for (;;) {
    const sample = await camera(page);
    const at = Date.now();
    if (
      previous !== undefined &&
      sameCamera(previous, sample) &&
      at - previousAt >= 200
    ) {
      return sample;
    }
    if (previous === undefined || !sameCamera(previous, sample)) {
      previous = sample;
      previousAt = at;
    }
    if (at > deadline) {
      return sample;
    }
    await page.waitForTimeout(60);
  }
};

/**
 * Let a scheduled Sigma refresh process and render the applied mutations. `viewportPosition` is
 * read through the renderer's matrix, which the render pass updates, so a sample must follow the
 * frame that rendered the change.
 */
export const settleFrames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const scope = globalThis as unknown as {
          requestAnimationFrame(callback: () => void): number;
          setTimeout(handler: () => void, delayMs: number): number;
        };
        scope.requestAnimationFrame(() => {
          scope.requestAnimationFrame(() => {
            scope.setTimeout(resolve, 50);
          });
        });
      }),
  );

/** The largest distance two samples of one node's viewport position drifted. */
export const maxViewportDrift = (
  before: ReadonlyArray<{ readonly x: number; readonly y: number } | undefined>,
  after: ReadonlyArray<{ readonly x: number; readonly y: number } | undefined>,
): number => {
  let drift = 0;
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (left === undefined || right === undefined) {
      drift = Number.POSITIVE_INFINITY;
      continue;
    }
    drift = Math.max(drift, Math.hypot(left.x - right.x, left.y - right.y));
  }
  return drift;
};
