import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Launch check of the documented `npm run inspector` runtime: the TypeScript entry point starts
 * through the pinned loader and fails on an incomplete host configuration before any provider
 * work. A run that reported a listening host here would have opened the encoder and the collection.
 *
 * See inspector/README.md and docs/development.md#toolchain-and-validation-commands.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the inspection host entry point with only the supplied `AMEM_*` settings. */
const runHost = (settings: Record<string, string>): Promise<Run> =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    for (const name of Object.keys(env)) {
      if (name.startsWith("AMEM_")) {
        delete env[name];
      }
    }
    Object.assign(env, settings);
    execFile(
      process.execPath,
      ["--import", "tsx", "inspector/main.ts"],
      { cwd: repositoryRoot, env, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          code:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
          stdout,
          stderr,
        });
      },
    );
  });

describe("inspection host launch", () => {
  it("fails on an incomplete configuration before contacting the service", async () => {
    const run = await runHost({});
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "AMEM_SERVICE_URL must be supplied by the host.",
    );
    expect(run.stdout).not.toContain("listening");
  }, 60_000);

  it("fails on a malformed host setting before contacting the service", async () => {
    const run = await runHost({
      AMEM_SERVICE_URL: "http://127.0.0.1:4748",
      AMEM_INSPECTOR_PORT: "not-a-port",
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("AMEM_INSPECTOR_PORT must be a safe integer.");
    expect(run.stdout).not.toContain("listening");
  }, 60_000);
});
