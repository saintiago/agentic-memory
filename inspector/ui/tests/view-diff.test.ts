/**
 * The planner composition: parse and diff work that runs in a worker, a rejected payload that
 * leaves the healthy worker in place, and the inline fallback that reconciles the next completed
 * view against the display it replaced instead of an empty baseline.
 *
 * See docs/dashboard.md#asynchronous-data-updates and docs/dashboard.md#live-updates-with-sigma.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  createInlineViewDiffer,
  createViewDiffer,
  indexView,
  type ViewPlanRequest,
  type ViewPlanResponse,
} from "../view-diff.js";
import {
  graphEdge,
  graphNode,
  graphSnapshot,
  graphView,
  nodeId,
  snapshotText,
} from "./support.js";

/**
 * A worker substitute: it plans on the calling thread with the real planner and can be failed
 * through the same error event a browser worker fires when it dies.
 */
class FakeWorker extends EventTarget {
  static readonly instances: FakeWorker[] = [];
  readonly posted: ViewPlanRequest[] = [];
  terminated = false;
  #differ = createInlineViewDiffer();

  constructor() {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(request: ViewPlanRequest): void {
    this.posted.push(request);
    void this.#differ.plan(request.text).then(
      (diff) => {
        this.#reply({ id: request.id, diff });
      },
      (cause: unknown) => {
        this.#reply({
          id: request.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
  }

  terminate(): void {
    this.terminated = true;
  }

  fail(): void {
    this.dispatchEvent(new Event("error"));
  }

  #reply(response: ViewPlanResponse): void {
    if (this.terminated) {
      return;
    }
    this.dispatchEvent(new MessageEvent("message", { data: response }));
  }
}

const installWorker = (): void => {
  FakeWorker.instances.length = 0;
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
};

afterEach(() => {
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

describe("view differ", () => {
  it("plans in the worker while it is healthy", async () => {
    installWorker();
    const differ = createViewDiffer();
    const view = graphView({
      nodes: [graphNode(0), graphNode(1)],
      edges: [graphEdge(0, 1)],
    });

    const diff = await differ.plan(snapshotText(graphSnapshot({ view })));

    expect(diff.initial).toBe(true);
    expect(diff.addedNodes).toHaveLength(2);
    expect(differ.usesWorker()).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("reconciles the next completed view after a worker failure", async () => {
    installWorker();
    const differ = createViewDiffer();
    const first = graphView({
      nodes: [graphNode(0), graphNode(1)],
      edges: [graphEdge(0, 1)],
    });
    const firstDiff = await differ.plan(
      snapshotText(graphSnapshot({ view: first })),
    );
    expect(firstDiff.initial).toBe(true);
    // The dashboard hands the display it applied to the planner.
    differ.adopt(indexView(first));

    const worker = FakeWorker.instances[0];
    worker?.fail();

    const second = graphView({
      nodes: [graphNode(1), graphNode(2)],
      capturedAt: "2026-09-28T12:10:00.000Z",
    });
    const diff = await differ.plan(
      snapshotText(graphSnapshot({ view: second })),
    );

    expect(worker?.terminated).toBe(true);
    expect(differ.usesWorker()).toBe(false);
    // A replacement plan against the display removes what the view no longer holds and never
    // becomes an initial view that would fit the camera of an existing display.
    expect(diff.initial).toBe(false);
    expect(diff.addedNodes.map((node) => node.id)).toEqual([nodeId(2)]);
    expect(diff.updatedNodes).toEqual([]);
    expect(diff.removedNodeIds).toEqual([nodeId(0)]);
    expect(diff.removedLinkKeys).toHaveLength(1);
  });

  it("keeps a healthy worker when a served payload is rejected", async () => {
    installWorker();
    const differ = createViewDiffer();
    const view = graphView({ nodes: [graphNode(0)] });
    await differ.plan(snapshotText(graphSnapshot({ view })));

    await expect(differ.plan("{")).rejects.toThrow(
      "The graph response is not valid JSON.",
    );

    expect(differ.usesWorker()).toBe(true);
    expect(FakeWorker.instances[0]?.terminated).toBe(false);
    const next = graphView({
      nodes: [graphNode(0), graphNode(1)],
      capturedAt: "2026-09-28T12:20:00.000Z",
    });
    const diff = await differ.plan(snapshotText(graphSnapshot({ view: next })));
    expect(diff.addedNodes.map((node) => node.id)).toEqual([nodeId(1)]);
  });

  it("plans without a worker when the browser has none", async () => {
    const differ = createViewDiffer();
    const view = graphView({ nodes: [graphNode(0), graphNode(1)] });

    const diff = await differ.plan(snapshotText(graphSnapshot({ view })));

    expect(diff.initial).toBe(true);
    expect(differ.usesWorker()).toBe(false);
  });
});
