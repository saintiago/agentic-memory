# NoteStore design

## Responsibility

Persist current note/vector records, retrieve identities, perform bounded vector search, and expose
paged inspection. There is no permanent note history, in-process corpus mirror or lexical index.

## Interface

This provider owns the shared note data contract. It does not depend on other system components.
The host supplies an immutable embedding-space descriptor at initialization; its fields are data,
not an import of an encoder implementation.

```ts
type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface Attributes {
  context: string;
  keywords: string[];
  tags: string[];
}
interface Note extends Attributes {
  id: string;
  content: string;
  timestamp: string;
  updatedAt?: string; // absent only when the historical update time is unknown
  links: string[];
  metadata?: Record<string, JsonValue>;
}
interface EmbeddedNote {
  note: Note;
  vector: number[];
}
interface Match {
  note: Note;
  score: number;
}
type Cursor = string | number;
interface Page {
  notes: Note[];
  cursor?: Cursor;
}
interface EmbeddedPage {
  records: EmbeddedNote[];
  cursor?: Cursor;
}
interface NoteStore {
  put(records: EmbeddedNote[]): Promise<void>;
  get(ids: string[]): Promise<Note[]>;
  getEmbedded(ids: string[]): Promise<EmbeddedNote[]>;
  nearest(vector: number[], limit: number): Promise<Match[]>;
  page(limit: number, cursor?: Cursor): Promise<Page>;
  pageEmbedded(limit: number, cursor?: Cursor): Promise<EmbeddedPage>;
}
```

`get` omits missing IDs, returns each found ID at most once and makes no ordering promise. Empty
input returns an empty array without a request. `nearest` returns at most the requested count,
ordered by descending cosine similarity; equal-score ordering is unspecified. Scores must be finite.
Pagination returns a provider cursor only when another page may exist; an omitted cursor means
completion. Cursors belong to the current collection/provider, not a portable page numbering scheme.
An unchanged collection must be fully traversable without duplicates or an internal total-count cap.
Concurrent writes can change the traversal; snapshot pagination is not promised.

`getEmbedded` follows `get`'s identity, missing-ID, uniqueness, ordering and empty-input rules,
returning detached complete records with their actual stored vectors. Validate vectors against the
collection's embedding space, as for `pageEmbedded`; a found record with a missing or invalid vector
fails the read. Fetch the requested identities directly without pagination or a collection scan.
It performs no writes or re-embedding. This focused read supports link-only maintenance while
ordinary `get`, `nearest` and `page` remain vector-free.

`pageEmbedded` is the explicit vector-inspection operation. It returns complete current notes and
actual stored vectors, validated against the collection's embedding space, as detached records.
It uses the same limit constraints, cursor rules and traversal guarantees as `page`; cursors must
be continued with the operation that produced them. An empty page may still have a cursor, so
consumers stop only when the cursor is omitted. Missing or invalid vectors fail the operation,
not silently skip a record or trigger re-embedding. It performs no writes, embeddings or generation.
Ordinary `page`, `get` and `nearest` remain vector-free in their responses. Export `EmbeddedPage`
through the public package boundary; the service exposes it to inspection clients through its API.

`put` replaces complete supplied records at their IDs. Empty input is a no-op. Validate the entire
batch before dispatch; duplicate record IDs in one batch are invalid. Return only after acknowledged
application, or throw. This is an upsert primitive, not caller-content conflict detection. It does
not promise a multi-record transaction or guaranteed rollback on failure. Reapplying the same complete
records at the same identities preserves their supplied values, including vectors and update times;
this is the storage property used by durable insertion-plan replay.

## Update time

`updatedAt`, when present, is an ISO 8601 instant with timezone recording when the current note
version was prepared for persistence. It is distinct from the immutable observation `timestamp`.
The writer supplies it; storage preserves it without replacing it with request or acknowledgment
time. It is not a commit timestamp, revision counter, change cursor or evidence of acknowledgment.
The writer owns assignment on actual note changes; the store does not infer those changes.

The optional field permits existing records with unknown historical update time. Absence means
unknown; do not infer a value from observation time, read time or collection opening. Reject null
or malformed values. A supplied observation time may be later than `updatedAt`, so do not impose
ordering between these two clocks.

## Record validation

