/**
 * Component tests of the launched AMEM memory MCP server: the published start command over real
 * stdio against a real service with controlled providers, a raw protocol session that keeps
 * stdout protocol-clean, several MCP clients sharing one service queue and encoder, the module
 * graph of one session and startup failure.
 *
 * See docs/mcp.md#lifecycle-and-verification.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { readMcpSettings, defaultServiceUrl } from "../../mcp/settings.js";
import { createMemoryServiceClient } from "../../service/client.js";
import {
  startServiceHarness,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
/** The published start command; package.json and mcp/README.md must agree with it. */
const launchArguments = ["--import", "tsx", "mcp/main.ts"];
const loadLogFixture = path.join(
  repositoryRoot,
  "test/component/fixtures/mcp-load-log.mjs",
);

interface Session {
  readonly client: Client;
  close(): Promise<void>;
}

const harnesses: ServiceHarness[] = [];
const sessions: Session[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

/** Start one real MCP host process over stdio and complete its initialization handshake. */
const startHost = async (options: {
  baseUrl: string;
  args?: string[];
  environment?: Record<string, string>;
}): Promise<Client> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: options.args ?? launchArguments,
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      AMEM_MCP_SERVICE_URL: options.baseUrl,
      ...(options.environment ?? {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "amem-mcp-launch-test", version: "0.0.0" });
  await client.connect(transport);
  sessions.push({ client, close: () => client.close() });
  return client;
};

/** Close one session early and drop it from the shared cleanup list. */
const closeSession = async (client: Client): Promise<void> => {
  const index = sessions.findIndex((session) => session.client === client);
  if (index >= 0) {
    sessions.splice(index, 1);
  }
  await client.close();
};

/** Resolve with the exit code once the child exits, or fail after the timeout. */
const waitForExit = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 15_000,
): Promise<number | null> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("The MCP server process did not exit."));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

describe("launched AMEM memory MCP server", () => {
  it("publishes the start command of the repository", () => {
    expect(packageJson.scripts.mcp).toBe(`node ${launchArguments.join(" ")}`);
    expect(readMcpSettings({})).toEqual({ serviceUrl: defaultServiceUrl });
    expect(readMcpSettings({ AMEM_MCP_SERVICE_URL: "  " })).toEqual({
      serviceUrl: defaultServiceUrl,
    });
    expect(
      readMcpSettings({ AMEM_MCP_SERVICE_URL: "http://127.0.0.1:5000" }),
    ).toEqual({ serviceUrl: "http://127.0.0.1:5000" });
  });

  it("serves the memory tools over stdio against the running service", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = await startHost({ baseUrl: harness.baseUrl });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_save",
    ]);

    const saved = await client.callTool({
      name: "memory_save",
      arguments: {
        sourceKey: "amem-15/launched-host",
        content: "A host process saved this observation over stdio.",
      },
    });
    expect(saved.isError).not.toBe(true);
    expect(saved.structuredContent).toMatchObject({
      sourceKey: "amem-15/launched-host",
      created: true,
    });
    await waitFor(
      () => harness.providers.store.records.size === 1,
      "the launched host's observation to be stored",
    );

    const searched = await client.callTool({
      name: "memory_search",
      arguments: { query: "observation over stdio", limit: 3 },
    });
    expect(searched.isError).not.toBe(true);
    const results = (
      searched.structuredContent as { results: Array<{ via: string }> }
    ).results;
    expect(results).toHaveLength(1);
    expect(results[0]?.via).toBe("match");
  });

  it("keeps stdout to protocol messages and exits when the host closes stdin", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const child = spawn(process.execPath, launchArguments, {
      cwd: repositoryRoot,
      env: { ...process.env, AMEM_MCP_SERVICE_URL: harness.baseUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const lines: string[] = [];
    const pending = new Map<number, (frame: Record<string, unknown>) => void>();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        lines.push(line);
        const frame = JSON.parse(line) as { id?: number };
        const settle =
          frame.id === undefined ? undefined : pending.get(frame.id);
        if (frame.id !== undefined && settle !== undefined) {
          pending.delete(frame.id);
          settle(frame);
        }
      }
    });
    const request = (
      id: number,
      method: string,
      params: unknown,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    const notify = (method: string, params: unknown): void => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      );
    };

    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw-host", version: "0.0.0" },
    });
    expect(initialized.result).toMatchObject({
      serverInfo: { name: "amem-memory" },
    });
    notify("notifications/initialized", {});
    const listed = await request(2, "tools/list", {});
    expect(
      (listed.result as { tools: Array<{ name: string }> }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["memory_search", "memory_save"]);
    const called = await request(3, "tools/call", {
      name: "memory_save",
      arguments: {
        sourceKey: "amem-15/raw-protocol",
        content: "Saved through the raw JSON-RPC session.",
      },
    });
    const callResult = called.result as {
      structuredContent: { id: string; status: string };
      content: Array<{ type: string; text: string }>;
    };
    expect(callResult.structuredContent).toMatchObject({
      sourceKey: "amem-15/raw-protocol",
      created: true,
    });
    expect(JSON.parse(callResult.content[0]?.text ?? "")).toEqual(
      callResult.structuredContent,
    );

    // Every stdout line is one complete JSON-RPC 2.0 message; no log line may reach stdout.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }

    child.stdin.end();
    expect(await waitForExit(child)).toBe(0);
    await waitFor(
      () => harness.providers.store.records.size === 1,
      "the raw session's observation to be stored",
    );
  });

  it("serves several MCP clients from one service queue and encoder", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const first = await startHost({ baseUrl: harness.baseUrl });
    const second = await startHost({ baseUrl: harness.baseUrl });

    const saved = await Promise.all([
      first.callTool({
        name: "memory_save",
        arguments: {
          sourceKey: "amem-15/first-host",
          content: "The first host saved one observation.",
        },
      }),
      second.callTool({
        name: "memory_save",
        arguments: {
          sourceKey: "amem-15/second-host",
          content: "The second host saved one observation.",
        },
      }),
    ]);
    for (const result of saved) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ created: true });
    }

    await waitFor(
      () => harness.providers.store.records.size === 2,
      "both hosts' observations to be stored",
    );
    expect(harness.providers.embedderOpens).toBe(1);
    expect(harness.providers.storeOpens).toBe(1);
    const status = await createMemoryServiceClient({
      url: harness.baseUrl,
    }).status();
    expect(status.queue?.accepted).toBe(2);
  });

  it("serves a session without loading the embedding runtime", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const directory = await mkdtemp(path.join(tmpdir(), "amem-mcp-loads-"));
    try {
      const log = path.join(directory, "loads.txt");
      const client = await startHost({
        baseUrl: harness.baseUrl,
        args: ["--import", "tsx", "--import", loadLogFixture, "mcp/main.ts"],
        environment: { AMEM_LOAD_LOG: log },
      });
      const searched = await client.callTool({
        name: "memory_search",
        arguments: { query: "anything" },
      });
      expect(searched.isError).not.toBe(true);
      await closeSession(client);

      const loaded = (await readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line !== "");
      expect(loaded.some((url) => url.endsWith("mcp/tools.ts"))).toBe(true);
      expect(
        loaded.filter((url) =>
          /src\/embeddings\/|@huggingface\/transformers|onnxruntime/.test(url),
        ),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails startup without writing to stdout when the service URL is invalid", async () => {
    const child = spawn(process.execPath, launchArguments, {
      cwd: repositoryRoot,
      env: { ...process.env, AMEM_MCP_SERVICE_URL: "not a URL" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    expect(await waitForExit(child)).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("could not start");
    expect(stderr).toContain("URL");
  });
});
