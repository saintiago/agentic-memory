# Durable ingestion queue

## Purpose and scope

Accept observations from several local processes without making their callers wait for model,
embedding or database operations. Preserve accepted work across producer, worker and database
crashes. One worker mutates each collection at a time; submissions and reads remain concurrent.
This is a single-host service with durable local storage, not distributed writer coordination.

## Interface

The queue accepts a caller-owned source key, content, optional observation timestamp and opaque
provenance. Submission resolves only after durable local acceptance and returns a receipt identity,
current status and whether this call created the receipt. It does not require the model, encoder or
database to be available. A storage failure returns an explicit rejection; an unacknowledged
submission may safely be submitted again.

```ts
interface QueueBinding {
  endpoint: string;
  collection: string;
  embeddingSpace: EmbeddingSpace;
}
interface QueueObservation {
  sourceKey: string;
  content: string;
  timestamp?: string;
  provenance?: Record<string, JsonValue>;
}
interface IngestionQueue {
  readonly binding: QueueBinding;
  readonly journalPath: string;
  submit(observation: QueueObservation): Promise<QueueSubmission>;
  receipt(id: string): Promise<QueueReceipt | undefined>;
  pageReceipts(
    limit?: number,
    cursor?: string,
  ): Promise<{ receipts: QueueReceipt[]; cursor?: string }>;
  status(): Promise<QueueStatus>;
  importLegacyReceipts(
    records: readonly LegacyReceipt[],
  ): Promise<LegacyImportResult>;
  reconcile(id: string, outcome: ReconcileOutcome): Promise<QueueReceipt>;
  recoverFailed(
    id: string,
    input: { expectedAttemptCount: number },
  ): Promise<QueueRecovery>;
  correctContext(
    input: ContextCorrectionInput,
    preparer: ContextCorrectionPreparer,
  ): Promise<{ note: Note; changed: boolean }>;
  correctLinks(
    input: LinkCorrectionInput,
    preparer: LinkCorrectionPreparer,
  ): Promise<{ note: Note; changed: true }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
```

`openIngestionQueue` opens or creates one journal in the host's durable directory, records the
binding it was first opened with, and refuses another endpoint, collection, embedding space or
representation. Receipt objects, statuses, status counts and migration records are the exported
schemas of this component; `EmbeddingSpace`, `JsonValue` and `EmbeddedNote` come from the
Embeddings and NoteStore public interfaces.

One submission outcome is the receipt plus a `created` flag, so a client can tell a new durable
acceptance from an identical resubmission that found the existing receipt:

```ts
interface QueueSubmission extends QueueReceipt {
  created: boolean;
}
interface QueueRecovery {
  receipt: QueueReceipt;
  recovered: boolean;
}
interface QueueRecoveryEvidence {
  requestedAt: string;
  attemptCount: number;
  lastError: string;
}
```

Receipt lookup returns status, attempt count, safe last error, next retry time when applicable,
and note identity once stored. Statuses are `queued`, `processing`, `retrying`, `stored`, `failed`
and `blocked`. Acceptance is not a promise that the note is already searchable.
The optional receipt field `recoveries: QueueRecoveryEvidence[]` retains the previous failed
attempt's safe error and cumulative attempt count for each effective recovery. Omit it when there
have been no recoveries; duplicate requests append nothing. It is receipt evidence, not note metadata.
`pageReceipts` defaults to 100, validates a positive safe integer limit and an opaque journal-owned
cursor, and returns current receipts in acceptance-sequence order. Omit the next cursor at completion;
continuing an unchanged journal traverses all receipts without duplicates or an internal total cap.
It is read-only, includes every outcome and exposes no raw source payloads or plans. Status changes
and new acceptances during traversal are not a snapshot. Clients can select failures locally without
a new filter language; source keys and receipt IDs identify retained work.

