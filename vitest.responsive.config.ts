import { defineConfig } from "vitest/config";

/**
 * The browser scale check of the inspection dashboard. It needs the Playwright Chromium build and
 * the built dashboard bundle, exercises a real browser and never silently passes without them.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/responsive/**/*.responsive.ts"],
    passWithNoTests: false,
    testTimeout: 480_000,
    hookTimeout: 480_000,
    fileParallelism: false,
  },
});
