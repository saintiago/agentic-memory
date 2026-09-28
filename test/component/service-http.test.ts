import { afterEach, describe, expect, it } from "vitest";

import { referenceEmbeddingSpace } from "../../src/index.js";
import {
  postJson,
  record,
  requestJson,
  startServiceHarness,
  uuid,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Component tests for the documented `/v1` HTTP contract of the local memory service: every
 * route, request validation, duplicate and conflicting submissions, pagination and error
 * classification, exercised over a real loopback server with controlled providers.
 *
 * See docs/service.md#api and docs/testing.md#choosing-scope.
 */

const harnesses: ServiceHarness[] = [];

const openService = async (): Promise<ServiceHarness> => {
  const harness = await startServiceHarness();
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

const receiptOf = (
  harness: ServiceHarness,
  id: string,
): Promise<Awaited<ReturnType<typeof requestJson>>> =>
  requestJson(harness.url(`/v1/receipts/${id}`));

describe("submission route", () => {
  it("accepts a new observation with 202, Location and a durable receipt", async () => {
    const harness = await openService();
    const response = await postJson(harness.url("/v1/observations"), {
      sourceKey: "task-1/observation-1",
      content: "An observation that must be retained.",
    });

    expect(response.status).toBe(202);
    const receipt = response.body as Record<string, unknown>;
    expect(receipt.sourceKey).toBe("task-1/observation-1");
    expect(receipt.attemptCount).toBe(0);
    expect(typeof receipt.id).toBe("string");
    expect(response.headers.get("location")).toBe(
      `/v1/receipts/${String(receipt.id)}`,
    );

    const looked = await receiptOf(harness, String(receipt.id));
    expect(looked.status).toBe(200);
    expect((looked.body as { id: string }).id).toBe(receipt.id);

    const status = await requestJson(harness.url("/v1/status"));
    const queue = (status.body as { queue: { accepted: number } }).queue;
    expect(queue.accepted).toBe(1);
  });

  it("returns the existing receipt for an identical resubmission and refuses changed input", async () => {
    const harness = await openService();
    const observation = {
      sourceKey: "stable-key",
      content: "The observation.",
      provenance: { host: "cli", task: "AMEM-13" },
    };
    const accepted = await postJson(
      harness.url("/v1/observations"),
      observation,
    );
    expect(accepted.status).toBe(202);

    const resubmitted = await postJson(
      harness.url("/v1/observations"),
      observation,
    );
    expect(resubmitted.status).toBe(200);
    expect((resubmitted.body as { id: string }).id).toBe(
      (accepted.body as { id: string }).id,
    );

    const changed = await postJson(harness.url("/v1/observations"), {
      sourceKey: "stable-key",
      content: "Different source material.",
    });
    expect(changed.status).toBe(409);
    expect(changed.body).toEqual({
      error: {
        code: "conflict",
        message:
          'The source key "stable-key" already holds a different observation.',
        retryable: false,
      },
    });

    const invalid = await postJson(harness.url("/v1/observations"), {
      sourceKey: "another-key",
      content: "   ",
    });
    expect(invalid.status).toBe(400);
    expect(
      (invalid.body as { error: { retryable: boolean } }).error.retryable,
    ).toBe(false);
  });

  it("refuses oversized bodies, non-JSON content and untrusted origins", async () => {
    const harness = await openService();
    const observation = {
      sourceKey: "size",
      content: "x".repeat(1_048_576),
    };
    const oversized = await postJson(
      harness.url("/v1/observations"),
      observation,
    );
    expect(oversized.status).toBe(413);
    expect((oversized.body as { error: { code: string } }).error.code).toBe(
      "payload-too-large",
    );

    const wrongType = await requestJson(harness.url("/v1/observations"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ sourceKey: "k", content: "c" }),
    });
    expect(wrongType.status).toBe(400);

    const foreignOrigin = await requestJson(harness.url("/v1/observations"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example",
      },
      body: JSON.stringify({ sourceKey: "k", content: "c" }),
    });
    expect(foreignOrigin.status).toBe(400);

    const sameOrigin = await requestJson(harness.url("/v1/observations"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: harness.baseUrl,
      },
      body: JSON.stringify({ sourceKey: "k", content: "c" }),
    });
    expect(sameOrigin.status).toBe(202);
  });

  it("reports unknown routes and wrong methods distinctly", async () => {
    const harness = await openService();
    const wrongMethod = await requestJson(harness.url("/v1/observations"));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const unknown = await requestJson(harness.url("/v1/unknown"));
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error: { code: string } }).error.code).toBe(
      "not-found",
    );
  });
});

