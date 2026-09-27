/**
 * Shared fixtures for the real-Qdrant NoteStore cases: isolated collection names, complete note
 * records, an administrative client for inspecting and cleaning up collections, and store
 * instances opened through the public contract.
 */
import { randomUUID } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { inject } from "vitest";
import {
  openQdrantNoteStore,
  type EmbeddedNote,
  type Note,
  type NoteStore,
  type NoteStoreSpace,
} from "../../../src/note-store/index.js";

/** The Qdrant endpoint the integration fixture prepared. */
export const qdrantUrl = (): string => inject("qdrantUrl");

let admin: QdrantClient | undefined;

/** Administrative access for inspecting, seeding and removing isolated collections. */
export const adminClient = (): QdrantClient => {
  admin ??= new QdrantClient({ url: qdrantUrl(), timeout: 120_000 });
  return admin;
};

/** A collection name unique to one case, so cases never share or overwrite state. */
export const uniqueCollection = (label: string): string =>
  `amem2_${label}_${randomUUID().replaceAll("-", "")}`;

export const testSpace = (
  overrides: Partial<NoteStoreSpace> = {},
): NoteStoreSpace => ({
  id: "amem2-test-space",
  dimensions: 4,
  distance: "Cosine",
  ...overrides,
});

export const NOTE_TIMESTAMP = "2026-09-27T15:44:27.001+02:00";

/** A complete note whose fields a case can override. */
export const note = (overrides: Partial<Note> = {}): Note => ({
  id: randomUUID(),
  content: "Removing a stale queue entry requires an operator approval.",
  timestamp: NOTE_TIMESTAMP,
  context: "Records the approval requirement for removing stale queue entries.",
  keywords: ["queue entry", "approval"],
  tags: ["operations", "policy"],
  links: [],
  ...overrides,
});

/** A note plus its synthetic vector; small dimensions keep the corpus cheap. */
export const embedded = (
  overrides: Partial<Note> = {},
  vector: number[] = [1, 0, 0, 0],
): EmbeddedNote => ({ note: note(overrides), vector });

export const openStore = (
  collection: string,
  space: NoteStoreSpace = testSpace(),
): Promise<NoteStore> => openStoreAt(qdrantUrl(), collection, space);

export const openStoreAt = (
  url: string,
  collection: string,
  space: NoteStoreSpace = testSpace(),
): Promise<NoteStore> =>
  openQdrantNoteStore({ url, collection, space, timeoutMs: 120_000 });

export const pointCount = async (collection: string): Promise<number> =>
  (await adminClient().count(collection, { exact: true })).count;

/** Remove an isolated collection; cleanup stays best effort so a failed case still tears down. */
export const dropCollection = async (collection: string): Promise<void> => {
  try {
    await adminClient().deleteCollection(collection);
  } catch {
    // The collection may already be removed; cleanup must not mask the test outcome.
  }
};

/**
 * A deterministic UUID in ascending order of `value`, so a large synthetic corpus has stable
 * identities without generating 10,000 random UUIDs.
 */
export const orderedNoteId = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

/** Sorts after every generated identity, so it is the sentinel of a paged traversal. */
export const SENTINEL_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
