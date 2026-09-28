import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  openReferenceEmbedder,
  referenceEmbeddingSpace,
} from "../../src/index.js";
import { openWorkerEmbedder } from "../../service/encoder-host.js";

/**
 * Explicit pinned-artifact check of the service's shared encoder worker: the production worker
 * entry loads the pinned encoder inside its own thread, reports the declared space and serves
 * inference with the same vectors as the in-process reference encoder, then releases the thread.
 *
 * docs/service.md#async-work-and-resource-sharing, docs/embeddings.md#verification
 */

/** Artifacts are reused between runs here; override with AMEM_EMBEDDING_CACHE when needed. */
const cacheDir =
  process.env["AMEM_EMBEDDING_CACHE"] ??
  fileURLToPath(new URL("../../.data/embeddings", import.meta.url));

const maxDifference = (left: number[], right: number[]): number =>
  Math.max(
    ...left.map((value, index) => Math.abs(value - (right[index] ?? Infinity))),
  );

describe("service encoder worker against the pinned artifacts", () => {
  it("loads the pinned encoder in its own thread and serves the same vectors", async () => {
    const host = await openWorkerEmbedder({ cacheDir, allowDownloads: true });
    try {
      expect(host.space).toEqual({ ...referenceEmbeddingSpace });
      const reference = await openReferenceEmbedder({
        cacheDir,
        allowDownloads: false,
      });
      const text =
        "Removing a stale queue entry requires an operator approval.";
      const hosted = await host.embed(text);
      const direct = await reference.embed(text);
      expect(hosted).toHaveLength(referenceEmbeddingSpace.dimensions);
      expect(Math.hypot(...hosted)).toBeCloseTo(1, 5);
      // Two runs of the same pinned encoder, not a recorded golden vector: the worker serves the
      // real pinned encoder, not a substitute, another revision or another pooling setting.
      expect(maxDifference(hosted, direct)).toBeLessThan(1e-5);
    } finally {
      await host.close();
    }
  }, 120_000);
});
