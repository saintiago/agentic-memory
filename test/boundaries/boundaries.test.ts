import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const depcruise = path.join(
  repositoryRoot,
  "node_modules",
  ".bin",
  "depcruise",
);

/** Run the boundaries check the way `npm run boundaries` does, reporting its exit code. */
function runBoundaries(
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      depcruise,
      args,
      { cwd: repositoryRoot },
      (error, stdout, stderr) => {
        const exitCode =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ exitCode, output: `${stdout}${stderr}` });
      },
    );
  });
}

describe("dependency boundaries", () => {
  it("accepts the repository sources and tests", async () => {
    const result = await runBoundaries([
      "--config",
      ".dependency-cruiser.cjs",
      "src",
      "examples",
      "experiments",
      "test",
    ]);

    expect(result.output).toContain("no dependency violations found");
    expect(result.exitCode).toBe(0);
  });

  it("rejects value and type-only imports of a component's private module", async () => {
    const result = await runBoundaries([
      "--config",
      "test/boundaries/fixtures/dependency-cruiser.config.cjs",
      "test/boundaries/fixtures",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("no-private-note-store-imports");
    expect(result.output).toContain("private-import.fixture.ts");
    expect(result.output).toContain("private-type-import.fixture.ts");
  });
});
