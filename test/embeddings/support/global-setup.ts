import { fileURLToPath } from "node:url";
import { openReferenceEmbedder } from "../../../src/embeddings/index.js";

/**
 * Warm the pinned artifact cache before the encoder checks run. The first run downloads the pinned
 * revision into the cache; later runs reuse it. Preparing the cache in the setup process, outside
 * every test worker, keeps each check's view of the runtime's own metadata memo cold, so an offline
 * check really exercises offline creation.
 *
 * docs/development.md#local-encoder-fixture
 */

/** Artifacts are reused between runs here; override with AMEM_EMBEDDING_CACHE when needed. */
const cacheDir =
  process.env["AMEM_EMBEDDING_CACHE"] ??
  fileURLToPath(new URL("../../../.data/embeddings", import.meta.url));

export default async function setup(): Promise<void> {
  await openReferenceEmbedder({ cacheDir, allowDownloads: true });
}
