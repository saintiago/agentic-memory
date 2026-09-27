import { defineConfig } from "vitest/config";

/**
 * Isolated real-Qdrant contract and system checks. An empty scope fails instead of reporting a
 * pass; the NoteStore implementation tasks add their cases here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    passWithNoTests: false,
  },
});
