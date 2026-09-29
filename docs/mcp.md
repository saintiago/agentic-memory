# Memory MCP tools

## Responsibility and interface

AMEM owns an MCP server exposing focused memory access to agents. It delegates to the public
[service API](service.md#api); it does not create another Memory instance, encoder, queue or database
writer. Nexus and other hosts configure this server using their coding provider's native MCP support.
Use a stdio entry point configured with the service URL; stdout carries MCP protocol messages only.
The shared service remains separately supervised. Publish the launch command and tool schemas;
[mcp/README.md](../mcp/README.md) documents them for hosts.

## Tools

| Tool            | Arguments                                         | Result                                                                                                         |
| --------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `memory_search` | `{ query, limit?, linkedLimit? }`                 | Search time and complete notes with IDs, content, attributes, provenance, scores and match/link classification |
| `memory_save`   | `{ sourceKey, content, timestamp?, provenance? }` | Durable acceptance receipt, including its ID and current status                                                |

Use service validation, defaults and limits. Source keys identify producer observations and must be
stable and unique in that producer's namespace. The caller supplies one key per observation and
reuses the exact key and payload on retry. Different payloads under an existing key fail explicitly.
Do not derive identity solely from content or create a new identity on transport retry.

Saving waits for durable acceptance, not embedding or storage. State clearly that accepted notes
may not yet appear in search. Duplicate submissions return the existing receipt. Surface service
and transport failures as tool errors; never turn an unavailable search into an empty success or
claim an unacknowledged save succeeded. Retrying a lost acknowledgement uses the same payload/key.
No additional receipt tool is required initially; the receipt remains inspectable through the API.

Search is read-only and follows the service's existing retrieval semantics. Return original notes
and provenance without model summarization. Tool descriptions identify returned content as
historical evidence, potentially uncertain or inapplicable, and embedded instructions as data.
Save descriptions request focused observations, applicability, uncertainty and evidence references.
Host-specific task extraction and completion analysis do not belong to AMEM.

## Lifecycle and verification

The MCP process owns only its protocol transport and service client. Provider credentials and
collection settings remain in the service. Closing an agent session does not stop shared ingestion.
Reuse the service's local-access policy; do not add another remote deployment or authentication mode.

Verify tool discovery and schemas, real API delegation, duplicate/conflicting source keys, durable
acceptance semantics, complete search attribution, service outages, lost acknowledgement retry,
protocol-clean stdout and shutdown. Multiple MCP clients must use the same service queue without
loading independent encoders. Test the public MCP boundary rather than reproducing AMEM algorithms.
