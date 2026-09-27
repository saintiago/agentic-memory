import { afterAll, describe, expect, it } from "vitest";
import { QdrantCollectionCompatibilityError } from "../../../src/note-store/index.js";
import {
  adminClient,
  dropCollection,
  openStore,
  testSpace,
  uniqueCollection,
} from "../support/note-store.js";

/** docs/note-store.md#collection-compatibility */

const created: string[] = [];

const collection = (label: string): string => {
  const name = uniqueCollection(label);
  created.push(name);
  return name;
};

const metadataFor = (
  space: ReturnType<typeof testSpace>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  agenticMemory: {
    schemaVersion: 1,
    representation: "amem-note-v1",
    embeddingSpace: { ...space },
    ...overrides,
  },
});

afterAll(async () => {
  for (const name of created) {
    await dropCollection(name);
  }
});

describe("Qdrant collection compatibility", () => {
  it("creates a missing collection with its vector configuration and metadata", async () => {
    const name = collection("create");

    const store = await openStore(name);

    const info = await adminClient().getCollection(name);
    expect(info.config.params.vectors).toMatchObject({
      size: 4,
      distance: "Cosine",
    });
    expect(info.config.metadata).toEqual(metadataFor(testSpace()));
    await expect(store.page(1)).resolves.toEqual({ notes: [] });
  });

  it("opens an existing compatible collection without rewriting it", async () => {
    const name = collection("open");
    const first = await openStore(name);
    await first.put([
      {
        note: {
          id: "b3c1d2e3-4f50-4610-8899-0a1b2c3d4e5f",
          content: "An existing record.",
          timestamp: "2026-09-27T15:44:27.001+02:00",
          context: "Records an existing note.",
          keywords: [],
          tags: [],
          links: [],
        },
        vector: [1, 0, 0, 0],
      },
    ]);
    const before = await adminClient().getCollection(name);

    const second = await openStore(name);

    const after = await adminClient().getCollection(name);
    expect(after.config.metadata).toEqual(before.config.metadata);
    expect(after.config.params.vectors).toEqual(before.config.params.vectors);
    expect(await second.page(10)).toMatchObject({
      notes: [{ content: "An existing record." }],
    });
  });

  it("rejects a collection whose agenticMemory metadata is missing", async () => {
    const name = collection("unmanaged");
    await adminClient().createCollection(name, {
      vectors: { size: 4, distance: "Cosine" },
    });

    await expect(openStore(name)).rejects.toThrow(
      QdrantCollectionCompatibilityError,
    );
    await expect(openStore(name)).rejects.toThrow(/agenticMemory/);
  });

  it("rejects a different embedding-space identity even at equal dimensions", async () => {
    const name = collection("other-space");
    await adminClient().createCollection(name, {
      vectors: { size: 4, distance: "Cosine" },
      metadata: metadataFor(testSpace({ id: "some-other-encoder" })),
    });

    const opening = openStore(name, testSpace({ id: "requested-encoder" }));

    await expect(opening).rejects.toThrow(QdrantCollectionCompatibilityError);
    await expect(opening).rejects.toThrow(/some-other-encoder/);
    // Rejecting must not adopt or rewrite the unknown collection.
    const info = await adminClient().getCollection(name);
    expect(info.config.metadata).toEqual(
      metadataFor(testSpace({ id: "some-other-encoder" })),
    );
  });

  it("rejects when the declared space disagrees with the actual vector configuration", async () => {
    const name = collection("vector-mismatch");
    await adminClient().createCollection(name, {
      vectors: { size: 8, distance: "Cosine" },
      metadata: metadataFor(testSpace()),
    });

    await expect(openStore(name)).rejects.toThrow(
      /vector configuration is 8 dimensions/,
    );
  });

  it("rejects a non-cosine distance declared for an otherwise equal space", async () => {
    const name = collection("distance");
    await adminClient().createCollection(name, {
      vectors: { size: 4, distance: "Euclid" },
      metadata: metadataFor(testSpace({ distance: "Cosine" })),
    });

    await expect(openStore(name)).rejects.toThrow(/Euclid/);
  });

  it("rejects unsupported representation and schema versions", async () => {
    const prototype = collection("prototype");
    await adminClient().createCollection(prototype, {
      vectors: { size: 4, distance: "Cosine" },
      metadata: {
        agenticMemory: {
          schemaVersion: 1,
          representation: "prototype-note-v0",
          embeddingSpace: { ...testSpace() },
        },
      },
    });
    const future = collection("future");
    await adminClient().createCollection(future, {
      vectors: { size: 4, distance: "Cosine" },
      metadata: metadataFor(testSpace(), { schemaVersion: 2 }),
    });

    await expect(openStore(prototype)).rejects.toThrow(/prototype-note-v0/);
    await expect(openStore(future)).rejects.toThrow(/schemaVersion/);
  });

  it("rejects a collection that does not store one unnamed dense vector", async () => {
    const name = collection("named-vectors");
    await adminClient().createCollection(name, {
      vectors: { text: { size: 4, distance: "Cosine" } },
      metadata: metadataFor(testSpace()),
    });

    await expect(openStore(name)).rejects.toThrow(/unnamed dense vector/);
  });
});
