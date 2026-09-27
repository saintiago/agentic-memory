import { defineConfig } from "vitest/config";

/**
 * The offline graph inspection entry point: it renders one saved run directory into a self-contained
 * HTML report and its JSON evidence. It requires explicit `AMEM_GRAPH_*` settings and fails instead
 * of reporting a pass when they are missing. See experiments/README.md.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["experiments/**/*.graph.ts"],
    passWithNoTests: false,
    testTimeout: 300_000,
  },
});
