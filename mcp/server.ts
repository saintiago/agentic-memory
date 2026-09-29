/**
 * Composition of the AMEM memory MCP server: one MCP server over the shared memory service
 * client. It owns only the protocol surface and the client; it creates no Memory instance,
 * encoder, queue or database writer, and it starts without requiring the service to be up.
 *
 * See docs/mcp.md#responsibility-and-interface.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import packageJson from "../package.json" with { type: "json" };
import type { MemoryServiceClient } from "../service/client.js";
import { registerMemoryTools } from "./tools.js";

/** The implementation identity every MCP host sees for this server. */
export const memoryMcpServerInfo = {
  name: "amem-memory",
  version: packageJson.version,
} as const;

/** Create the MCP server exposing the memory tools of one supplied service client. */
export const createMemoryMcpServer = (
  client: MemoryServiceClient,
): McpServer => {
  const server = new McpServer(memoryMcpServerInfo);
  registerMemoryTools(server, client);
  return server;
};
