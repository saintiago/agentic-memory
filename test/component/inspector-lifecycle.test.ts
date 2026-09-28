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
    "%s terminates stalled service export, detail and search requests before their timeout",
    async (signal) => {
      const held = new Set<string>();
      const closed = new Set<string>();
      // Controlled memory-service protocol; the host's real client and shutdown path run.
      const provider = createServer((request, response) => {
        const route = request.url ?? "";
        request.resume();
        if (route === "/v1/status") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              collection: "notes",
              embeddingSpace: {
                id: "shutdown-test",
                dimensions: 4,
                distance: "Cosine",
              },
              availability: {
                submission: true,
                retrieval: true,
                ingestion: true,
              },
            }),
          );
          return;
        }
        // The export, detail and search requests stay unanswered until the host exits.
        held.add(route);
        response.once("close", () => {
          closed.add(route);
        });
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
          "service export, detail and search requests",
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
