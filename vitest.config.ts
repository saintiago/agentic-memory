import { defineConfig } from "vitest/config";

/** Deterministic unit, component and contract tests. No network, paid calls or external services. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "test/embeddings/**"],
  },
});
