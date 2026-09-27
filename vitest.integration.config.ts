import { defineConfig } from "vitest/config";

/**
 * Isolated real-Qdrant contract and system checks. One pinned local Qdrant is prepared for the run
 * and a missing server fails instead of reporting a pass. See
 * docs/development.md#local-qdrant-fixture.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/support/global-setup.ts"],
    // One shared server and a deliberate 10,000-point case: run files in sequence.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: false,
  },
});
