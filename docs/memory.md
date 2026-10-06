# Memory design

## Responsibility

Own note construction, bounded linking and evolution, and composition of retrieved evidence.
This is the public library API. It accepts already selected source material; it does not extract
events from an application's logs or decide whether an event deserves to be remembered.

## Interface

Dependencies are the provider-owned [NoteStore](note-store.md#interface),
[Embedder](embeddings.md#interface) and [LanguageModel](language-model.md#interface) contracts.
`Note`, `Attributes`, `EmbeddedNote`, `Page` and `Cursor` below are imported from NoteStore's public
interface, and `EmbeddingSpace` from the Embeddings interface.
Composition and dependency lifecycle are described in [architecture](architecture.md#library-composition).

```ts
interface AddInput {
  content: string;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
}
interface PrepareInput {
  noteId: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, JsonValue>;
}
interface InsertionPlan {
  version: 1;
  representation: "amem-note-v1";
  embeddingSpace: EmbeddingSpace;
  noteId: string;
  records: EmbeddedNote[];
}
interface ContextCorrectionInput {
  expected: Note;
  attributes: Attributes;
}
interface ContextCorrectionPreparation {
  note: Note;
  plan?: InsertionPlan;
}
interface ContextCorrectionPreparer {
  prepareContextCorrection(
    input: ContextCorrectionInput,
  ): Promise<ContextCorrectionPreparation>;
}
interface LinkCorrectionInput {
  expected: Note;
  removeTargetIds: string[];
}
interface LinkCorrectionPreparer {
  prepareLinkCorrection(
    input: LinkCorrectionInput,
  ): Promise<InsertionPlan>;
}
interface MemoryPrompts {
  construction: string;
  evolution: string;
}
interface MemoryOptions {
  neighbors?: number;
  prompts?: Partial<MemoryPrompts>;
}
interface SearchOptions {
  limit?: number;
  linkedLimit?: number;
}
type SearchResult =
  { note: Note; via: "match"; score: number } | { note: Note; via: "link" };

class AgenticMemory {
  constructor(
    store: NoteStore,
    embedder: Embedder,
    model: LanguageModel,
    options?: MemoryOptions,
  );
  add(input: AddInput): Promise<Note>;
  prepare(input: PrepareInput): Promise<InsertionPlan>;
  prepareContextCorrection(
    input: ContextCorrectionInput,
  ): Promise<ContextCorrectionPreparation>;
  prepareLinkCorrection(
    input: LinkCorrectionInput,
  ): Promise<InsertionPlan>;
  apply(plan: InsertionPlan): Promise<Note>;
  get(id: string): Promise<Note | undefined>;
  page(limit?: number, cursor?: Cursor): Promise<Page>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}
```

`JsonValue` is NoteStore's JSON value type. Names are public export names; the signatures describe
behavior and do not prescribe private classes. Export `defaultPrompts` as read-only values and
`embeddingText` as the canonical representation function for reproducible evaluations.
Export `contextCorrectionInputSchema` and derive `ContextCorrectionInput` from it so maintenance
hosts validate proposals with the owning contract rather than copying its schema.
Likewise export `linkCorrectionInputSchema` and derive `LinkCorrectionInput` from it. Both focused
preparer contracts are read-only; the host owns exclusivity through preparation and application.

Construction/evolution requests and response schemas are owned here; their complete text and
data envelope are in [prompts](prompts.md). Transport returns parsed, untrusted JSON. No dependency
discovers another dependency or constructs a hidden provider.

## Input and identity

- Content must be a string containing non-whitespace text. Validate without trimming or rewriting
  what is stored. Empty search queries are rejected by the same rule.
- Each accepted add allocates a fresh UUID before any external work. Identical source content is
  allowed; this is not an idempotent ingestion API. No caller-supplied note ID or content comparison.
- Timestamp is a valid ISO 8601 instant with timezone; preserve a supplied value, otherwise use the
  time the queued insertion starts. It records the supplied observation time, not a mutable status.
- Metadata is an optional JSON object. Reject non-JSON values, cycles and non-finite numbers instead
  of silently dropping them. Copy input, nested metadata and options at the call boundary so a
  caller's subsequent mutation cannot change pending work. Return detached records.
- `neighbors` defaults to 5 and must be a positive safe integer. Prompt overrides must be nonempty
  strings. There is no environment-based prompt selection.
- Read IDs must be valid UUIDs. Invalid input fails before an external call. IDs in source text are
  ordinary source material and are not subject to the note-ID rule.

## Insertion decisions

Serialize add operations in invocation order within one instance, including candidate selection.
Do not compute a candidate set while an earlier insertion is still pending. A rejected operation
does not poison the queue. Hosts must await writes and handle uncertain outcomes before submitting
more work; this queue is not a durable job system or a distributed writer lock.

For a constructed note, preserve original content, ID, timestamp and metadata throughout the
operation. Its initial links are empty. Validate the construction attributes before further work.
Consider up to the configured number of nearest existing notes, without a score threshold, domain
filter, ticket grouping or second search. Skip the evolution invocation when no candidates exist.

Interpret a single evolution response as follows:

- `links` selects outgoing links from the new note to candidates. Deduplicate repeated link IDs in
  their first occurrence order. Reject a non-candidate ID.
- `newTags` replaces the incoming note's entire tag list, including an empty list. The evolution
  step does not change its constructed context or keywords.
- Each `updates` entry replaces one candidate's context, keywords and tags. Reject unknown IDs and
  repeated update IDs. An updated note need not also be selected as a link.
- Preserve each existing note's links, source, timestamp, metadata and ID. Do not create reciprocal
  links, merge notes, delete notes or evolve additional neighbors recursively.
- Omit a proposed update whose canonical embedding text is unchanged. Re-embed every other updated
  note. Reuse the incoming initial vector unless its final embedding text differs, in which case
  embed it again. Link-only changes need no additional embedding.

Finish all interpretation, validation and required vector preparation before issuing one batch
write containing the changed neighbors and incoming note. Return the final incoming note only after
the write is acknowledged. No construction-only note is published before evolution completes.

## Update time

After all interpretation and embedding work succeeds, immediately before the final batch write,
sample the host wall clock once as a UTC ISO instant. Assign it as `updatedAt` to the incoming note
and each actually changed neighbor in that batch. The input API does not accept an update time;
it is runtime bookkeeping, not model output or source provenance.

An omitted no-op evolution update preserves the neighbor's prior `updatedAt`, including absence
on a legacy note. Reads, searches and inspection do not advance it. The first real evolution of a
legacy note establishes its update time; insertion always supplies one. Do not alter the source
`timestamp`. The field is excluded from model instructions as semantic evidence and from canonical
embedding text, so setting it alone never requires re-embedding.

A rejected write retains the existing uncertain-outcome contract. Its proposed timestamp does not
prove a record was committed, nor that every record in a batch was applied. Wall-clock time is not
an ordering or synchronization primitive; callers must not use it as a pagination/change cursor.

## Representation

The exact canonical text, with LF separators and no extra prefix or final newline, is:

```ts
`${content}\nKeywords: ${keywords.join(", ")}\nTags: ${tags.join(", ")}\nContext: ${context}`;
```

Preserve attribute order. IDs, `timestamp`, `updatedAt`, links and metadata are excluded as separate fields;
identifiers or dates already in original content remain represented. Moving an identifier to
metadata only reduces its embedding influence if it is also removed from embedded text. Keeping
identifiers out of generated context merely avoids repeating them.

Representation version is `amem-note-v1`. Changing this representation requires a declared new
version and re-embedding existing records; it is not an invisible prompt change. Query text is
embedded as supplied, with no generated keywords, rewriting, answer or retrieval-time model call.

## Retrieval and inspection

`get` returns the complete current note or `undefined`. `page` defaults to 100 notes, accepts a
positive safe integer limit, and forwards the opaque cursor. Neither operation generates text or
modifies a record. Pagination is for inspection/export; ordinary add and search never traverse it.

Search defaults to 5 direct matches and at most 5 linked additions. Direct limit is a positive safe
integer; linked limit is a nonnegative safe integer. A linked limit of zero disables expansion.

Keep similarity match order and scores unchanged. Walk those matches in rank order and their
outgoing links in stored order. Select distinct IDs not already in the direct results until the
linked budget is exhausted, then fetch them by identity. Append fetched notes in selection order,
without a score. A missing linked target is skipped without filling its place from further links.
Do not follow links of linked additions, traverse reverse edges, rerank or apply a score threshold.
Return at most `limit + linkedLimit` distinct full notes. A failed fetch is an operation error, not
a missing-note result or a silently truncated success.

Original content, context, keywords, tags, links, timestamp, optional updatedAt and metadata are available to the host.
The host chooses what goes into an agent's context. Similarity scores and links do not assert truth,
applicability, supersession or independent verification. Reads can observe different points in an
insertion's writes; no multi-note snapshot is promised.

## Failures

Expose a typed `MemoryError` with `operation` (`add`, `prepare`, `prepareContextCorrection`,
`prepareLinkCorrection`, `apply`, `get`, `page`, `search`), `stage`, a safe `reason` and message,
and `persistence` (`unchanged` or `uncertain`). An insertion
error after ID allocation also includes `noteId`; a write-attempt error includes `affectedNoteIds`
for the prepared batch. A failed context- or link-correction read also includes `readOutcome`:
`stale` for a read that confirmed a missing or mismatched inspected note, `unknown` for a read that
failed before observing valid storage, so a maintenance owner never reports an unreadable store as
staleness. Preserve
the underlying cause for diagnosis without embedding credentials or complete prompts in public
messages. The cause keeps the provider's own failure contract, including a model transport's
machine-readable category, so a caller can classify the failure without reading provider text.

Stages are `input`, `construct`, `embed`, `candidates`, `evolve`, `persist`, `read`. Model schema
failures use the corresponding model stage. All failures before a write attempt are `unchanged`.
Any rejected/interrupted write attempt is conservatively `uncertain`, even if the provider might
have applied none of it. Reads never write and therefore report `unchanged`.

There is no automatic response repair, silent default, whole-operation retry or rollback. In
particular, retrying `add` creates a fresh ID and can duplicate an uncertain insertion. The host
must stop its ingestion, inspect the affected IDs and its retained source input, and decide how to
reconcile storage before resuming. This baseline provides diagnosis, not automatic crash recovery,
exactly-once ingestion or reconstruction of an interrupted evolution plan.

## Durable preparation and application

The [ingestion queue interface](ingestion-queue.md#interface) also requires public prepare/apply
operations. Preparation uses the same construction and evolution rules as add, accepts the durable
operation's fixed note ID and timestamp, and returns one immutable plan with its declared
representation, embedding space and complete records, without writes. Application rejects a plan of
another schema version, representation or embedding space before any write, requires the plan's
`noteId` among the records and one record per identity, and then writes the exact supplied records
without regeneration. Reapplying the same plan preserves identities, vectors and timestamps; the
declared embedding space is the instance's own, while the queue binds the collection. The queue owns
exclusivity and plan durability; raw add's uncertain-failure behavior above remains unchanged.
The existing version-1 plan format and `apply` also serve prepared context and link corrections: `noteId`
identifies the existing note returned after application. Its export name remains `InsertionPlan`
for compatibility. Applying a trusted prepared batch does not infer whether its anchor is new.

## Existing-context correction

Support controlled correction of identified existing contexts that violate the
[source-focused evolution guidance](prompts.md#evolution-instructions). Derive the corrected meaning
from immutable original sources and any relevant, attributed supporting sources, rather than treating
an expanded generated context as evidence. Preserve supported conclusions, applicability and caveats.
This is targeted maintenance, not automatic corpus-wide rewriting or a permanent revision store.

Preserve note identity, original content, source timestamp, metadata and existing links. Update
semantic attributes and their embeddings consistently under the current representation and embedding
space; unchanged records remain unchanged. Apply the existing update-time and write-uncertainty rules.
Correction must respect collection writer ownership and must not introduce a competing direct writer.
Preservation and before/after evidence follow
[the quality evaluation](evaluation.md#quality-change-acceptance).

`prepareContextCorrection` accepts one complete inspected note as `expected` and the operator's
reviewed replacement attributes. Validate and detach both using the existing note and attribute
schemas before external work. Read the current note by `expected.id`; a missing note or any mismatch
with `expected` rejects as an unchanged `read` failure. Compare complete values, including links,
metadata and optional update time, independent of JSON object key order. Update time alone is not
a revision token. The host must hold writer ownership throughout this read, preparation and application.
Serialize this preparation with add/prepare/apply in invocation order within the instance; reads
retain their ordinary concurrency. A stale proposal does not poison later operations.

Use current immutable fields and links, replacing only context, keywords and tags. Equal attributes
return the detached current note without a plan, embedding or new update time. Otherwise embed the
canonical revised representation, validate its vector, sample update time after successful preparation,
and return the revised note and a one-record version-1 plan. There is no construction, nearest search,
model call or neighbor evolution. The operator derives replacement meaning from sources; the API
checks structural validity and staleness, not semantic truth. Preparation never writes.

Preparation failures carry `operation: prepareContextCorrection`, the selected `noteId`, the relevant
`input`, `read` or `embed` stage and `persistence: unchanged`. A `read` failure carries `readOutcome`
so the caller can tell a confirmed stale proposal from a read that could not observe storage. Apply
retains its existing validation, acknowledgment and uncertain-write behavior. The provider-owned
`ContextCorrectionPreparer` is the focused read-only capability supplied to a maintenance owner;
ordinary ingestion still needs only `prepare` and `apply`.

## Existing-link correction

Support targeted operator maintenance only for directed edges proven incorrect by
[original-source review](evaluation.md#historical-link-correction). The reviewed change identifies
the exact source note, outgoing target identities to remove and inspected current state. Remove
only those edges, retaining the order of all remaining links. Preserve both endpoint notes,
original content, identity, source timestamp, metadata, semantic attributes and embeddings;
unaffected records and other incoming or outgoing relationships remain unchanged. Apply the
existing update-time rules to actual changes. This capability does not change insertion, evolution,
search or [context correction's link preservation](#existing-context-correction).

Use the existing collection writer ownership and uncertain-write protections. A stale proposal
must not overwrite intervening changes; invalid or stale input leaves storage unchanged. Report
success only after the removal is acknowledged. Interrupted application remains unresolved until
maintenance recovery establishes the persisted outcome, including after restart, without
regenerating semantic attributes or changing unrelated relationships. This is separate from the
context-correction input and does not permit raw competing writes. Implement this capability only
when the source review warrants removals; a supported no-removal outcome needs no capability.

`prepareLinkCorrection` accepts the complete inspected source note as `expected` and a nonempty
list of distinct outgoing `removeTargetIds`. Validate and detach at the call boundary using the
owned input schema: target IDs must be UUIDs already present in `expected.links`; duplicates and
empty removal sets are invalid rather than silently becoming no-ops. Identity comparisons follow
the existing UUID rules. The proposal cannot supply replacement attributes, vectors or update time.
Review of both endpoint sources and the removal rationale stays in private evaluation evidence;
the API establishes structural validity and freshness, not semantic truth.

Serialize preparation with add/prepare/context correction/apply. Under host-held writer ownership,
read the source's complete current stored record by identity through the vector-bearing read in
the provider interface. Compare its entire note with `expected`, using the context-correction
value-comparison rules. A missing or mismatched source rejects with
`operation: prepareLinkCorrection`, `stage: read`, `readOutcome: stale` and
`persistence: unchanged`. A failed
read, including an unusable stored vector, instead has `readOutcome: unknown`; it does not prove
the inspected note stale. Invalid input fails at `input`, before provider work.

Filter only the selected outgoing IDs, preserving remaining link order and all other note fields
except `updatedAt`. Sample update time after successful read/validation and return a detached
one-record version-1 plan containing the changed note and actual stored vector unchanged. Unlike
context correction, every valid removal changes the note, so no separate no-op preparation result
or duplicated note/result wrapper is needed.
There is no collection scan, embedding, nearest search, model invocation, target write or neighbor
evolution. Preparation never writes. The existing `apply` contract applies or replays that exact
plan; the maintenance owner holds writer ownership until its durable outcome is recorded.

## Verification

Apply [testing](testing.md#main-risks-and-ownership) to this contract. Include unchanged neighbors,
tag-only changes, empty candidates, duplicate/unknown update IDs, a failed final embedding, copied
pending input, queue continuation, and an uncertain write. Assert read-only retrieval and the exact
one-hop budget/order behavior, including missing targets. With a controlled clock, verify insertion and actually changed neighbors
receive the batch preparation time, no-op neighbors retain their time, legacy notes acquire it only
on real evolution, and failures/reads do not invent successful updates. Schema-valid prose is evaluated separately;
do not turn semantic preferences into hidden rejection rules.
For correction, verify stale/missing-note rejection, detached proposals, invalid attributes or
vectors before writes, source/link preservation, the no-op path and identity-preserving plan replay.
For link correction, verify exact directed removal, remaining order, complete source freshness,
detached inputs/results, invalid/empty/duplicate/missing-target refusal, stale versus failed-read
outcomes, stored-vector preservation without encoding, update time and replay of the actual plan.