describe("receipt route", () => {
  it("reads a receipt and reports missing and malformed identities", async () => {
    const harness = await openService();
    const missing = await requestJson(
      harness.url(`/v1/receipts/${uuid(9_999)}`),
    );
    expect(missing.status).toBe(404);
    expect(
      (missing.body as { error: { retryable: boolean } }).error.retryable,
    ).toBe(false);

    const malformed = await requestJson(harness.url("/v1/receipts/not-a-uuid"));
    expect(malformed.status).toBe(400);
  });
});

describe("search route", () => {
  it("returns complete ordered results with match and link classifications", async () => {
    const harness = await openService();
    harness.providers.store.seed(
      record(1, [uuid(2)]),
      record(2, [uuid(3)]),
      record(3),
    );
    const response = await postJson(harness.url("/v1/search"), {
      query: "source material",
      limit: 2,
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      searchedAt: string;
      results: Array<{ note: { id: string }; via: string; score?: number }>;
    };
    expect(new Date(body.searchedAt).toISOString()).toBe(body.searchedAt);
    expect(body.results.map((result) => result.note.id)).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
    ]);
    expect(body.results.map((result) => result.via)).toEqual([
      "match",
      "match",
      "link",
    ]);
    expect(body.results[0]?.score).toBe(1);
    expect(body.results[2]?.score).toBeUndefined();
  });

  it("answers an empty collection with an empty successful result", async () => {
    const harness = await openService();
    const response = await postJson(harness.url("/v1/search"), {
      query: "nothing stored",
    });
    expect(response.status).toBe(200);
    expect((response.body as { results: unknown[] }).results).toEqual([]);
  });

  it("reports validation and provider failures instead of empty success", async () => {
    const harness = await openService();
    const invalid = await postJson(harness.url("/v1/search"), { query: "   " });
    expect(invalid.status).toBe(400);

    harness.providers.store.nearestError = new Error(
      "provider detail that must stay private",
    );
    const failed = await postJson(harness.url("/v1/search"), {
      query: "a query",
    });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({
      error: {
        code: "unavailable",
        message: "The memory capability is unavailable.",
        retryable: true,
      },
    });
  });
});

describe("note routes", () => {
  it("reads a note and reports missing and malformed identities", async () => {
    const harness = await openService();
    harness.providers.store.seed(record(1));
    const found = await requestJson(harness.url(`/v1/notes/${uuid(1)}`));
    expect(found.status).toBe(200);
    expect((found.body as { id: string }).id).toBe(uuid(1));

    const missing = await requestJson(harness.url(`/v1/notes/${uuid(1_000)}`));
    expect(missing.status).toBe(404);

    const malformed = await requestJson(harness.url("/v1/notes/not-a-uuid"));
    expect(malformed.status).toBe(400);
  });

  it("paginates notes with an opaque cursor exactly once", async () => {
    const harness = await openService();
    harness.providers.store.seed(record(1), record(2), record(3));

    const first = await requestJson(harness.url("/v1/notes?limit=2"));
    expect(first.status).toBe(200);
    const firstBody = first.body as {
      notes: Array<{ id: string }>;
      cursor: string;
    };
    expect(firstBody.notes.map((entry) => entry.id)).toEqual([
      uuid(1),
      uuid(2),
    ]);
    // The cursor is opaque: it does not leak the underlying offset value.
    expect(firstBody.cursor).not.toBe("2");

    const second = await requestJson(
      harness.url(
        `/v1/notes?limit=2&cursor=${encodeURIComponent(firstBody.cursor)}`,
      ),
    );
    const secondBody = second.body as {
      notes: Array<{ id: string }>;
      cursor?: string;
    };
    expect(secondBody.notes.map((entry) => entry.id)).toEqual([uuid(3)]);
    expect(secondBody.cursor).toBeUndefined();

    const malformedCursor = await requestJson(
      harness.url("/v1/notes?cursor=not-a-cursor!"),
    );
    expect(malformedCursor.status).toBe(400);

    const malformedLimit = await requestJson(
      harness.url("/v1/notes?limit=zero"),
    );
    expect(malformedLimit.status).toBe(400);
  });
});