The worker consumes Memory's public prepare/apply operations. Preparation accepts a previously
allocated note identity and returns an immutable, versioned insertion plan without writing notes.
The plan contains the complete new and changed note/vector records. Apply writes that exact plan
through NoteStore's public `put` contract, without model generation or fresh timestamps. These
operations share the ordinary add algorithm; the host must not reimplement evolution or import
private library internals. Raw add remains available for independently owned collections.
`ContextCorrectionInput`, `ContextCorrectionPreparer`, `LinkCorrectionInput`,
`LinkCorrectionPreparer` and their prepared results come from [Memory's public interface](memory.md#interface);
`Note` comes from NoteStore. Each focused preparer is supplied only to its corresponding maintenance
operation. Startup replay uses the existing apply capability. The queue checks returned plans
against its binding and the selected note identity. Each correction plan contains exactly that
one record. Context correction preserves inspected source fields and links; link correction
preserves inspected source fields and semantic attributes and applies exactly the selected removals
in remaining stored order. Link preparation returns the plan directly, without a separate note wrapper.
Memory owns stored-vector preparation; the queue validates the plan's space and vector shape
without reading the collection or duplicating Memory's freshness comparison.

The [local memory service](service.md) owns HTTP access and provider lifecycle; the host supervises
that service. Producers submit through its API rather than opening queue files. The API can accept
work while the ingestion worker or providers are unavailable, but a stopped service cannot accept
requests. Clients retain unacknowledged source observations and resubmit the same identity after
reconnection. Nexus-specific extraction and workflow decisions remain outside this component.

## Durable acceptance and ordering

Bind each queue to one canonical database endpoint, collection, embedding space and representation
version. All producers of that collection share this queue. Reject incompatible bindings before
processing; direct or external writes to a queue-owned collection are unsupported.

Use a local SQLite journal with transactional submissions and durable commits. Store it outside
temporary and task directories. A unique source key identifies one accepted observation. An
identical resubmission returns its existing receipt; changed content or provenance under that key
is a conflict. Fix an omitted observation timestamp and allocate the note UUID at first acceptance.
Retain both across retries. Keep completed source keys so replay cannot create duplicate notes.

Assign a monotonically increasing sequence on acceptance. Drain in that order. A transient failure
retains its position; later observations do not overtake an unresolved write. A permanent failure
before any note write is marked failed and allows later work to proceed. Never silently discard
pending work. Disk exhaustion rejects new submissions without deleting accepted observations.

## Writer lifecycle and retries

Acquire one process-scoped OS advisory lock per queue for the worker lifetime. A second worker
must not drain it, including when a handle names the journal file through a filesystem alias:
ownership follows the journal file's canonical identity. Release ownership on process exit, not
through a time-based lease or stale-lock stealing. Queue submission uses short database transactions
and never waits for a model call or holds a transaction across external work. Journal work runs on
the queue's own thread, so a contended lock or a slow durable commit never blocks a producer's event
loop. Closing a producer settles submissions, not the backlog.

The worker starts independently of producer lifetimes and polls for durable pending work, including
work submitted while it was stopped. A supervised worker restarts after failure. On graceful stop,
stop claiming work and settle the active operation; forced termination uses the recovery rules below.
Do not start the database implicitly. While it is unavailable, retain work and retry with bounded
exponential backoff (1 second initially, doubling to 60 seconds). Retain attempts and retry timing
across restarts. Transport failures, rate limits and temporary provider unavailability are retryable;
invalid input or model output fails explicitly. Invalid credentials or incompatible storage block
processing with an actionable diagnostic until corrected. No tight retry loop or retry count that
silently drops accepted work is allowed.

A model transport reports failures with a machine-readable category
([language model](language-model.md#transport-behavior)). A rejected credential or a missing
provider resource blocks the receipt with a safe diagnostic and is retried only at the retry limit
until the host corrects the configuration; unusable model output ends the current processing attempt
as a failed receipt, retained for explicit recovery below; a
temporary provider or transport failure is retried. A storage failure that reports an unauthorized,
forbidden or missing resource (an HTTP status of 401, 403 or 404 on the failure or one of its
causes) is that credential or storage condition and blocks the same way. Reconciliation, not
automatic retry, clears a plan the queue cannot read or apply.

## Crash recovery

1. Commit acceptance before acknowledging the producer. If acknowledgement is lost, resubmission
   finds the same receipt. This guarantee begins at acceptance, not at an upstream business event.
2. Mark the receipt processing and prepare the insertion without note writes. If interrupted before
   a complete plan is durably committed, restart preparation with the same note ID and observation.
3. Commit the complete plan before attempting any note write. Include all generated attributes,
   links, vectors, affected identities and fixed update timestamps. A partial journal transaction
   must never look like a complete plan. Commit the evidence that a complete plan existed together
   with it, so restart can tell preparation that never finished — preparation restarts — from a
   committed plan the journal no longer holds, which blocks for reconciliation instead.
4. Apply the plan and wait for storage acknowledgement before marking the receipt stored. If the
   worker or database crashes during application, or acknowledgement is lost, replay the exact plan
   before processing any later item. Identity-preserving replacement makes this replay idempotent.
   Finding only the new note is insufficient: all prepared neighbor updates must also be applied.
5. A crash after storage acknowledgement but before the stored receipt is committed follows the
   same replay rule. Completed receipts are not reprocessed. The temporary plan may be removed only
   after durable completion; retain the source key, input and completion evidence.

Recovery requires the journal and collection to survive. Missing/corrupt or incompatible plans,
uncoordinated writes, or restoring only one side from backup block the queue for reconciliation;
do not infer success or call add with a new identity. Backup/restore must preserve a consistent pair.
Reads can observe intermediate note updates during application and replay; no multi-note atomic
visibility or exactly-once provider execution is promised.

## Existing receipts

Import preserved pending observations that are known not to have written using their original source
keys, inputs and timestamps. Import is idempotent and does not scan historical workspaces. Existing
stored receipts preserve their completed identity. Legacy in-flight or uncertain receipts without a
durable plan require reconciliation before further collection writes; the new recovery guarantee
cannot reconstruct a plan that was never saved. Stop old writers during migration and remove their
competing ingestion path before starting the queue worker. Imports take the same exclusive ownership
as draining and reject with `QueueWorkerLockedError` while a worker or another import owns it; stop
the worker before importing, including for reimports. Ownership is held through the import commit
so worker startup cannot overlap migration.

An unresolved legacy uncertainty blocks every further collection write, whatever its position in
the drain order and whatever a batch also contains: the legacy mutation may have changed the state
that any later write would evolve. Reimporting a legacy record whose observation text matches an
accepted receipt stays idempotent only while the recorded outcomes agree. An uncertain record that
names an observation the queue has not written turns that receipt into a reconciliation block, an
operator decision leaves the receipt as it is, and a disagreeing completed identity is refused as a
conflict. Preparation in progress or a committed queue plan does not resolve the outcome of a
separate legacy insertion, even when it names the same note ID. Uncertain legacy evidence is never
treated as a known-unwritten observation.

One blocked receipt is reconciled explicitly: `stored` records the completed note identity, and
`not-written` clears the unusable plan so preparation restarts with the accepted note identity and
observation. Until then the blocked receipt keeps its place, so no later observation is written.
Claiming and reconciliation serialize through journal transactions, including across handles: a
completed `stored` decision cannot be undone by a previously selected retry. If the worker claims
first, the receipt is processing and reconciliation rejects because it is no longer blocked.

## Recovery of failed observations

After the cause is corrected, an operator can explicitly return a retained failed observation that
is known not to have attempted any note write to processing. Preserve its receipt, source key,
accepted content, provenance, observation timestamp, allocated note identity and prior attempt
accounting. An identical producer resubmission still returns the receipt; it does not implicitly
restart failed work. Do not manufacture a new source key or call raw add to recover it.

Recovered work goes through normal preparation against the current corpus and the same exclusive
writer. Retain the original acceptance sequence: recovery returns to that position among unclaimed
work; already completed later observations are not undone to recreate the old neighborhood.
Once pending again, ordinary drain and crash-recovery guarantees
apply. Repeating a recovery request must not create duplicate pending work or reprocess a stored
receipt. If output remains unusable, report failure without publishing malformed or partial results.

An uncertain write, a committed plan or unresolved legacy evidence is not a known-unwritten failure.
Use the existing plan replay or reconciliation rules instead. Keep acceptance, failed outcomes and
recovered storage separately visible; an empty backlog never proves all accepted sources were stored.
`recoverFailed` validates a receipt UUID and a nonnegative safe integer `expectedAttemptCount`,
taken from the operator's inspected receipt. In one journal transaction, require a `failed` receipt
with that count, no plan, no committed-plan evidence and no unresolved legacy uncertainty. Refuse
recovery while any receipt is processing, an unresolved committed insertion plan exists, a
correction is pending, or global legacy reconciliation is required. This keeps an earlier recovered
sequence from overtaking a later interrupted write. Settle/replay or reconcile that work first.
Claiming rechecks the earliest eligible sequence transactionally, so selection before a recovery
commit cannot claim the old head afterward.

On an effective request, append recovery evidence, change status to `queued`, clear current error
and retry timing, and update receipt time. Preserve acceptance time, observation fields, allocated
note ID, sequence and cumulative attempts. Increment attempts only at the ordinary claim boundary.
Commit before returning `{ receipt, recovered: true }`; wake the worker without waiting for ingestion.
Producer acceptance and accepted counts do not increase.

A repeat carrying the same inspected count returns `{ receipt, recovered: false }` if the receipt
is already pending or stored, or a later failed attempt has increased its count. It does not resume
that later failure: the operator must inspect it and explicitly request its new count. A future
count, a blocked/ineligible receipt or the write-safety conditions above produces a typed conflict
with a safe reason; an unknown receipt is a typed not-found error. Validate eligibility from durable
state, not error text. Concurrent requests serialize; only one effective transition records evidence.
The receipt's recovery evidence survives successful storage even though its current `lastError` clears.
Check the count and ineffective-repeat cases before the safety guards for an effective transition;
returning the current receipt performs no write and does not claim that a blocked write was resolved.

## Context maintenance

`correctContext` and `correctLinks` are stopped-worker maintenance operations, not observation
submissions. They share the same ownership, pending slot and recovery path. Acquire
the same canonical journal lock as draining/import, refusing while another owner holds it, and hold
it through preparation, plan commit, application and durable completion. Submissions can still be
accepted, but they cannot drain during maintenance. Refuse new correction while there is a pending
correction, unresolved legacy uncertainty, or any unresolved committed insertion plan; resolve those
before reading a correction's expected state. Pending known-unwritten observations can wait.

Prepare exactly one reviewed correction through the supplied read-only capability. A context no-op returns
`{ note, changed: false }` without a journal plan. Otherwise validate the complete one-record plan
and commit it into one journal-owned pending-correction slot before applying any note write. The slot
contains selected note ID, complete serialized plan, cumulative application attempts, persisted retry
timing and a safe last error when applicable. Do not
create an observation receipt/source key, modify ingestion attempt counts, or retain runtime note history.
Return `{ note, changed: true }` only after application acknowledgment and durable clearing of the slot.
An unsuccessful preparation leaves notes unchanged and creates no slot.

`correctLinks` uses the separately owned link input/preparer and returns `{ note, changed: true }`
only after the same acknowledgment and durable completion. Empty removals are invalid under the
input contract, so it has no no-op branch. New link preparation cannot pass the context-preservation
check: validate the link-removal contract for this action instead. Share commit/application/recovery
where the responsibility is identical; do not add another journal, slot, receipt kind or plan format.

A pending slot holds every later mutation, including failed-receipt recovery and another correction.
Legacy imports also refuse a pending slot, so they cannot introduce uncertainty ahead of its replay.
After a crash, startup under writer ownership replays the exact correction plan before draining any
observations. Preparation is never repeated once the slot commits. Transient application failures
use the existing bounded backoff, retaining attempt count and next retry time across restarts.
Record attempts before application; a blocking error has no scheduled retry. Incompatible, unreadable
or missing plan data blocks with a safe
diagnostic. Never clear that block by generating a new correction; correct configuration or restore
the consistent journal/collection backup. Slot existence itself is committed-plan evidence, so a
slot with missing plan data cannot look like unstarted preparation. Clearing occurs only after
acknowledgment; a crash before clearing replays the same values, vector and update time. A journal
failure that prevents recording an attempt's outcome leaves the slot pending without durable
failure evidence; report that unconfirmed correction as a state conflict, never as a settled
failure or a completed correction.

`status()` includes optional `correction: { noteId, lastError? }` while the slot exists, for either
maintenance action. This replaces the context-specific `contextCorrection` field; service response
schemas, client validation, OpenAPI and availability handling must use the same contract together.
No kind discriminator is needed for replay: both actions apply the complete stored plan. The private
proposal identifies the reviewed operation and removal targets.
Observation counts/backlog retain their current meaning; the pending correction is separately visible
and keeps ingestion unavailable until resolved. A lost maintenance response is not success: inspect
the pending slot and complete current note, resume exact replay if pending, and compare the full
reviewed result, including links, attributes and source fields if already completed. Do not infer
completion merely from note ID.

## Journal upgrade

Add receipt recovery evidence and the singleton correction slot in one transactional journal-schema
upgrade under exclusive writer ownership. Stop old service/worker binaries before upgrade; refuse
upgrade from a producer-only handle while an old worker owns the journal. Initialize existing
receipts with no recovery evidence, not an invented history, and no pending correction. Preserve all
bindings, acceptance sequences, identities, inputs, attempts, plan data and committed-plan/legacy
flags. Refuse unknown schema versions and downgrade; use the matched service/client/library build.
No collection schema or representation change, corpus reset or vector backfill accompanies this upgrade.

Link correction reuses the existing slot data unchanged and requires no further journal-schema
upgrade. Existing pending context plans replay with their original values, attempts and error
evidence. Stop old binaries and deploy the matched queue/service/client build for the generalized
status field; old status consumers are not promised compatibility with the replaced field.

## Visibility and verification

Expose backlog size, oldest pending age, worker availability and receipt outcomes. Report accepted,
stored, retrying and blocked distinctly. Worker availability and the safe diagnostic that holds the
backlog are properties of the queue, not of the handle that reports them, and a reopened queue still
explains a durable block. The graph shows persisted notes; queued observations are not graph nodes.
The service invalidates the projected dashboard view after a completed write, so stored notes
appear without a page reload.

Verify concurrent unique submissions and duplicate keys; acceptance during provider/worker outage;
producer exit after acknowledgement; worker exclusion; and restart at every boundary above. Inject
a partial batch write and lost acknowledgement, then verify one new note identity, every intended
neighbor update and unchanged timestamps after replay. Check retry delay, corrupt-plan blocking,
disk-full rejection, idempotent receipt migration and concurrent reads. Verify that a filesystem
alias of the journal cannot start a second worker, that a committed plan a damaged journal lost
blocks instead of preparing again, that an unresolved legacy uncertainty holds every write whatever
its order, and that a shutdown which arrives during startup settles. Verify that a scheduled timer
still runs while another connection holds the journal's write lock, so journal contention never
blocks a producer's event loop. Do not equate a visible new note with successful completion of the
whole insertion.
Also verify recovery request races/stale counts, evidence after storage, original-position scheduling,
refusal during interrupted later writes, and restart after requeue. Verify maintenance lock exclusion,
preparation/no-op failure paths, pending-slot status, crash after plan commit or application, exact
correction replay before later insertion, corrupt-slot blocking and preservation through journal upgrade.
