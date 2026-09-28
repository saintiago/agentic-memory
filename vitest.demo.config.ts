import { defineConfig } from "vitest/config";

/**
 * The deterministic replay demonstration. It uses the committed synthetic fixtures, an in-memory
 * store and deterministic stand-ins, so it needs no external service, credential or paid call. An
 * empty scope fails instead of reporting a pass.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["experiments/**/*.demo.ts"],
    passWithNoTests: false,
    testTimeout: 120_000,
  },
});
