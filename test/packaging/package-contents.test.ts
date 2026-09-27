import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

type PackedFile = { path: string };

/** Ask npm what it would publish, without building, running scripts or writing a tarball. */
function packedFileNames(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: repositoryRoot },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`npm pack failed: ${stderr || error.message}`));
          return;
        }
        const [packed] = JSON.parse(stdout) as Array<{ files: PackedFile[] }>;
        resolve((packed?.files ?? []).map((file) => file.path));
      },
    );
  });
}

/** docs/development.md#toolchain-and-validation-commands */

describe("published package contents", () => {
  let files: string[] = [];

  beforeAll(async () => {
    files = await packedFileNames();
  });

  it("ships only the built package alongside the always-included manifest and readme", () => {
    expect(files).toContain("package.json");
    expect(
      files.filter((file) => !/^(dist\/|package\.json|README\.md)/.test(file)),
    ).toEqual([]);
  });

  it("keeps tests, sources, fixtures, local data and prototype paths out of the package", () => {
    expect(
      files.filter((file) =>
        /^(test|src|docs|scripts|experiments|examples|\.data)\//.test(file),
      ),
    ).toEqual([]);
    expect(
      files.filter((file) =>
        /(^|\/)(\.env|node_modules|\.turbo|coverage)/.test(file),
      ),
    ).toEqual([]);
  });
});
