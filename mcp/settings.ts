/**
 * Explicit host settings of the AMEM memory MCP server. The only setting is the URL of the shared
 * memory service: credentials, collection identity and provider settings stay in the service, and
 * the client boundary validates the URL when it is created.
 *
 * See docs/mcp.md#responsibility-and-interface and mcp/README.md.
 */

/** The documented loopback address of the default local memory service. */
export const defaultServiceUrl = "http://127.0.0.1:4748";

/** Everything the MCP server needs to reach the shared service. */
export interface McpSettings {
  /** The service base URL; the MCP server owns no other service configuration. */
  readonly serviceUrl: string;
}

/** Read the MCP host settings; an absent or blank URL selects the documented local service. */
export const readMcpSettings = (
  env: Readonly<Record<string, string | undefined>>,
): McpSettings => {
  const configured = env.AMEM_MCP_SERVICE_URL?.trim();
  return {
    serviceUrl:
      configured === undefined || configured === ""
        ? defaultServiceUrl
        : configured,
  };
};
