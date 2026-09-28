import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProjectionArtifactStore } from "../../inspector/artifacts.js";
import {
  makeDirectory,
  removeDirectory,
  scriptedArtifact,
  uuid,
} from "./support/inspection.js";

/**
 * Component tests for the disposable projection artifact: round trips, atomic replacement and the
 * discard of a stored artifact that is malformed or belongs to another collection or space.
 *
 * See docs/dashboard.md#startup-and-composition.
 */

const artifact = scriptedArtifact({
  collection: "notes",
  embeddingSpaceId: "space-1",
  rebuild: false,
  inputs: [
    { id: uuid(1), vector: [1, 0] },
    { id: uuid(2), vector: [0, 1] },
  ],
});

const identity = { collection: "notes", embeddingSpaceId: "space-1" } as const;

describe("projection artifacts", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await makeDirectory("amem-inspector-artifacts-");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeDirectory(directory);
  });

  it("stores and reloads one applicable artifact without leaving temporary files", async () => {
    const store = createProjectionArtifactStore(directory);
    expect(await store.load(identity)).toBeUndefined();

    await store.save(artifact);

    expect(await store.load(identity)).toEqual(artifact);
    expect(await readdir(directory)).toEqual(["projection.json"]);
    const text = await readFile(
      path.join(directory, "projection.json"),
      "utf8",
    );
    expect(text.endsWith("\n")).toBe(true);
  });

  it("replaces an earlier artifact instead of appending to it", async () => {
    const store = createProjectionArtifactStore(directory);
    await store.save(artifact);
    const replacement = {
      ...artifact,
      projectionId: "test-projection:replaced",
    };

    await store.save(replacement);

    expect(await store.load(identity)).toEqual(replacement);
    expect(await readdir(directory)).toEqual(["projection.json"]);
  });

  it("discards an artifact of another collection or embedding space", async () => {
    const store = createProjectionArtifactStore(directory);
    await store.save(artifact);

    expect(
      await store.load({ collection: "other", embeddingSpaceId: "space-1" }),
    ).toBeUndefined();
    await expect(
      stat(path.join(directory, "projection.json")),
    ).rejects.toThrow();

    await store.save(artifact);
    expect(
      await store.load({ collection: "notes", embeddingSpaceId: "space-2" }),
    ).toBeUndefined();
    await expect(
      stat(path.join(directory, "projection.json")),
    ).rejects.toThrow();
  });

  it("discards a malformed artifact instead of presenting it as current", async () => {
    const file = path.join(directory, "projection.json");
    await writeFile(file, "{ not json", "utf8");
    const store = createProjectionArtifactStore(directory);

    expect(await store.load(identity)).toBeUndefined();
    await expect(stat(file)).rejects.toThrow();

    await writeFile(file, JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(await store.load(identity)).toBeUndefined();
    await expect(stat(file)).rejects.toThrow();
  });
});
