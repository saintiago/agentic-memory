/** Use reachability, rather than a noisy heap-size threshold, to detect retained export pages. */
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { EmbeddedPage } from "../../../src/index.js";
import { createThreadProjectionRunner } from "../../../inspector/projection-runner.js";
import { InspectionSession } from "../../../inspector/session.js";
import { note, vector } from "../support/inspection.js";

assert(global.gc, "Run this fixture with --expose-gc.");
const pages: WeakRef<EmbeddedPage>[] = [];
const session = new InspectionSession({
  collection: "notes",
  embeddingSpaceId: "retention-test",
  store: {
    async pageEmbedded(_limit, cursor) {
      const start = cursor === undefined ? 0 : 10;
      const page: EmbeddedPage = {
        records: Array.from({ length: 10 }, (_, index) => ({
          note: note(start + index),
          vector: vector(start + index, 1_024),
        })),
        ...(start === 0 ? { cursor: 10 } : {}),
      };
      pages.push(new WeakRef(page));
      return page;
    },
  },
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
