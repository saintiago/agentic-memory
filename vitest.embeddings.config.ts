import { defineConfig } from "vitest/config";

/**
 * Explicit pinned-artifact encoder integration check against the real embedding runtime. An empty
 * scope fails instead of reporting a pass. The first run downloads the pinned revision into the
 * shared cache, so loading gets the same timeout as the real-infrastructure scope. Each file loads
 * the real model, so files run in sequence rather than doubling the peak model memory.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/embeddings/**/*.test.ts"],
    globalSetup: ["test/embeddings/support/global-setup.ts"],
    fileParallelism: false,
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
