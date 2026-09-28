import type {
  Cursor,
  EmbeddedNote,
  EmbeddedPage,
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
 * `pageEmbedded` exports complete current notes together with their actual stored vectors under
 * the same limit, cursor and traversal rules.
 *
 * See docs/note-store.md.
 */
export interface NoteStore {
  put(records: EmbeddedNote[]): Promise<void>;
  get(ids: string[]): Promise<Note[]>;
  nearest(vector: number[], limit: number): Promise<Match[]>;
  page(limit: number, cursor?: Cursor): Promise<Page>;
  pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage>;
}
