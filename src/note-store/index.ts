/**
 * NoteStore public contract: durable note and vector records, identity lookup, similarity search
 * and paginated inspection.
 *
 * See docs/note-store.md and docs/architecture.md#public-contracts.
 */
import type { Cursor, EmbeddedNote, Match, Note, Page } from "./note-record.js";

export {
  attributesSchema,
  cursorSchema,
  embeddedNoteSchema,
  jsonValueSchema,
  matchSchema,
  noteIdSchema,
  noteSchema,
  pageSchema,
} from "./note-record.js";
export type {
  Attributes,
  Cursor,
  EmbeddedNote,
  JsonValue,
  Match,
  Note,
  Page,
} from "./note-record.js";

/**
 * Persistence boundary for current note/vector records.
 *
 * `put` replaces complete supplied records at their IDs and returns after acknowledged
 * application. `get` omits missing IDs and returns each found ID at most once. `nearest` returns at
 * most the requested number of matches ordered by descending cosine similarity. `page` traverses
 * the collection without duplicates and returns a cursor only when another page may exist.
 */
export interface NoteStore {
  put(records: EmbeddedNote[]): Promise<void>;
  get(ids: string[]): Promise<Note[]>;
  nearest(vector: number[], limit: number): Promise<Match[]>;
  page(limit: number, cursor?: Cursor): Promise<Page>;
}
