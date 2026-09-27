import { afterEach, describe, expect, it, vi } from "vitest";
import { openQdrantNoteStore } from "../../src/note-store/index.js";

const space = {
  id: "endpoint-test",
  dimensions: 4,
  distance: "Cosine",
} as const;
const note = {
  id: "00000000-0000-4000-8000-000000000001",
  content: "Endpoint routing test.",
  context: "A synthetic note for request routing.",
  timestamp: "2026-09-27T00:00:00Z",
  keywords: [],
  tags: [],
  links: [],
};

afterEach(() => vi.restoreAllMocks());

// Real client, controlled HTTP responses: these cases establish request destinations, not
// provider persistence. Normalize only the captured URL so standard ports compare by meaning.
describe.each([true, false])(
  "Qdrant endpoint routing (existing=%s)",
  (exists) => {
    it.each([
      ["https://qdrant.example:443", "https://qdrant.example"],
      ["http://qdrant.example:80", "http://qdrant.example"],
      ["https://qdrant.example", "https://qdrant.example"],
      ["http://qdrant.example", "http://qdrant.example"],
      ["http://qdrant.example:16333", "http://qdrant.example:16333"],
      [
        "http://qdrant.example:16333/memory",
        "http://qdrant.example:16333/memory",
      ],
      [
        "https://qdrant.example:443/tenant/memory/",
        "https://qdrant.example/tenant/memory",
      ],
      [
        "https://qdrant.example/tenant%20one",
        "https://qdrant.example/tenant%20one",
      ],
      ["http://[::1]:16333/memory/", "http://[::1]:16333/memory"],
    ])(
      "preserves %s for initialization and every operation",
      async (url, base) => {
        const requests: string[] = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(
          async (input, init) => {
            const target = new URL(
              input instanceof Request ? input.url : String(input),
            ).href;
            const method = init?.method ?? "GET";
            requests.push(`${method} ${target}`);
            if (target === `${base}/`) {
              return Response.json({ version: "1.19.1" });
            }
            if (!target.startsWith(`${base}/collections/notes`)) {
              throw new Error(`Unexpected request destination: ${target}`);
            }
            let result: unknown;
            if (target.endsWith("/exists")) {
              result = { exists };
            } else if (method === "GET") {
              result = {
                config: {
                  params: {
                    vectors: {
                      size: 4,
                      distance: "Cosine",
                      datatype: "float32",
                    },
                  },
                  metadata: {
                    agenticMemory: {
                      schemaVersion: 1,
                      representation: "amem-note-v1",
                      embeddingSpace: space,
                    },
                  },
                },
              };
            } else if (method === "PUT") {
              result = true;
            } else if (target.endsWith("/query")) {
              result = { points: [] };
            } else if (target.endsWith("/scroll")) {
              result = { points: [], next_page_offset: null };
            } else {
              result = [];
            }
            return Response.json({ result, status: "ok", time: 0 });
          },
        );

        const store = await openQdrantNoteStore({
          url,
          collection: "notes",
          space,
        });
        await store.put([{ note, vector: [1, 0, 0, 0] }]);
        await store.get([note.id]);
        await store.nearest([1, 0, 0, 0], 1);
        await store.page(1);

        expect(requests.toSorted()).toEqual(
          [
            `GET ${base}/`,
            `GET ${base}/collections/notes/exists`,
            ...(exists ? [] : [`PUT ${base}/collections/notes`]),
            `GET ${base}/collections/notes`,
            `PUT ${base}/collections/notes/points?wait=true`,
            `POST ${base}/collections/notes/points`,
            `POST ${base}/collections/notes/points/query`,
            `POST ${base}/collections/notes/points/scroll`,
          ].toSorted(),
        );
      },
    );
  },
);

it.each([
  "http://",
  "http://qdrant.example:99999",
  "http://qdrant.example:0",
  "https://synthetic-user:synthetic-secret@qdrant.example",
  "https://qdrant.example/memory?token=synthetic-secret",
  "https://qdrant.example/memory#fragment",
  "https://qdrant.example/?",
  "https://qdrant.example/#",
])("rejects unsupported URL %s before constructing the client", async (url) => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected request"));
  const failure: unknown = await openQdrantNoteStore({
    url,
    collection: "notes",
    space,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/Qdrant URL/);
  expect((failure as Error).message).not.toContain("synthetic-secret");
  expect((failure as Error).cause).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
