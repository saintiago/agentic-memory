import { defineConfig } from "vitest/config";

/** Deterministic unit, component and contract tests. No network, paid calls or external services. */
export default defineConfig({
  test: {
    environment: "node",
    // Library component tests plus the colocated dashboard tests, which need the DOM
    // environment per file and never run inside the node-only type program.
    include: ["test/**/*.test.ts", "inspector/ui/tests/**/*.test.ts"],
    exclude: ["test/integration/**", "test/embeddings/**"],
  },
});
