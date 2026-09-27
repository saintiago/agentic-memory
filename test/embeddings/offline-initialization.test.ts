import { env } from "@huggingface/transformers";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openReferenceEmbedder } from "../../src/embeddings/index.js";

/**
 * A complete pinned cache must initialize and embed without any network access. This check lives in
 * its own file, before anything has loaded the repository by name in this process, and replaces the
 * runtime's fetch function with a rejecting probe, so any request fails the run and names itself.
 *
 * docs/embeddings.md#reference-encoder, docs/development.md#local-encoder-fixture
 */

/** The global setup warm cache; override with AMEM_EMBEDDING_CACHE when needed. */
const cacheDir =
  process.env["AMEM_EMBEDDING_CACHE"] ??
  fileURLToPath(new URL("../../.data/embeddings", import.meta.url));

/** Every request the blocked runtime attempted, so a failure names what was requested. */
const requested: string[] = [];

env.fetch = (input: string | URL) => {
  requested.push(String(input));
  return Promise.reject(
    new Error(`Network access was blocked for ${String(input)}`),
  );
};

describe("offline initialization from the pinned cache", () => {
  it("creates the encoder and embeds without a network request", async () => {
    const embedder = await openReferenceEmbedder({
      cacheDir,
      allowDownloads: false,
    });

    const first = await embedder.embed(
      "Removing a stale queue entry requires an operator approval.",
    );
    const second = await embedder.embed(
      "The harbour crane lifts containers from the freight terminal.",
    );

    expect(requested).toEqual([]);
    expect(first).toHaveLength(1024);
    expect(second).toHaveLength(1024);
    expect(Math.abs(Math.hypot(...first) - 1)).toBeLessThan(1e-5);
    // Different subjects must not collapse onto one vector in this space.
    expect(
      Math.max(
        ...first.map((value, index) =>
          Math.abs(value - (second[index] ?? Number.POSITIVE_INFINITY)),
        ),
      ),
    ).toBeGreaterThan(0.01);
  });
});
