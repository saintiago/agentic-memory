/**
 * The HTTP client of the local inspection API: it returns validated payloads, maps 400, 404 and
 * 500 responses to distinct errors and never turns a failure into an empty success.
 *
 * See docs/dashboard.md#browser-api.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createInspectorClient, HostRequestError } from "../client.js";
import { nodeId, note, searchOutcome } from "./support.js";

interface Answer {
  readonly status: number;
  readonly body: string;
}

const running: Server[] = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

/** One loopback host whose answers the case controls per path. */
const startHost = async (
  answers: (request: IncomingMessage) => Answer,
): Promise<string> => {
  const server = createServer((request, response) => {
    const answer = answers(request);
    response.writeHead(answer.status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(answer.body);
  });
  running.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test host did not bind a port.");
  }
  return `http://127.0.0.1:${String(address.port)}`;
};

describe("inspection client", () => {
  it("returns the raw graph body for the worker to validate", async () => {
    const baseUrl = await startHost(() => ({
      status: 200,
      body: '{"status":"loading","refreshing":false}',
    }));
    const client = createInspectorClient({ baseUrl });

    await expect(client.graphText()).resolves.toBe(
      '{"status":"loading","refreshing":false}',
    );
  });

  it("reports a refused graph request with its status and sanitized text", async () => {
    const baseUrl = await startHost(() => ({
      status: 500,
      body: JSON.stringify({
        error: "The inspection host could not serve the request.",
      }),
    }));
    const client = createInspectorClient({ baseUrl });

    await expect(client.graphText()).rejects.toThrow(HostRequestError);
    await expect(client.graphText()).rejects.toMatchObject({
      status: 500,
      message: "The inspection host could not serve the request.",
    });
  });

  it("returns a complete note and reports a missing one as undefined", async () => {
    const baseUrl = await startHost((request) =>
      request.url === `/api/notes/${nodeId(1)}`
        ? { status: 200, body: JSON.stringify(note(1)) }
        : {
            status: 404,
            body: JSON.stringify({ error: "No note exists with that ID." }),
          },
    );
    const client = createInspectorClient({ baseUrl });

    await expect(client.note(nodeId(1))).resolves.toEqual(note(1));
    await expect(client.note(nodeId(2))).resolves.toBeUndefined();
  });

  it("rejects a note payload outside the note contract", async () => {
    const baseUrl = await startHost(() => ({
      status: 200,
      body: JSON.stringify({ ...note(1), content: "" }),
    }));
    const client = createInspectorClient({ baseUrl });

    await expect(client.note(nodeId(1))).rejects.toMatchObject({
      name: "HostRequestError",
      message:
        "The host returned a note that does not match the note contract.",
    });
  });

  it("posts a search request and returns the validated returned order", async () => {
    const outcome = searchOutcome([
      { note: note(7), via: "match", score: 0.75 },
      { note: note(3), via: "link" },
    ]);
    let body = "";
    const baseUrl = await startHost((request) => {
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      return { status: 200, body: JSON.stringify(outcome) };
    });
    const client = createInspectorClient({ baseUrl });

    await expect(
      client.search({ query: "memory", limit: 2, linkedLimit: 0 }),
    ).resolves.toEqual(outcome);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    expect(JSON.parse(body)).toEqual({
      query: "memory",
      limit: 2,
      linkedLimit: 0,
    });
  });

  it("keeps a refused search an error with the host's explanation", async () => {
    const baseUrl = await startHost(() => ({
      status: 400,
      body: JSON.stringify({ error: "The search request is not valid." }),
    }));
    const client = createInspectorClient({ baseUrl });

    await expect(client.search({ query: "" })).rejects.toMatchObject({
      status: 400,
      message: "The search request is not valid.",
    });
  });

  it("rejects a search response outside the served contract", async () => {
    const baseUrl = await startHost(() => ({
      status: 200,
      body: JSON.stringify({
        searchedAt: "2026-09-28T12:00:00.000Z",
        results: [{ note: note(1) }],
      }),
    }));
    const client = createInspectorClient({ baseUrl });

    await expect(client.search({ query: "memory" })).rejects.toMatchObject({
      name: "HostRequestError",
      message:
        "The host returned a search response that does not match the search contract.",
    });
  });

  it("requests refreshes and projection rebuilds", async () => {
    const paths: string[] = [];
    const baseUrl = await startHost((request) => {
      paths.push(request.url ?? "");
      return {
        status: 202,
        body: JSON.stringify({ status: "ready", refreshing: true }),
      };
    });
    const client = createInspectorClient({ baseUrl });

    await client.refresh();
    await client.rebuildProjection();
    expect(paths).toEqual(["/api/refresh", "/api/projection/rebuild"]);
  });

  it("returns a comparison with the capture time of its view", async () => {
    const baseUrl = await startHost(() => ({
      status: 200,
      body: JSON.stringify({
        similarity: 0.8123,
        capturedAt: "2026-09-28T12:00:00.000Z",
      }),
    }));
    const client = createInspectorClient({ baseUrl });

    await expect(client.compare(nodeId(0), nodeId(1))).resolves.toEqual({
      similarity: 0.8123,
      capturedAt: "2026-09-28T12:00:00.000Z",
    });
  });

  it("keeps a comparison conflict an error", async () => {
    const baseUrl = await startHost(() => ({
      status: 409,
      body: JSON.stringify({
        error: "The host has no completed graph view yet.",
      }),
    }));
    const client = createInspectorClient({ baseUrl });

    await expect(client.compare(nodeId(0), nodeId(1))).rejects.toMatchObject({
      status: 409,
      message: "The host has no completed graph view yet.",
    });
  });
});
