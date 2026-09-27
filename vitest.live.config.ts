import { defineConfig } from "vitest/config";

/**
 * The opt-in live evaluation scope: real Qdrant, the pinned encoder and a paid provider call. It
 * requires explicit `AMEM_LIVE_*` settings and a declared budget, and fails instead of reporting a
 * pass when they are missing. See experiments/README.md.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["experiments/**/*.live.ts"],
    passWithNoTests: false,
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
  },
});
