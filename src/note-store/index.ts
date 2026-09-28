/**
 * NoteStore public contract: durable note and vector records, identity lookup, similarity search
 * and paginated inspection.
 *
 * See docs/note-store.md and docs/architecture.md#public-contracts.
 */

export {
  attributesSchema,
  cursorSchema,
  embeddedNoteSchema,
  embeddedPageSchema,
  jsonValueSchema,
  matchSchema,
  noteIdSchema,
  noteSchema,
  pageSchema,
  vectorSchema,
} from "./note-record.js";
export type {
  Attributes,
  Cursor,
  EmbeddedNote,
  EmbeddedPage,
  JsonValue,
  Match,
  Note,
  Page,
} from "./note-record.js";
export type { NoteStore } from "./note-store.js";
export {
  QdrantCollectionCompatibilityError,
  openQdrantNoteStore,
} from "./qdrant-note-store.js";
export type {
  NoteStoreSpace,
  QdrantNoteStoreOptions,
} from "./qdrant-note-store.js";
