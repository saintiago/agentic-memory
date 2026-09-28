import type { Note } from "../note-store/index.js";

/**
 * The canonical text an embedding represents, with LF separators and no extra prefix or final
 * newline. Identity, the observation timestamp, the persisted update time, links and provenance
 * are excluded; identifiers or dates that remain in the original content stay represented.
 *
 * The representation version is `amem-note-v1`. Changing this text requires a declared new version
 * and re-embedding existing records rather than an invisible prompt change.
 *
 * See docs/memory.md#representation.
 */
export const embeddingText = (
  note: Pick<Note, "content" | "context" | "keywords" | "tags">,
): string =>
  `${note.content}\nKeywords: ${note.keywords.join(", ")}\nTags: ${note.tags.join(", ")}\nContext: ${note.context}`;
