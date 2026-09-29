/**
 * The read surface of the inspection host: the collection and embedding-space identity the host
 * belongs to, the paginated stored-vector export it projects and the note and search reads its
 * browser API serves. The local memory service is the only implementation; the host never opens
 * a database, loads an encoder or constructs a Memory instance of its own.
 *
 * See docs/dashboard.md#startup-and-composition and docs/service.md#api.
 */
import type {
  EmbeddedNote,
  Note,
  SearchOptions,
  SearchResult,
} from "../src/index.js";

/** The identity the host's projection artifacts must belong to. */
export interface InspectionIdentity {
  readonly collection: string;
  readonly embeddingSpaceId: string;
}

/** One page of stored records; `cursor` is the opaque token of a previous page. */
export interface InspectionPage {
  readonly records: EmbeddedNote[];
  readonly cursor?: string;
}

/** The memory-service reads the inspection host consumes. It never writes or generates. */
export interface InspectionSource {
  /** The collection and embedding space the service currently owns. */
  identity(): Promise<InspectionIdentity>;
  /** One page of complete notes and stored vectors; the cursor token is returned unchanged. */
  pageEmbedded(limit: number, cursor?: string): Promise<InspectionPage>;
  /** One complete current note, or `undefined` when it does not exist. */
  get(id: string): Promise<Note | undefined>;
  /** Memory's complete ordered search results. */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

/** A read the service refused because the request itself is invalid, not because it failed. */
export class InspectionInputError extends Error {
  constructor(cause?: unknown) {
    super("The inspection request is not valid.", { cause });
    this.name = "InspectionInputError";
  }
}
