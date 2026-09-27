import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Component test for the host composition example. The public library surface is replaced by
 * recording substitutes, so the example's own wiring is observable without real providers: it
 * must read and validate every host setting before any provider work, and it must assemble the
 * host-supplied settings into the providers it opens.
 *
 * See docs/architecture.md#composition, examples/README.md and docs/testing.md#main-risks-and-ownership.
 */
const observed = vi.hoisted(() => ({
  calls: [] as string[],
  embedderOptions: [] as unknown[],
  embedders: [] as unknown[],
  storeOptions: [] as unknown[],
  stores: [] as unknown[],
  memoryArguments: [] as {
    store: unknown;
    embedder: unknown;
    model: unknown;
  }[],
}));

vi.mock("../../src/index.js", () => {
  /** The space the substitute encoder reports; the example copies it into the store options. */
  const space = { id: "example-space", dimensions: 2, distance: "Cosine" };

  class AgenticMemory {
    constructor(store: unknown, embedder: unknown, model: unknown) {
      observed.calls.push("memory");
      observed.memoryArguments.push({ store, embedder, model });
    }

    async add(): Promise<unknown> {
      observed.calls.push("add");
      return {
        id: "00000000-0000-4000-8000-000000000001",
        content: "Source material.",
        timestamp: "2026-09-27T15:44:27.001+02:00",
        context: "Records source material.",
        keywords: ["source"],
        tags: ["observation"],
        links: [],
      };
    }

    async search(): Promise<unknown[]> {
      observed.calls.push("search");
      return [];
    }

    async get(): Promise<undefined> {
      observed.calls.push("get");
      return undefined;
    }

    async page(): Promise<{ notes: unknown[] }> {
      observed.calls.push("page");
      return { notes: [] };
    }
  }

  return {
    AgenticMemory,
    embeddingText: () => "",
    openReferenceEmbedder: async (options: unknown) => {
      observed.calls.push("embedder");
      observed.embedderOptions.push(options);
      const embedder = { space, embed: async () => [1, 0] };
      observed.embedders.push(embedder);
      return embedder;
    },
    openQdrantNoteStore: async (options: unknown) => {
      observed.calls.push("store");
      observed.storeOptions.push(options);
      const store = {};
      observed.stores.push(store);
      return store;
    },
  };
});

/** Every setting the example reads; optional ones are cleared so only the case supplies values. */
const SETTING_NAMES = [
  "AMEM_QDRANT_COLLECTION",
  "AMEM_QDRANT_URL",
  "AMEM_QDRANT_API_KEY",
  "AMEM_QDRANT_TIMEOUT_MS",
  "AMEM_EMBEDDING_CACHE",
  "AMEM_ALLOW_EMBEDDING_DOWNLOADS",
  "AMEM_MODEL_ENDPOINT",
  "AMEM_MODEL_ID",
  "AMEM_MODEL_API_KEY",
  "AMEM_MODEL_TIMEOUT_MS",
  "AMEM_MODEL_MAX_OUTPUT_TOKENS",
] as const;

const applySettings = (settings: Record<string, string>): void => {
  for (const name of SETTING_NAMES) {
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(settings)) {
    process.env[name] = value;
  }
};

const importExample = async (): Promise<unknown> =>
  import("../../examples/host-composition.js");

afterEach(() => {
  applySettings({});
  observed.calls.length = 0;
  observed.embedderOptions.length = 0;
  observed.embedders.length = 0;
  observed.storeOptions.length = 0;
  observed.stores.length = 0;
  observed.memoryArguments.length = 0;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("host composition example", () => {
  it("rejects an incomplete configuration before any provider work", async () => {
    applySettings({
      AMEM_QDRANT_COLLECTION: "amem-example",
    });
    vi.resetModules();
    await expect(importExample()).rejects.toThrow(/AMEM_QDRANT_URL/);
    expect(observed.calls).toEqual([]);

    applySettings({
      AMEM_QDRANT_COLLECTION: "amem-example",
      AMEM_QDRANT_URL: "http://127.0.0.1:6333",
    });
    vi.resetModules();
    await expect(importExample()).rejects.toThrow(/AMEM_MODEL_ENDPOINT/);
    expect(observed.calls).toEqual([]);

    applySettings({
      AMEM_QDRANT_COLLECTION: "amem-example",
      AMEM_QDRANT_URL: "http://127.0.0.1:6333",
      AMEM_MODEL_ENDPOINT: "https://model.example/v1/chat/completions",
    });
    vi.resetModules();
    await expect(importExample()).rejects.toThrow(/AMEM_MODEL_ID/);
    expect(observed.calls).toEqual([]);
  });

  it("assembles the host-supplied providers from the host settings", async () => {
    applySettings({
      AMEM_QDRANT_COLLECTION: "amem-example",
      AMEM_QDRANT_URL: "http://127.0.0.1:6333",
      AMEM_QDRANT_API_KEY: "qdrant-key",
      AMEM_QDRANT_TIMEOUT_MS: "5000",
      AMEM_EMBEDDING_CACHE: "/tmp/example-cache",
      AMEM_ALLOW_EMBEDDING_DOWNLOADS: "false",
      AMEM_MODEL_ENDPOINT: "https://model.example/v1/chat/completions",
      AMEM_MODEL_ID: "host-model",
      AMEM_MODEL_API_KEY: "model-key",
      AMEM_MODEL_TIMEOUT_MS: "6000",
      AMEM_MODEL_MAX_OUTPUT_TOKENS: "700",
    });
    vi.resetModules();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await importExample();

    expect(observed.calls).toEqual([
      "embedder",
      "store",
      "memory",
      "add",
      "add",
      "search",
      "page",
    ]);
    expect(observed.embedderOptions).toEqual([
      { cacheDir: "/tmp/example-cache", allowDownloads: false },
    ]);
    expect(observed.storeOptions).toEqual([
      {
        url: "http://127.0.0.1:6333",
        collection: "amem-example",
        space: { id: "example-space", dimensions: 2, distance: "Cosine" },
        timeoutMs: 5000,
        apiKey: "qdrant-key",
      },
    ]);
    // The instance receives the providers the example just opened, not copies or replacements.
    expect(observed.memoryArguments).toEqual([
      {
        store: observed.stores[0],
        embedder: observed.embedders[0],
        model: expect.any(Object),
      },
    ]);
    expect(log).toHaveBeenCalled();
  });
});
