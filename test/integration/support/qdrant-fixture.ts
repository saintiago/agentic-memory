/**
 * Isolated Qdrant for the integration scope. The fixture either connects to an already prepared
 * server (`AMEM_QDRANT_URL`) or starts a pinned local Qdrant binary (`AMEM_QDRANT_BIN` or `qdrant`
 * on PATH) with a temporary storage directory. It never starts Docker and never touches another
 * process's storage.
 *
 * See docs/development.md#local-qdrant-fixture.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

declare module "vitest" {
  export interface ProvidedContext {
    qdrantUrl: string;
  }
}

export interface QdrantFixture {
  readonly url: string;
  dispose(): Promise<void>;
}

const READINESS_TIMEOUT_MS = 60_000;
/** The Qdrant minor version this repository pins for repeatable integration evidence. */
const PINNED_SERVER_MINOR = "1.19";

const isReady = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(`${url}/readyz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const waitUntilReady = async (
  url: string,
  describeFailure: () => string,
): Promise<void> => {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isReady(url)) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `Qdrant at ${url} did not become ready. ${describeFailure()}`,
  );
};

/** Refuse an untested server version instead of reporting evidence from a different baseline. */
const assertPinnedVersion = async (url: string): Promise<void> => {
  const response = await fetch(`${url}/`);
  const body = (await response.json()) as { version?: unknown };
  const version = typeof body.version === "string" ? body.version : "unknown";
  if (!version.startsWith(`${PINNED_SERVER_MINOR}.`)) {
    throw new Error(
      `The integration scope pins Qdrant ${PINNED_SERVER_MINOR}.x, but the server at ${url} ` +
        `reports ${version}. Start the pinned fixture from ` +
        "docs/development.md#local-qdrant-fixture.",
    );
  }
};

const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

/** Resolve once the process exists, or reject with the spawn error that prevented it. */
const waitForSpawn = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    if (child.pid !== undefined) {
      resolve();
      return;
    }
    child.once("spawn", () => resolve());
    child.once("error", (error) => reject(error));
  });

const locateBinary = async (): Promise<string | undefined> => {
  const configured = process.env["AMEM_QDRANT_BIN"];
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return await new Promise((resolve) => {
    execFile("which", ["qdrant"], (error, stdout) => {
      const found = stdout.trim();
      resolve(error === null && found.length > 0 ? found : undefined);
    });
  });
};

const startBinary = async (binary: string): Promise<QdrantFixture> => {
  const storagePath = await mkdtemp(join(tmpdir(), "amem-qdrant-"));
  const httpPort = await freePort();
  const grpcPort = await freePort();
  const url = `http://127.0.0.1:${httpPort}`;
  const log: string[] = [];
  const child: ChildProcess = spawn(binary, [], {
    // Keep any working-directory artifact of the server inside the disposable directory.
    cwd: storagePath,
    env: {
      ...process.env,
      QDRANT__SERVICE__HOST: "127.0.0.1",
      QDRANT__SERVICE__HTTP_PORT: String(httpPort),
      QDRANT__SERVICE__GRPC_PORT: String(grpcPort),
      QDRANT__STORAGE__STORAGE_PATH: storagePath,
      QDRANT__TELEMETRY_DISABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  collectOutput(child, log);
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => {
      if (child.pid === undefined) {
        resolve();
      }
    });
  });

  const dispose = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(10_000).then(() => false),
      ]);
      if (!stopped) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    await rm(storagePath, { recursive: true, force: true });
  };

  try {
    await waitForSpawn(child);
    await waitUntilReady(url, () => `Log:\n${log.join("")}`);
    await assertPinnedVersion(url);
  } catch (error) {
    await dispose();
    throw error;
  }
  return { url, dispose };
};

/** Collect the pinned binary's output so a startup failure can be diagnosed. */
const collectOutput = (child: ChildProcess, log: string[]): void => {
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.once("error", (error) => {
    log.push(`${error.message}\n`);
  });
};

/** Start an isolated Qdrant, or connect to the one prepared by the host. */
export const startQdrantFixture = async (): Promise<QdrantFixture> => {
  const externalUrl = process.env["AMEM_QDRANT_URL"];
  if (externalUrl !== undefined && externalUrl.length > 0) {
    const url = externalUrl.replace(/\/$/, "");
    await waitUntilReady(
      url,
      () =>
        "Check the configured Qdrant and the docs/development.md preparation steps.",
    );
    await assertPinnedVersion(url);
    return { url, dispose: async () => undefined };
  }

  const binary = await locateBinary();
  if (binary === undefined) {
    throw new Error(
      "The integration scope needs a real Qdrant. Start the pinned fixture from " +
        "docs/development.md#local-qdrant-fixture and set AMEM_QDRANT_URL, or set " +
        "AMEM_QDRANT_BIN to a pinned Qdrant 1.19 binary. Integration tests never skip silently.",
    );
  }
  return await startBinary(binary);
};
