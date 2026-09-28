import { describe, expect, it, vi } from "vitest";

/**
 * Component test for the inspection host's public-API composition. The public library surface is
 * replaced by recording substitutes, so the host's own wiring is observable: one matching embedder
 * is opened first, its declared space is handed to the store, and the memory instance receives a
 * host-local model that refuses generation while credentials stay with the host settings.
 *
 * See docs/dashboard.md#startup-and-composition and docs/testing.md#main-risks-and-ownership.
 */
const observed = vi.hoisted(() => ({
  calls: [] as string[],
  embedderOptions: [] as unknown[],
  storeOptions: [] as unknown[],
  memoryArguments: [] as Array<{
    store: unknown;
    embedder: unknown;
    model: unknown;
  }>,
  memories: [] as unknown[],
}));

vi.mock("../../src/index.js", () => {
  /** The space the substitute encoder declares; the composition copies it into store options. */
  const space = { id: "composition-space", dimensions: 2, distance: "Cosine" };

  class AgenticMemory {
    constructor(store: unknown, embedder: unknown, model: unknown) {
      observed.calls.push("memory");
      observed.memoryArguments.push({ store, embedder, model });
      observed.memories.push(this);
    }
  }

  return {
    AgenticMemory,
    openReferenceEmbedder: async (options: unknown) => {
      observed.calls.push("embedder");
      observed.embedderOptions.push(options);
      return { space, embed: async () => [1, 0] };
    },
    openQdrantNoteStore: async (options: unknown) => {
      observed.calls.push("store");
      observed.storeOptions.push(options);
      return {};
    },
  };
});

const importComposition = async (): Promise<
  typeof import("../../inspector/composition.js")
> => import("../../inspector/composition.js");

describe("inspection host composition", () => {
  it("opens the encoder first, hands its space to the store and supplies a refusing model", async () => {
    const { openInspectionMemory } = await importComposition();
    const { readInspectionSettings } =
      await import("../../inspector/settings.js");
    const opened = await openInspectionMemory(
      readInspectionSettings({
        AMEM_QDRANT_URL: "http://127.0.0.1:16333/tenant/",
        AMEM_QDRANT_COLLECTION: "notes",
        AMEM_QDRANT_API_KEY: "host-owned-secret",
        AMEM_QDRANT_TIMEOUT_MS: "5000",
        AMEM_EMBEDDING_CACHE: "/tmp/inspection-cache",
        AMEM_ALLOW_EMBEDDING_DOWNLOADS: "false",
      }),
    );

    expect(observed.calls).toEqual(["embedder", "store", "memory"]);
    expect(observed.embedderOptions).toEqual([
      { cacheDir: "/tmp/inspection-cache", allowDownloads: false },
    ]);
    expect(observed.storeOptions).toEqual([
      {
        url: "http://127.0.0.1:16333/tenant/",
        collection: "notes",
        // The exact declared space travels to the store, not just its dimensions.
        space: { id: "composition-space", dimensions: 2, distance: "Cosine" },
        timeoutMs: 5000,
        apiKey: "host-owned-secret",
      },
    ]);
    const created = observed.memoryArguments[0];
    expect(created?.embedder).toBe(opened.embedder);
    expect(created?.store).toBe(opened.store);
    expect(opened.memory).toBe(observed.memories[0]);
    expect(opened.embedder.space.id).toBe("composition-space");

    // Inspection never generates text, so the supplied model fails instead of contacting a host.
    const model = created?.model as { generate: () => Promise<unknown> };
    await expect(model.generate()).rejects.toThrow(
      "The inspection host does not invoke a language model.",
    );
  });
});