describe("inspection route", () => {
  it("exports complete notes with their stored vectors and embedding-space identity", async () => {
    const harness = await openService();
    harness.providers.store.seed(record(1), record(2));
    const first = await requestJson(
      harness.url("/v1/inspection/records?limit=1"),
    );
    expect(first.status).toBe(200);
    const body = first.body as {
      records: Array<{ note: { id: string }; vector: number[] }>;
      cursor: string;
      embeddingSpaceId: string;
    };
    expect(body.embeddingSpaceId).toBe(referenceEmbeddingSpace.id);
    expect(body.records[0]?.note.id).toBe(uuid(1));
    expect(body.records[0]?.vector).toEqual(record(1).vector);

    const second = await requestJson(
      harness.url(
        `/v1/inspection/records?limit=1&cursor=${encodeURIComponent(body.cursor)}`,
      ),
    );
    const secondBody = second.body as {
      records: Array<{ note: { id: string } }>;
      cursor?: string;
    };
    expect(secondBody.records.map((entry) => entry.note.id)).toEqual([uuid(2)]);
    expect(secondBody.cursor).toBeUndefined();
  });

  it("reports a failed export as unavailable", async () => {
    const harness = await openService();
    harness.providers.store.pageEmbeddedError = new Error("store failure");
    const response = await requestJson(harness.url("/v1/inspection/records"));
    expect(response.status).toBe(503);
    expect(
      (response.body as { error: { retryable: boolean } }).error.retryable,
    ).toBe(true);
  });
});

describe("status route", () => {
  it("reports collection identity, availability and durable queue outcomes", async () => {
    const harness = await openService();
    await postJson(harness.url("/v1/observations"), {
      sourceKey: "status-source",
      content: "An observation for the status report.",
    });
    await waitFor(async () => {
      const response = await requestJson(harness.url("/v1/status"));
      const body = response.body as {
        availability: { retrieval: boolean };
      };
      return body.availability.retrieval;
    }, "the provider stack to become ready");
    const response = await requestJson(harness.url("/v1/status"));
    expect(response.status).toBe(200);
    const body = response.body as {
      collection: string;
      embeddingSpace: { id: string; dimensions: number; distance: string };
      availability: {
        submission: boolean;
        retrieval: boolean;
        ingestion: boolean;
      };
      queue: {
        worker: string;
        accepted: number;
        backlog: number;
        oldestPendingAgeMs?: number;
        counts: Record<string, number>;
      };
      error?: string;
    };
    expect(body.collection).toBe("service-tests");
    expect(body.embeddingSpace).toEqual({
      id: referenceEmbeddingSpace.id,
      dimensions: referenceEmbeddingSpace.dimensions,
      distance: "Cosine",
    });
    expect(body.availability).toEqual({
      submission: true,
      retrieval: true,
      ingestion: true,
    });
    expect(body.queue.worker).toBe("running");
    expect(body.queue.accepted).toBeGreaterThanOrEqual(1);
    expect(body.error).toBeUndefined();
  });
});

describe("ingestion through the API", () => {
  it("stores a submitted observation and serves it through search and reads", async () => {
    const harness = await openService();
    const accepted = await postJson(harness.url("/v1/observations"), {
      sourceKey: "task-2/observation-1",
      content: "The durable observation.",
      timestamp: "2026-09-27T15:44:27.001+02:00",
    });
    expect(accepted.status).toBe(202);
    const receipt = accepted.body as { id: string };

    await waitFor(async () => {
      const response = await receiptOf(harness, receipt.id);
      const body = response.body as { status: string };
      return body.status === "stored";
    }, "the observation to be stored");

    const stored = await receiptOf(harness, receipt.id);
    const storedReceipt = stored.body as { noteId: string };
    expect(storedReceipt.noteId).toBeDefined();

    const read = await requestJson(
      harness.url(`/v1/notes/${storedReceipt.noteId}`),
    );
    expect(read.status).toBe(200);
    const storedNote = read.body as { content: string; timestamp: string };
    expect(storedNote.content).toBe("The durable observation.");
    // The queue fixes the observation timestamp at acceptance and preserves it.
    expect(storedNote.timestamp).toBe("2026-09-27T15:44:27.001+02:00");

    const search = await postJson(harness.url("/v1/search"), {
      query: "durable observation",
      limit: 5,
    });
    const results = (
      search.body as { results: Array<{ note: { id: string } }> }
    ).results;
    expect(results.map((result) => result.note.id)).toContain(
      storedReceipt.noteId,
    );
    // One shared encoder served the insertion representation and the query.
    expect(harness.providers.embedder.texts.length).toBeGreaterThanOrEqual(2);
  });
});
