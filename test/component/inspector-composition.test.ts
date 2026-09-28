import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openInspectionSource } from "../../inspector/composition.js";
import { startInspectionServer } from "../../inspector/server.js";
import { InspectionSession } from "../../inspector/session.js";
import { readInspectionSettings } from "../../inspector/settings.js";
import {
  makeDirectory,
  RecordingRunner,
  removeDirectory,
} from "./support/inspection.js";
import {
  postJson,
  record,
  startServiceHarness,
  uuid,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Component test for the inspection host's composition: the host owns only the memory service
 * URL, and every read it serves travels over the documented `/v1` API. No database client, encoder
 * or Memory instance is constructed by the host.
 *
 * See docs/dashboard.md#startup-and-composition.
 */

const servers: Array<ReturnType<typeof createServer>> = [];
const harnesses: ServiceHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
  for (const directory of directories.splice(0)) {
    await removeDirectory(directory);
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

const note = {
  id: "00000000-0000-4000-8000-000000000001",
  content: "Stored source material.",
  timestamp: "2026-09-27T15:44:27.001+02:00",
  context: "Records stored source material.",
  keywords: ["source"],
  tags: ["observation"],
  links: [],
};

/** One stub memory service recording the routes the composed source calls. */
const startStubService = async (): Promise<{
  readonly url: string;
  readonly routes: string[];
}> => {
  const routes: string[] = [];
  const server = createServer((request, response) => {
    const route = request.url ?? "";
    routes.push(`${request.method ?? "GET"} ${route}`);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    if (route.startsWith("/v1/status")) {
      response.end(
        JSON.stringify({
          collection: "notes",
          embeddingSpace: { id: "space-1", dimensions: 4, distance: "Cosine" },
          availability: {
            submission: true,
            retrieval: true,
            ingestion: true,
          },
        }),
      );
      return;
    }
    if (route.startsWith("/v1/inspection/records")) {
      response.end(
        JSON.stringify({ records: [], embeddingSpaceId: "space-1" }),
      );
      return;
    }
    if (route.startsWith("/v1/notes/")) {
      response.end(JSON.stringify(note));
      return;
    }
    if (route.startsWith("/v1/search")) {
      response.end(
        JSON.stringify({ searchedAt: "2026-09-28T12:00:00.000Z", results: [] }),
      );
      return;
    }
    response.end(JSON.stringify({ notes: [], cursor: "next" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, routes };
};

describe("inspection host composition", () => {
  it("serves identity, details, search and records over the configured service URL", async () => {
    const stub = await startStubService();
    const source = openInspectionSource(
      readInspectionSettings({
        AMEM_SERVICE_URL: `${stub.url}/`,
        AMEM_SERVICE_TIMEOUT_MS: "5000",
      }),
    );

    await expect(source.identity()).resolves.toEqual({
      collection: "notes",
      embeddingSpaceId: "space-1",
    });
    await expect(source.pageEmbedded(10, "opaque-token")).resolves.toEqual({
      records: [],
    });
    await expect(source.get(note.id)).resolves.toEqual(note);
    await expect(source.search("query", { limit: 3 })).resolves.toEqual([]);

    expect(stub.routes).toEqual([
      "GET /v1/status",
      "GET /v1/inspection/records?limit=10&cursor=opaque-token",
      `GET /v1/notes/${note.id}`,
      "POST /v1/search",
    ]);
  });

  it("serves refreshed views and search results read from the memory service", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    harness.providers.store.seed(record(1));
    const source = openInspectionSource(
      readInspectionSettings({ AMEM_SERVICE_URL: harness.baseUrl }),
    );
    const directory = await makeDirectory("amem-inspector-service-");
    directories.push(directory);
    const uiDirectory = path.join(directory, "ui");
    await mkdir(uiDirectory, { recursive: true });
    await writeFile(
      path.join(uiDirectory, "index.html"),
      "<!doctype html><title>Inspection UI</title>",
      "utf8",
    );
    const session = new InspectionSession({
      source,
      runner: new RecordingRunner(),
      artifacts: {
        load: () => Promise.resolve(undefined),
        save: () => Promise.resolve(),
      },
      pollIntervalMs: 0,
    });
    const server = await startInspectionServer({
      reads: source,
      session,
      uiDirectory,
      port: 0,
    });
    const base = `http://127.0.0.1:${String(server.port)}`;
    try {
      session.start();
      await session.settled();
      const graph = await fetch(`${base}/api/graph`);
      const view = (await graph.json()) as {
        status: string;
        view?: { nodes: Array<{ id: string }>; embeddingSpaceId: string };
      };
      expect(view.status).toBe("ready");
      expect(view.view?.nodes.map((node) => node.id)).toEqual([uuid(1)]);
      expect(view.view?.embeddingSpaceId).toBeDefined();

      const search = await postJson(`${base}/api/search`, {
        query: "source material",
        limit: 5,
      });
      expect(search.status).toBe(200);
      expect(
        (
          search.body as {
            results: Array<{ note: { id: string }; via: string }>;
          }
        ).results[0],
      ).toMatchObject({ note: { id: uuid(1) }, via: "match" });

      const detail = await fetch(`${base}/api/notes/${uuid(1)}`);
      expect(detail.status).toBe(200);

      // A later refresh discovers the note the service stored after the first view.
      harness.providers.store.seed(record(2));
      session.refresh();
      await session.settled();
      const refreshed = await fetch(`${base}/api/graph`);
      const refreshedView = (await refreshed.json()) as {
        view: { nodes: Array<{ id: string }> };
      };
      expect(refreshedView.view.nodes.map((node) => node.id)).toEqual([
        uuid(1),
        uuid(2),
      ]);
    } finally {
      await server.close();
      await session.stop();
    }
  });
});
