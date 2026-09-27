import { defineConfig } from "vitest/config";

/**
 * Explicit pinned-artifact encoder integration check against the real embedding runtime. An empty
 * scope fails instead of reporting a pass; the embeddings implementation task adds its cases here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/embeddings/**/*.test.ts"],
    passWithNoTests: false,
  },
});
