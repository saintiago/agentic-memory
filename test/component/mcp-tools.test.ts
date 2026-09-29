/**
 * Component tests of the AMEM memory MCP boundary: one real MCP session over the shared service
 * client against a real service with controlled providers. They cover tool discovery and
 * published schemas, real API delegation with complete search attribution, source-key identity,
 * durable acceptance before storage, service and retrieval outages and a lost acknowledgement.
 *
 * See docs/mcp.md#lifecycle-and-verification.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryMcpServer } from "../../mcp/server.js";
import {
  createMemoryServiceClient,
  type MemoryServiceClientOptions,
} from "../../service/client.js";
import type { JsonValue } from "../../src/note-store/index.js";
import {
  note,
  record,
  referenceVector,
  startServiceHarness,
  uuid,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

interface Session {
  readonly client: Client;
  close(): Promise<void>;
}

const sessions: Session[] = [];
const harnesses: ServiceHarness[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

/** Start one real MCP session over the in-memory transport, backed by the service at `baseUrl`. */
const openSession = async (
  baseUrl: string,
  options: Partial<MemoryServiceClientOptions> = {},
): Promise<Client> => {
  const service = createMemoryServiceClient({ url: baseUrl, ...options });
  const server = createMemoryMcpServer(service);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "amem-mcp-test-host", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  sessions.push({
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  });
  return client;
};

/** The text of one tool result; every result of this server carries a text document. */
const toolText = (result: object): string => {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error("The tool result carries no text content.");
  }
  return (content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? "")
    .join("");
};

/** A client whose first submission reaches the service but loses its acknowledgement body. */
const truncatingFetch = (): typeof globalThis.fetch => {
  let truncated = false;
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (truncated || !String(input).endsWith("/v1/observations")) {
      return response;
    }
    truncated = true;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        controller.error(new Error("The connection was lost."));
      },
    });
    return new Response(body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
};

/** A client whose first submission is answered with `status` and `body` instead of the service's. */
const replacingFetch = (
  status: number,
  body: string,
): typeof globalThis.fetch => {
  let replaced = false;
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (replaced || !String(input).endsWith("/v1/observations")) {
      return response;
    }
    replaced = true;
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
};

