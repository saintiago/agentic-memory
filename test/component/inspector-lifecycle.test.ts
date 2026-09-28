import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { uuid, waitFor } from "./support/inspection.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("inspection process lifecycle", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s terminates stalled SDK export, detail and search requests before their timeout",
    async (signal) => {
      const held = new Set<string>();
      const closed = new Set<string>();
      // Controlled provider protocol, using the real SDK and NoteStore; no real Qdrant service.
      const provider = createServer((request, response) => {
        const route = request.url ?? "";
        request.resume();
        if (route.includes("/points")) {
          held.add(route);
          response.once("close", () => {
            closed.add(route);
          });
          return;
        }
        const space = {
          id: "shutdown-test",
          dimensions: 4,
          distance: "Cosine",
        };
        const body =
          route === "/"
            ? { version: "1.19.1" }
            : {
                status: "ok",
                time: 0,
                result: route.endsWith("/exists")
                  ? { exists: true }
                  : {
                      config: {
                        params: {
                          vectors: {
                            size: 4,
                            distance: "Cosine",
                            datatype: "float32",
                          },
                        },
                        metadata: {
                          agenticMemory: {
                            schemaVersion: 1,
                            representation: "amem-note-v1",
                            embeddingSpace: space,
                          },
                        },
                      },
                    },
              };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const address = provider.address();
      if (address === null || typeof address === "string")
        throw new Error("No provider port.");
      const child = fork(
        "test/component/fixtures/inspection-shutdown.ts",
        [`http://127.0.0.1:${String(address.port)}`],
        {
          cwd: root,
          execArgv: ["--import", "tsx"],
          silent: true,
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = once(child, "exit");
      const requests: Promise<unknown>[] = [];
      try {
        const [message] = await once(child, "message");
        const { port } = message as { port: number };
        const base = `http://127.0.0.1:${String(port)}`;
        requests.push(
          fetch(`${base}/api/notes/${uuid(0)}`).catch(() => undefined),
        );
        requests.push(
          fetch(`${base}/api/search`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "held search" }),
          }).catch(() => undefined),
        );
        await waitFor(
          () => held.size === 3,
          "SDK scroll, retrieve and query requests",
        );
        const started = Date.now();
        child.kill(signal);
        await waitFor(
          () => child.exitCode !== null,
          "host exit without the 30-second provider timeout",
          3_000,
        );
        expect(await exited, stderr).toEqual([0, null]);
        expect(Date.now() - started).toBeLessThan(3_000);
        await waitFor(() => closed.size === 3, "all provider sockets to close");
        await Promise.all(requests);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited;
        provider.closeAllConnections();
        await new Promise<void>((resolve) =>
          provider.close(() => {
            resolve();
          }),
        );
        await Promise.all(requests);
      }
    },
    15_000,
  );

  it("releases prior pages across repeated multi-page refreshes while still running", async () => {
    const run = await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "test/component/fixtures/inspection-retention.ts",
      ],
      { cwd: root, timeout: 60_000 },
    );
    expect(run.stderr).toBe("");
  }, 65_000);
});
