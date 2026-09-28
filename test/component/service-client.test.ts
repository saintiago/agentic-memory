import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  ServiceClientError,
  createMemoryServiceClient,
} from "../../service/client.js";
import {
  postJson,
  record,
  startServiceHarness,
  uuid,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Component tests for the service client boundary: successful typed round trips, opaque cursors,
 * missing records as `undefined` and typed failures for invalid input, conflicts,
 * unavailability and unreadable responses.
 *
 * See docs/service.md#api.
 */

const harnesses: ServiceHarness[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

describe("memory service client", () => {
  it("submits durably and resolves a resubmission to the same receipt", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = createMemoryServiceClient({ url: harness.baseUrl });
    const observation = {
      sourceKey: "client-source",
      content: "An observation submitted through the client.",
    };
    const first = await client.submit(observation);
    expect(first.created).toBe(true);
    const second = await client.submit(observation);
    expect(second.created).toBe(false);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect((await client.receipt(first.receipt.id))?.sourceKey).toBe(
      "client-source",
    );
    expect(await client.receipt(uuid(9_999))).toBeUndefined();
  });

  it("round-trips search, notes, inspection pages and status with opaque cursors", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    harness.providers.store.seed(record(1), record(2), record(3));
    const client = createMemoryServiceClient({ url: harness.baseUrl });

    const search = await client.search("source material", { limit: 2 });
    expect(search.results.map((result) => result.note.id)).toEqual([
      uuid(1),
      uuid(2),
    ]);
    expect(search.results[0]?.via).toBe("match");

    const note = await client.note(uuid(3));
    expect(note?.id).toBe(uuid(3));
    expect(await client.note(uuid(4_000))).toBeUndefined();

    const firstPage = await client.notes(2);
    expect(firstPage.notes).toHaveLength(2);
    expect(firstPage.cursor).toBeDefined();
    // The caller returns the opaque token unchanged.
    const secondPage = await client.notes(2, firstPage.cursor);
    expect(secondPage.notes.map((entry) => entry.id)).toEqual([uuid(3)]);
    expect(secondPage.cursor).toBeUndefined();

    const inspection = await client.inspectionRecords(1);
    expect(inspection.embeddingSpaceId).toBeDefined();
    expect(inspection.records[0]?.vector).toEqual(record(1).vector);
    const next = await client.inspectionRecords(1, inspection.cursor);
    expect(next.records[0]?.note.id).toBe(uuid(2));

    const status = await client.status();
    expect(status.collection).toBe("service-tests");
    expect(status.availability.retrieval).toBe(true);
    expect(status.queue?.accepted).toBe(0);
  });

  it("reports typed failures for invalid input, conflicts and unavailability", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = createMemoryServiceClient({ url: harness.baseUrl });
    await client.submit({ sourceKey: "taken", content: "First." });

    const conflict = await client
      .submit({ sourceKey: "taken", content: "Different." })
      .catch((cause: unknown) => cause);
    expect(conflict).toBeInstanceOf(ServiceClientError);
    expect((conflict as ServiceClientError).status).toBe(409);
    expect((conflict as ServiceClientError).code).toBe("conflict");
    expect((conflict as ServiceClientError).retryable).toBe(false);

    const invalid = await client.search("   ").catch((cause: unknown) => cause);
    expect(invalid).toBeInstanceOf(ServiceClientError);
    expect((invalid as ServiceClientError).status).toBe(400);
    expect((invalid as ServiceClientError).retryable).toBe(false);

    harness.providers.store.nearestError = new Error("store down");
    const unavailable = await client
      .search("a query")
      .catch((cause: unknown) => cause);
    expect(unavailable).toBeInstanceOf(ServiceClientError);
    expect((unavailable as ServiceClientError).status).toBe(503);
    expect((unavailable as ServiceClientError).retryable).toBe(true);
  });

  it("reports an unreachable service and an unreadable response", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const port = harness.runtime.port;
    await harness.runtime.stop();
    const unreachable = createMemoryServiceClient({
      url: `http://127.0.0.1:${String(port)}`,
      timeoutMs: 500,
    });
    const failure = await unreachable.status().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ServiceClientError);
    expect((failure as ServiceClientError).code).toBe("unreachable");
    expect((failure as ServiceClientError).retryable).toBe(true);

    const stub = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"collection": 42}');
    });
    servers.push(stub);
    await new Promise<void>((resolve) => {
      stub.listen(0, "127.0.0.1", resolve);
    });
    const address = stub.address();
    const stubPort =
      typeof address === "object" && address !== null ? address.port : 0;
    const misled = createMemoryServiceClient({
      url: `http://127.0.0.1:${String(stubPort)}`,
    });
    const invalid = await misled.status().catch((cause: unknown) => cause);
    expect(invalid).toBeInstanceOf(ServiceClientError);
    expect((invalid as ServiceClientError).code).toBe("invalid-response");
  });

  it("waits for stored evidence through the client after a real submission", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    const client = createMemoryServiceClient({ url: harness.baseUrl });
    const submission = await client.submit({
      sourceKey: "client-e2e",
      content: "An observation stored for the client.",
    });
    await waitFor(async () => {
      const receipt = await client.receipt(submission.receipt.id);
      return receipt?.status === "stored";
    }, "the observation to be stored");
    const receipt = await client.receipt(submission.receipt.id);
    expect(receipt?.noteId).toBeDefined();
    const note = await client.note(receipt?.noteId ?? "");
    expect(note?.content).toBe("An observation stored for the client.");

    // The API's own text stays sanitized for the client too.
    const oversized = await postJson(harness.url("/v1/observations"), {
      sourceKey: "too-big",
      content: "x".repeat(1_100_000),
    });
    expect(oversized.status).toBe(413);
  });
});
