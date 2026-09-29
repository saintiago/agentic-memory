/**
 * Entry point of the AMEM memory MCP server: one stdio protocol session over the shared service
 * client, configured only with the service URL. The host launches it through its coding
 * provider's native MCP support; stdout carries MCP protocol messages only and every diagnostic
 * goes to stderr. The process stops on SIGINT or SIGTERM and whenever the host closes stdin, and
 * closing an agent session does not stop the separately supervised service or its ingestion.
 *
 * Run it with `npm run --silent mcp` from the repository root; see mcp/README.md and docs/mcp.md.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMemoryServiceClient } from "../service/client.js";
import { createMemoryMcpServer } from "./server.js";
import { readMcpSettings } from "./settings.js";

const start = async (): Promise<void> => {
  const settings = readMcpSettings(process.env);
  const client = createMemoryServiceClient({ url: settings.serviceUrl });
  const server = createMemoryMcpServer(client);
  await server.connect(new StdioServerTransport());
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await server.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
  // The stdio transport does not report a closed parent, so the session ends with stdin.
  process.stdin.on("end", () => {
    void stop();
  });
  console.error(
    `The AMEM memory MCP server for ${settings.serviceUrl} is serving stdio.`,
  );
};

await start().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`The AMEM memory MCP server could not start: ${message}`);
  process.exit(1);
});