/** A client whose first submission is refused with `status` and `body` before reaching the service. */
const refusingFetch = (
  status: number,
  body: string,
): typeof globalThis.fetch => {
  let refused = false;
  return async (input, init) => {
    if (refused || !String(input).endsWith("/v1/observations")) {
      return await globalThis.fetch(input, init);
    }
    refused = true;
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
};

describe("AMEM memory MCP tools", () => {
  it("publishes the two memory tools with the service's request contract", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = await openSession(harness.baseUrl);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_save",
    ]);

    const search = tools.find((tool) => tool.name === "memory_search");
    expect(search?.description).toContain("historical evidence");
    expect(search?.description).toContain("never commands");
    expect(search?.annotations?.readOnlyHint).toBe(true);
    expect(search?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        linkedLimit: { type: "integer" },
      },
    });
    expect(search?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["searchedAt", "results"],
    });

    const save = tools.find((tool) => tool.name === "memory_save");
    expect(save?.description).toContain("applicability");
    expect(save?.description).toContain("uncertainty");
    expect(save?.description).toContain("evidence references");
    expect(save?.annotations?.destructiveHint).toBe(false);
    expect(save?.annotations?.idempotentHint).toBe(true);
    expect(save?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["sourceKey", "content"],
      properties: {
        sourceKey: { type: "string" },
        content: { type: "string" },
        timestamp: { type: "string" },
        // The service's own provenance contract preserves every own key of the submitted JSON,
        // which JSON Schema cannot describe; the published property carries its description.
        provenance: { description: expect.stringContaining("JSON object") },
      },
    });
    expect(save?.outputSchema).toMatchObject({
      type: "object",
      required: [
        "id",
        "sourceKey",
        "status",
        "acceptedAt",
        "updatedAt",
        "attemptCount",
        "created",
      ],
    });
  });

  it("returns the service's complete attributed search results", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const linked = uuid(9);
    harness.providers.store.seed(
      record(1, [linked]),
      {
        note: {
          ...note(9),
          metadata: { task: "AMEM-15", origin: "component test" },
        },
        vector: referenceVector(9),
      },
      record(2),
    );
    const client = await openSession(harness.baseUrl);

    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "source material", limit: 1, linkedLimit: 1 },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      searchedAt: string;
      results: Array<Record<string, unknown>>;
    };
    expect(typeof structured.searchedAt).toBe("string");
    expect(structured.results).toHaveLength(2);
    expect(structured.results[0]).toMatchObject({
      via: "match",
      note: {
        id: uuid(1),
        content: "Source material 1.",
        context: "Records source material 1.",
        keywords: ["source"],
        tags: ["observation"],
      },
      score: expect.any(Number),
    });
    expect(structured.results[1]).toMatchObject({
      via: "link",
      note: {
        id: linked,
        content: "Source material 9.",
        metadata: { task: "AMEM-15", origin: "component test" },
      },
    });
    expect(structured.results[1]).not.toHaveProperty("score");
    // The text block is the same complete document, so a host that reads only text loses nothing.
    expect(JSON.parse(toolText(result))).toEqual(structured);
  });

  it("passes retrieval limits through and keeps the service's defaults", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    harness.providers.store.seed(
      ...Array.from({ length: 7 }, (_, index) => record(index + 1)),
    );
    const client = await openSession(harness.baseUrl);

    const defaults = await client.callTool({
      name: "memory_search",
      arguments: { query: "source material" },
    });
    // Memory's documented default is five direct matches and at most five linked additions.
    expect(
      (defaults.structuredContent as { results: unknown[] }).results,
    ).toHaveLength(5);

    const limited = await client.callTool({
      name: "memory_search",
      arguments: { query: "source material", limit: 2, linkedLimit: 0 },
    });
    expect(
      (limited.structuredContent as { results: unknown[] }).results,
    ).toHaveLength(2);
  });

  it("returns stored provenance with its special own keys intact", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const metadata = JSON.parse(
      '{"__proto__":{"marker":"stored"},"task":"AMEM-15"}',
    ) as Record<string, JsonValue>;
    harness.providers.store.seed({
      note: { ...note(3), metadata },
      vector: referenceVector(3),
    });
    const client = await openSession(harness.baseUrl);

    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "source material", limit: 1 },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      results: Array<{ note: { metadata?: Record<string, unknown> } }>;
    };
    expect(JSON.stringify(structured.results[0]?.note.metadata)).toBe(
      JSON.stringify(metadata),
    );
    // The text block is the same complete document, key for key.
    expect(JSON.parse(toolText(result))).toEqual(structured);
  });

  it("accepts an observation durably before storage and returns the existing receipt", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const held = harness.providers.model.holdGenerate();
    const client = await openSession(harness.baseUrl);
    const observation = {
      sourceKey: "amem-15/observation-1",
      content: "The service accepts observations durably before embedding.",
      provenance: { task: "AMEM-15" },
    };

    const first = await client.callTool({
      name: "memory_save",
      arguments: observation,
    });
    expect(first.isError).not.toBe(true);
    const receipt = first.structuredContent as Record<string, unknown>;
    expect(receipt).toMatchObject({
      sourceKey: observation.sourceKey,
      created: true,
    });
    expect(typeof receipt.id).toBe("string");
    expect(["queued", "processing"]).toContain(receipt.status);
    expect(receipt.noteId).toBeUndefined();
    // The receipt is durable acceptance: nothing is embedded or stored yet.
    expect(harness.providers.store.records.size).toBe(0);

    const duplicate = await client.callTool({
      name: "memory_save",
      arguments: { ...observation, provenance: { task: "AMEM-15" } },
    });
    expect(duplicate.isError).not.toBe(true);
    expect(duplicate.structuredContent).toMatchObject({
      id: receipt.id,
      created: false,
    });

    held.resolve();
    await waitFor(
      () => harness.providers.store.records.size === 1,
      "the accepted observation to be stored",
    );
    const stored = await createMemoryServiceClient({
      url: harness.baseUrl,
    }).receipt(receipt.id as string);
    expect(stored?.status).toBe("stored");
    expect(stored?.noteId).toBeDefined();
  });

  it("rejects a different payload under an existing source key as a tool error", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = await openSession(harness.baseUrl);

    const first = await client.callTool({
      name: "memory_save",
      arguments: {
        sourceKey: "amem-15/conflict",
        content: "The first observation under this key.",
      },
    });
    expect(first.isError).not.toBe(true);

    const conflict = await client.callTool({
      name: "memory_save",
      arguments: {
        sourceKey: "amem-15/conflict",
        content: "A different observation under the same key.",
      },
    });
    expect(conflict.isError).toBe(true);
    expect(toolText(conflict)).toContain("source key");
    expect(toolText(conflict)).toContain("conflict");
    // A rejected submission was never accepted, so the caller must change it instead of retrying
    // the identical call as if its acceptance were unresolved.
    expect(toolText(conflict)).toContain("It was not accepted");
    expect(toolText(conflict)).not.toContain("may already be durably accepted");

    await waitFor(
      () => harness.providers.store.records.size === 1,
      "the first observation to be stored",
    );
    expect(harness.providers.store.records.size).toBe(1);
  });

  it("preserves the complete submitted provenance, including special own keys", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = await openSession(harness.baseUrl);
    // Own `__proto__` properties are valid JSON keys; they must cross this boundary unchanged.
    const provenance = JSON.parse(
      '{"task":"AMEM-15","__proto__":{"marker":"top-level"},' +
        '"evidence":{"__proto__":"nested","file":"mcp/tools.ts"}}',
    ) as Record<string, unknown>;
    const observation = {
      sourceKey: "amem-15/provenance-keys",
      content: "Provenance keeps every own key of the submitted JSON.",
      provenance,
    };

    const saved = await client.callTool({
      name: "memory_save",
      arguments: observation,
    });
    expect(saved.isError).not.toBe(true);
    const receipt = saved.structuredContent as Record<string, unknown>;
    expect(receipt).toMatchObject({ created: true });
    await waitFor(
      () => harness.providers.store.records.size === 1,
      "the observation to be stored with its provenance",
    );
    const stored = [...harness.providers.store.records.values()][0]?.note;
    expect(JSON.stringify(stored?.metadata)).toBe(JSON.stringify(provenance));

    // The same payload submitted through the service itself resolves the same receipt, so the two
    // interfaces agree on the observation's identity instead of conflicting.
    const direct = await createMemoryServiceClient({
      url: harness.baseUrl,
    }).submit({
      sourceKey: observation.sourceKey,
      content: observation.content,
      provenance: JSON.parse(JSON.stringify(provenance)) as Record<
        string,
        JsonValue
      >,
    });
    expect(direct.created).toBe(false);
    expect(direct.receipt.id).toBe(receipt.id);

    // The identical retry carries the exact payload the service accepted, so it resolves the
    // existing receipt rather than conflicting.
    const duplicate = await client.callTool({
      name: "memory_save",
      arguments: observation,
    });
    expect(duplicate.isError).not.toBe(true);
    expect(duplicate.structuredContent).toMatchObject({
      id: receipt.id,
      created: false,
    });

    // Changing only a key that a lossy boundary would drop is a genuine conflict.
    const changed = await client.callTool({
      name: "memory_save",
      arguments: {
        ...observation,
        provenance: JSON.parse(
          '{"task":"AMEM-15","__proto__":{"marker":"changed"},' +
            '"evidence":{"__proto__":"nested","file":"mcp/tools.ts"}}',
        ) as Record<string, unknown>,
      },
    });
    expect(changed.isError).toBe(true);
    expect(toolText(changed)).toContain("conflict");
    expect(harness.providers.store.records.size).toBe(1);
  });

  it("reports an unavailable service as a tool error, never as an empty search", async () => {
    const harness = await startServiceHarness();
    const url = harness.baseUrl;
    await harness.close();
    const client = await openSession(url);

    const search = await client.callTool({
      name: "memory_search",
      arguments: { query: "anything" },
    });
    expect(search.isError).toBe(true);
    expect(toolText(search)).toContain("unreachable");
    expect(toolText(search)).toContain("No search results were returned");

    const save = await client.callTool({
      name: "memory_save",
      arguments: {
        sourceKey: "amem-15/outage",
        content: "An observation submitted during an outage.",
      },
    });
    expect(save.isError).toBe(true);
    expect(toolText(save)).toContain("not acknowledged");
    expect(toolText(save)).toContain("retry the identical sourceKey");
  });

  it("reports a retrieval outage and recovers without inventing results", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = await openSession(harness.baseUrl);

    harness.providers.store.nearestError = new Error("The store is offline.");
    const failed = await client.callTool({
      name: "memory_search",
      arguments: { query: "source material" },
    });
    expect(failed.isError).toBe(true);
    expect(toolText(failed)).toContain("unavailable");
    expect(toolText(failed)).toContain("No search results were returned");

    harness.providers.store.nearestError = undefined;
    const recovered = await client.callTool({
      name: "memory_search",
      arguments: { query: "source material" },
    });
    expect(recovered.isError).not.toBe(true);
    expect(
      (recovered.structuredContent as { results: unknown[] }).results,
    ).toEqual([]);
  });

  it("resolves a lost acknowledgement by retrying the identical source key and payload", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = await openSession(harness.baseUrl, {
      fetch: truncatingFetch(),
    });
    const observation = {
      sourceKey: "amem-15/lost-acknowledgement",
      content: "An observation whose first acknowledgement is lost.",
    };

    const lost = await client.callTool({
      name: "memory_save",
      arguments: observation,
    });
    expect(lost.isError).toBe(true);
    expect(toolText(lost)).toContain("retry the identical sourceKey");

    const retried = await client.callTool({
      name: "memory_save",
      arguments: observation,
    });
    expect(retried.isError).not.toBe(true);
    expect(retried.structuredContent).toMatchObject({
      sourceKey: observation.sourceKey,
      created: false,
    });

    await waitFor(
      () => harness.providers.store.records.size === 1,
      "the retried observation to be stored once",
    );
    expect(harness.providers.store.records.size).toBe(1);
  });

  it("keeps identical-payload recovery guidance when a success answer is unusable", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const observation = {
      sourceKey: "amem-15/unusable-answer",
      content: "An observation whose durable acceptance is answered unusably.",
    };

    // A fully received answer that is not JSON and one outside the receipt contract both leave
    // acceptance unknown: the service accepted the observation before the answer was replaced.
    for (const answer of [
      { status: 202, body: '{"id":' },
      { status: 200, body: '{"id":"not-a-receipt"}' },
    ]) {
      const client = await openSession(harness.baseUrl, {
        fetch: replacingFetch(answer.status, answer.body),
      });
      const failed = await client.callTool({
        name: "memory_save",
        arguments: observation,
      });
      expect(failed.isError).toBe(true);
      expect(toolText(failed)).toContain("invalid-response");
      expect(toolText(failed)).toContain("retry the identical sourceKey");
      expect(toolText(failed)).not.toContain("correct it before resubmitting");
    }

    // The identical retry resolves the receipt the service already held.
    const recovery = await openSession(harness.baseUrl);
    const retried = await recovery.callTool({
      name: "memory_save",
      arguments: observation,
    });
    expect(retried.isError).not.toBe(true);
    expect(retried.structuredContent).toMatchObject({
      sourceKey: observation.sourceKey,
      created: false,
    });
    await waitFor(
      () => harness.providers.store.records.size === 1,
      "the accepted observation to be stored once",
    );
    expect(harness.providers.store.records.size).toBe(1);
  });

  it("retries the identical payload after a refusal the service marks retryable", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = await openSession(harness.baseUrl, {
      fetch: refusingFetch(
        429,
        '{"error":{"code":"overloaded","message":"The memory service is temporarily ' +
          'overloaded; retry later.","retryable":true}}',
      ),
    });
    const observation = {
      sourceKey: "amem-15/retryable-refusal",
      content: "An observation the service refused without accepting it.",
    };

    // A refusal decided before acceptance leaves nothing behind, so the identical key and payload
    // are still the caller's observation and must not be treated as an uncertain acceptance.
    const refused = await client.callTool({
      name: "memory_save",
      arguments: observation,
    });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain("overloaded");
    expect(toolText(refused)).toContain("retry the identical sourceKey");
    expect(toolText(refused)).not.toContain("correct it before resubmitting");
    expect(toolText(refused)).not.toContain("may already be durably accepted");

    const accepted = await client.callTool({
      name: "memory_save",
      arguments: observation,
    });
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent).toMatchObject({ created: true });
  });
});
