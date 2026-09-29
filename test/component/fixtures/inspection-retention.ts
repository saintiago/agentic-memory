/** Use reachability, rather than a noisy heap-size threshold, to detect retained export pages. */
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createThreadProjectionRunner } from "../../../inspector/projection-runner.js";
import { InspectionSession } from "../../../inspector/session.js";
import type {
  InspectionPage,
  InspectionSource,
} from "../../../inspector/source.js";
import { note, vector } from "../support/inspection.js";

assert(global.gc, "Run this fixture with --expose-gc.");
const pages: WeakRef<InspectionPage>[] = [];
/** The two-page service export; every page must become collectible after it was consumed. */
const source: InspectionSource = {
  identity() {
    return Promise.resolve({
      collection: "notes",
      embeddingSpaceId: "retention-test",
    });
  },
  async pageEmbedded(_limit: number, cursor?: string) {
    const start = cursor === undefined ? 0 : 10;
    const page: InspectionPage = {
      records: Array.from({ length: 10 }, (_, index) => ({
        note: note(start + index),
        vector: vector(start + index, 1_024),
      })),
      ...(start === 0 ? { cursor: "page-2" } : {}),
    };
    pages.push(new WeakRef(page));
    return page;
  },
  get() {
    return Promise.resolve(undefined);
  },
  search() {
    return Promise.resolve([]);
  },
};
const session = new InspectionSession({
  source,
  runner: createThreadProjectionRunner(),
  artifacts: {
    async load() {
      return undefined;
    },
    async save() {},
  },
  pollIntervalMs: 0,
});
try {
  for (let refresh = 0; refresh < 100; refresh += 1) {
    session.refresh();
    await session.settled();
    assert.equal(session.snapshot().error, undefined);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    await setImmediate();
    global.gc();
  }
  assert.equal(pages.length, 200);
  assert.equal(
    pages.filter((page) => page.deref() !== undefined).length,
    0,
    "Completed export pages must be collectible before stopping the session.",
  );
  assert.equal(session.snapshot().view?.nodes.length, 20);
} finally {
  await session.stop();
}