Define runtime schemas once and derive exported types. Validate records read from storage as well
as records written to it. IDs and links are UUIDs; links are distinct and cannot point to their own
note. Content and context contain non-whitespace text, and timestamp is an ISO 8601 instant with
timezone. Keywords/tags are arrays of nonempty strings; empty arrays are legal. Preserve strings and
array order rather than silently normalizing them. Metadata is optional JSON, with finite numbers.
Reject malformed or unsupported record shapes rather than manufacturing missing fields.

Vectors must have exactly the declared dimensions, contain finite numbers and have nonzero norm.
Search vectors satisfy the same contract. Limits are positive safe integers. Do not validate model
semantics, require a minimum keyword count, fetch link targets on every write, or infer immutability
by first reading every upserted record. Immutability of source fields is the writer's responsibility.

## Qdrant mapping

Use a dedicated collection with one unnamed dense float32 vector, declared dimensions, and cosine
distance. Each point ID is the note UUID, its vector is the prepared embedding, and its payload is
exactly the complete note record. Payload ID must agree with point ID on reads. Current records
replace earlier records; no second database, cache or shadow JSON files participate in runtime
persistence.

Use direct retrieve-by-ID, vector query with a limit, and scroll with its returned cursor. Request
payloads and omit vectors from ordinary reads. Only `pageEmbedded` requests both payloads and
stored vectors through scroll. Upsert batches with `wait: true`. Normal operations must not
first list the collection, rebuild BM25, touch retrieval counters or rewrite records as a read effect.
Expose failures; do not convert transport errors into empty results.

## Collection compatibility

The host explicitly initializes or opens a named collection before operations are exposed. Creation
sets the vector configuration and collection metadata in the same request. Use Qdrant collection
metadata under key `agenticMemory` with this value:

```ts
{
  schemaVersion: 1,
  representation: "amem-note-v1",
  embeddingSpace: { id: string, dimensions: number, distance: "Cosine" }
}
```

`updatedAt` is an additive optional payload field within schema version 1. Opening an existing
compatible collection neither backfills timestamps nor rewrites vectors or collection metadata.
The representation stays `amem-note-v1` because the field is excluded from embedding text. Deploy
readers and the active writer with support for this field before writing it; older binaries are not
promised to accept or preserve the extended payload. No concurrent legacy writer is supported.

The embedding-space ID identifies the exact encoding configuration, not just a model family name.
On open, compare all these values and the actual vector configuration, including its declared
storage datatype and whether it stores multi-vectors. Reject missing, mismatched or unsupported
metadata, even on an existing empty collection. Do not silently adopt a prototype collection,
change a model, mutate an unknown collection's metadata or trigger a rebuild. Use a new collection
for a different space; migration is outside this baseline. Collection metadata is supported by the
selected Qdrant 1.19 baseline. Other metadata keys may exist and are not owned here.

Connection configuration includes URL, optional API key, collection, space descriptor and request
timeout. The HTTP(S) URL's effective port and optional base path apply to initialization and every
operation; an omitted port means 80 for HTTP or 443 for HTTPS. A trailing base-path slash is optional.
Reject malformed URLs, port zero, embedded credentials, query strings and fragments before making
requests; use the API-key setting for credentials. Credentials stay outside records and errors. The
host owns server startup, backups and shutdown. Initialization may create a missing collection; it
never deletes an existing one. A creation race must re-read and validate rather than claim ownership
of incompatible state.

These connection rules are available to a host as `parseQdrantNoteStoreOptions`, which validates
them without contacting Qdrant. A host that binds durable state to a collection, such as the local
memory service binding its ingestion journal, validates first so a malformed endpoint or credential
is rejected before anything is bound to it.

## Verification

Run contract cases against real isolated Qdrant. Prove complete records survive reopening, updates
change search results, pagination reaches a sentinel past 10,000 records, and direct lookup/search
do not rely on pagination. A small-dimensional synthetic corpus is adequate for that correctness
test; it is not a representative embedding-performance benchmark. Test incompatible model identity
at equal dimensions, malformed payloads and actual vector configuration mismatches. Use controlled
transport failures separately to exercise uncertain write acknowledgment. Apply pagination coverage
also to `pageEmbedded`: verify stored vectors and notes survive export/reopen, returned data is
detached, invalid vectors fail, and ordinary reads do not request vectors. Verify legacy records
without `updatedAt` remain readable without backfill, valid values survive round trips and malformed
values fail validation.

Verify `getEmbedded` against isolated real storage: found and missing identities, repeated IDs,
empty input, detached values, preserved stored vectors after reopening and no pagination. Use
controlled malformed responses for missing/invalid vectors rather than silently treating them as
absent notes.
