import { describe, expect, it } from "vitest";
import {
  openQdrantNoteStore,
  type NoteStoreSpace,
  type QdrantNoteStoreOptions,
} from "../../src/note-store/index.js";

/**
 * Host settings are validated before any request reaches a server, so these cases need no
 * infrastructure. docs/note-store.md#collection-compatibility
 */

const space: NoteStoreSpace = {
  id: "amem2-test-space",
  dimensions: 4,
  distance: "Cosine",
};

/** The URL is unreachable on purpose: a case that fails to reject early would fail loudly. */
const unreachable = "http://127.0.0.1:1";

const open = (options: Record<string, unknown>) =>
  openQdrantNoteStore(options as unknown as QdrantNoteStoreOptions);

/** Every message an error could disclose, including its nested causes. */
const messagesOf = (error: unknown): string => {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
};

describe("Qdrant note store settings", () => {
  it("rejects a URL without an HTTP(S) scheme", async () => {
    await expect(
      open({ url: "127.0.0.1:6333", collection: "notes", space }),
    ).rejects.toThrow(/URL must start with/);
  });

  it("rejects an empty collection name", async () => {
    await expect(
      open({ url: unreachable, collection: "", space }),
    ).rejects.toThrow(/collection name/);
  });

  it("rejects an incomplete or unsupported embedding-space descriptor", async () => {
    await expect(
      open({
        url: unreachable,
        collection: "notes",
        space: { ...space, id: "" },
      }),
    ).rejects.toThrow(/embedding-space ID/);
    await expect(
      open({
        url: unreachable,
        collection: "notes",
        space: { ...space, dimensions: 0 },
      }),
    ).rejects.toThrow(/Dimensions/);
    await expect(
      open({
        url: unreachable,
        collection: "notes",
        space: { ...space, dimensions: 4.5 },
      }),
    ).rejects.toThrow(/Dimensions/);
    await expect(
      open({
        url: unreachable,
        collection: "notes",
        space: {
          id: space.id,
          dimensions: space.dimensions,
          distance: "Euclid",
        },
      }),
    ).rejects.toThrow(/Cosine/);
  });

  it("rejects invalid request timeouts and unknown settings", async () => {
    await expect(
      open({ url: unreachable, collection: "notes", space, timeoutMs: 0 }),
    ).rejects.toThrow(/timeout/);
    await expect(
      open({ url: unreachable, collection: "notes", space, timeoutMs: 1.5 }),
    ).rejects.toThrow(/timeout/);
    await expect(
      open({ url: unreachable, collection: "notes", space, retries: 3 }),
    ).rejects.toThrow();
  });

  it("rejects an empty API key rather than sending an unusable credential", async () => {
    await expect(
      open({ url: unreachable, collection: "notes", space, apiKey: "" }),
    ).rejects.toThrow(/API key/);
  });

  it("rejects an API key that cannot be sent as a header value without echoing it", async () => {
    // The Qdrant client sends the credential in an `api-key` header, so a key the platform cannot
    // send must fail here instead of surfacing the client's value-bearing header error.
    const apiKey = "review-synthetic\nsecret";
    const failure: unknown = await open({
      url: unreachable,
      collection: "notes",
      space,
      apiKey,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/valid HTTP header value/);
    expect(messagesOf(failure)).not.toContain(apiKey);
  });
});
