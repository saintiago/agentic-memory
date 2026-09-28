import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Launch check of the documented `npm run service` runtime: the entry point fails on an
 * incomplete configuration before touching the journal or a provider, and starts the loopback
 * listener independently of provider initialization.
 *
 * See service/README.md and docs/development.md#toolchain-and-validation-commands.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface Run {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  /** Send SIGTERM once the service prints its listening line. */
  readonly stopAfterListening?: boolean;
}

/** Run the service entry point with only the supplied `AMEM_*` settings. */
const runService = (
  settings: Record<string, string>,
  options: RunOptions = {},
): Promise<Run> =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    for (const name of Object.keys(env)) {
      if (name.startsWith("AMEM_")) {
        delete env[name];
      }
    }
    Object.assign(env, settings);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "service/main.ts"],
      {
        cwd: repositoryRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let stopping = false;
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The memory service did not exit in time."));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (
        options.stopAfterListening === true &&
        !stopping &&
        stdout.includes("listening")
      ) {
        stopping = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });

describe("memory service launch", () => {
  it("fails on an incomplete configuration before touching the journal", async () => {
    const run = await runService({});
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "AMEM_QDRANT_URL must be supplied by the host.",
    );
    expect(run.stdout).not.toContain("listening");
  }, 60_000);

  it("fails on a malformed host setting", async () => {
    const run = await runService({
      AMEM_QDRANT_URL: "http://127.0.0.1:1",
      AMEM_QDRANT_COLLECTION: "notes",
      AMEM_MODEL_ENDPOINT: "http://127.0.0.1:1/v1/chat/completions",
      AMEM_MODEL_ID: "test-model",
      AMEM_SERVICE_PORT: "not-a-port",
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("AMEM_SERVICE_PORT must be a safe integer.");
    expect(run.stdout).not.toContain("listening");
  }, 60_000);

  it("serves the loopback listener while provider initialization is failing", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "amem-service-launch-"),
    );
    directories.push(directory);
    const run = await runService(
      {
        AMEM_QDRANT_URL: "http://127.0.0.1:1",
        AMEM_QDRANT_COLLECTION: "launch-notes",
        AMEM_MODEL_ENDPOINT: "http://127.0.0.1:1/v1/chat/completions",
        AMEM_MODEL_ID: "test-model",
        AMEM_SERVICE_PORT: "0",
        AMEM_SERVICE_DATA_DIR: path.join(directory, "service"),
        AMEM_EMBEDDING_CACHE: path.join(directory, "embeddings"),
        AMEM_ALLOW_EMBEDDING_DOWNLOADS: "false",
      },
      { stopAfterListening: true },
    );
    expect(run.stdout).toContain("listening on http://127.0.0.1:");
    expect(run.code).toBe(0);
  }, 60_000);
});
