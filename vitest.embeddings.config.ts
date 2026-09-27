import { defineConfig } from "vitest/config";

/**
 * Explicit pinned-artifact encoder integration check against the real embedding runtime. An empty
 * scope fails instead of reporting a pass. The first run downloads the pinned revision into the
 * shared cache, so loading gets the same timeout as the real-infrastructure scope.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/embeddings/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
