# Replay, retrieval evaluation and inspection

## Purpose and boundary

The evaluation tools consume public APIs. They replay a source stream, expose resulting notes and
links, and test the memories returned for known questions. They do not implement another memory
algorithm, reach into provider internals, or become dependencies of the runtime library.

Private source corpora and run outputs stay outside the public repository. Commit small synthetic
fixtures authored for this project and their expected source IDs. Do not copy private workspace logs
or assume that a public driving handbook permits republishing adapted text under any license.
Source labels are examples of applicability, not legal advice or a driving-rule validation service.

The tools live in [experiments](../experiments/README.md): a deterministic in-memory demonstration
and an opt-in live run over real Qdrant and a host model transport. The demonstration and the live
run both write one run directory per run and print the measurement report.

## Input contract and extraction

Read ordered JSONL entries of this form:

```ts
interface SourceEntry {
  sourceId: string;
  content: string;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
}
interface QueryCase {
  id: string;
  query: string;
  requiredSourceIds: string[];
  scope?: string;
  rationale: string;
}
```

`sourceId` is unique within a fixture and is mapped in run artifacts to the generated note UUID. It
is not a caller-owned runtime note ID or content deduplication key. Query expectations refer to source
IDs, allowing comparisons across fresh UUIDs and repeated runs. Missing source IDs and duplicate
fixture/query IDs fail fixture validation before paid work.

Extraction belongs to the source application's adapter. Deterministic extraction means selecting
defined artifact fields and rendering attributed source text consistently, not asking a model to
read every log and discover experiences. Select observations according to the
[charter's source-selection guidance](project-charter.md#vision), rather than turning every artifact
or workflow outcome into a memory. A reusable observation in a developer report, individual reviewer
finding or developer response can form a separate note. Keep each statement's
speaker, conditions and subject in its content. Do not imply that a developer response verifies a
reviewer finding or that chronological adjacency proves a relationship.

For example, an adapter may render a finding's title, explanation and evidence as one source entry,
and later render the developer's response and stated outcome as another. Artifact path, field
location, source event ID and extraction version are useful optional provenance. Subject identifiers
may remain in source content where they express relationships. No Nexus filenames or round schema
belong in the library contract. An adapter's extraction rules must live with that adapter.

Define expected evidence and queries before running insertion. Never insert exam questions, answer
keys or expected retrieval targets as memories. Review source paraphrases for ambiguity before
judging model output against them.

## Run artifacts

Create a separate directory per run with these logical artifacts (JSON/JSONL, UTF-8):

| Artifact             | Required contents                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`      | Run ID, code revision, input/query hashes, insertion order, seed/resume provenance if any, exact prompt text, model endpoint identity without credentials, model ID/settings including thinking, output budget/timeout, declared live call/token budget when one was declared, encoder settings/space ID, storage version/configuration, hardware and timing conditions |
| `sources.jsonl`      | Supplied entries and source-to-note mapping; private unless explicitly chosen for publication                                                                                                                                                                                                                                                                           |
| `calls.jsonl`        | Stage, source/note identity, full request and raw response when enabled, parsed response/error, duration, finish reason, usage including cached input if available; record failed calls too                                                                                                                                                                             |
| `construction.jsonl` | Attributes immediately after successful construction, before evolution; correlated to source ID                                                                                                                                                                                                                                                                         |
| `changes.jsonl`      | Before/after current-note snapshots for each successful insertion and its changed neighbors, including links; failed/uncertain operations recorded separately                                                                                                                                                                                                           |
| `notes.jsonl`        | Complete final notes exported through pagination, plus source mapping                                                                                                                                                                                                                                                                                                   |
| `retrieval.jsonl`    | Query and mode, expected IDs, full ordered results, direct scores and link origin classification, latency and returned text size                                                                                                                                                                                                                                        |
| `report.json`        | Counts and metrics with denominators, failures, input exclusions, semantic review findings, timings, usage and clearly labeled extrapolations                                                                                                                                                                                                                           |

Remove configured provider credentials from every saved artifact, including parsed responses,
assembled prompts, diagnostics and derived note snapshots, whether raw recording is enabled or
disabled. Sanitize evidence copies only; transport, memory processing and measurements use the
original values. Consequently, hashes and text lengths describe the original data and may differ
from redacted evidence. Printed reports use the saved, redacted report.

Instrument host-supplied contracts to capture construction, usage and proposed writes. A prepared
write is not a committed snapshot until acknowledged. This is experiment history, not a runtime
revision store. Use public get/page operations to verify persisted state after the run.
`sources.jsonl` accounts for every supplied entry and the identity an insertion allocated, so a
failed or stopped run keeps its whole input and a construction that succeeded before a later
failure stays recorded. `notes.jsonl` exports every note public pagination returns, including a
batch whose acknowledgment was lost, without presenting that batch as acknowledged.

Preserve existing run directories. A fresh replay uses a new isolated collection; clearing data is
allowed only for the runner's explicitly named disposable collection. Resuming from a saved seed
must be labeled and must not be compared as though all notes were regenerated under the new prompt.
Observe runtime uncertain-write outcomes; do not add automatic resume of an ambiguous insertion.

## Comparison modes

For the same source set and query text, compare:

1. **Original content:** embed only immutable source content.
2. **Constructed:** use each note's first generated attributes before evolution.
3. **Evolved, direct:** use the final stored representation with linked expansion disabled.
4. **Evolved, linked:** use the same final direct matches with bounded one-hop expansion enabled.

Materialize separate evaluation collections when representations differ. Mark them as evaluation
baselines with distinct representation identities; do not open a raw-content collection as a normal
`amem-note-v1` runtime collection. Use identical encoder settings, direct limits and query encoding.
The raw baseline needs no construction calls; constructed results can reuse captured construction
attributes. Do not use final evolved attributes as a substitute for the construction snapshot.

Keep the initial baseline question set small enough to inspect, but include unrelated domains,
related subjects, explicit conflicting scopes, ambiguous queries, historical claims, requirements
versus recommendations, conditions/exceptions and findings followed by responses. Repeat stochastic
runs and vary insertion order before making a robust improvement claim.

## Retrieval and semantic measures

Record first-result required-source hits, all-required-source recovery within the direct top K, and
additional required-source recovery due to links. State denominators and multi-source expectations.
Report added notes and characters separately; recovering one missing source with dozens of added
notes may be a poor tradeoff. Measure original content and generated attributes separately, using
a declared serialization for total returned characters/tokens.

Judge cross-scope direct results and links separately. An explicit-scope query should prioritize
applicable evidence; an ambiguous query can legitimately return several jurisdictions. A link across
scopes can help compare rules if attribution remains distinct. Shared vocabulary alone is weak
evidence of a useful relationship. Neither a cross-scope link nor a non-required source is
automatically an error.

Manual semantic review checks attribution, claim strength, dates, quantities, units, exceptions,
scope, supersession and unsupported certainty. Track growth of context, repeated event history,
opaque identifiers and another subject's status copied into a note. Schema validity, source quotes,
graph connectivity and correct answers from a pretrained agent do not establish memory usefulness.

## Quality-change acceptance

For ingestion and retrieval quality changes, retain a before/after comparison using the existing
run artifacts, comparison modes and semantic measures. The
[live audit](evaluation-memory-quality-2026-10-05.md) supplies cases and a historical snapshot,
not a reproducible baseline or proof of the precise response defects. Establish the baseline from
retained sources, failed-response evidence where available, and declared queries before changing
the corpus. Record unavailable evidence and avoid inventing failure causes.

Account for every accepted observation by outcome, including failed and blocked receipts. Report
stored/accepted and model-output failures/attempts with denominators, separating fresh ingestion
from recovery. On representative sources that reproduce the identified output-contract defects,
demonstrate successful valid ingestion after the correction; unresolved failures remain explicit.
Do not claim reliability from backlog size, a schema-valid response or a single successful model call.

Review the same source/context pairs before and after, including the audit's two named expanded
contexts where retained. Corrections must remove unrelated subjects and repeated event history,
reduce that excess text and preserve attribution, supported meaning, conditions and uncertainty.
Judge against original sources, including necessary related evidence; shorter text alone is not
acceptance. Review subsequent evolution of those subjects to check the expansion does not return.

Use the four known-topic audit queries and the recorded paraphrases where available, with expected
evidence declared in advance. If exact query text is unavailable, label replacements rather than
claiming an exact repeat. Preserve relevant-first recovery on the retained known-topic cases and
include representative cross-subject and differently scoped queries. Compare direct search with
linked expansion at the same nonzero linked limit: show less unrelated added material on the
identified noisy cases while retaining useful related evidence. Disabling all links is not evidence
of improved link quality. Report source recovery, irrelevant additions and returned text separately.
An uncovered question does not establish an answer merely because neighbors were returned.

Review supplied observations separately from generated context. Report bookkeeping-only sources
and observations with reusable mechanisms, with sample counts and reasons; omission of a tracking
identifier from generated prose does not turn an empty source event into a lesson. Attribute noise
caused by source selection to its consumer and record any needed consumer follow-up separately from
AMEM's ingestion/evolution results.

Before live maintenance, preserve a consistent recoverable copy of the journal and collection plus
the inspected source/context baseline. Account for the audit's retained failed observations, with
each recovered or given an explicit remaining reason. Correct identified contexts where the source
evidence supports a correction; retain a reason for any deferred case. Verify source content,
provenance, identities and source timestamps survive, unaffected records remain intact, and new
search results reflect acknowledged corrections. Use isolated copies for destructive experiments;
never reset the live corpus to obtain a cleaner comparison. Private evidence remains outside the
public repository. This is bounded change acceptance, not a global accuracy or availability promise.

## Quality maintenance procedure

Evaluation is an operator client of the public service and library contracts, not a direct journal
or collection writer. Enumerate receipt pages and correlate accepted/source identities to the retained
private evidence. Record actual validation defects from preserved failed output when available;
generic evolution-contract messages alone cannot distinguish missing fields, invalid IDs, duplicate
updates or other causes. If raw responses are absent, retain that limit and reproduce representative
sources in isolated runs with the existing explicit recording and redaction. Fix generation against
that evidence without weakening response validation, adding model repair calls or assuming every
receipt shares the same defect. Preserve old/new prompt text and identical provider settings.

Freeze writers while making the consistent baseline backup. Keep its restore location and source,
receipt and query inventory privately; validate restoration into an isolated matching collection and
journal before mutating the live pair. The audit is historical evidence; use the actual retained
baseline membership as the denominator and explain additions or unavailable audit cases.

Use `POST /v1/receipts/:id/recover` only after the generation cause has been addressed. Retain the
inspected attempt count, recovery response and final receipt for each selected source. Re-enumerate
outcomes after processing, separating old failure evidence, effective recovery requests, new attempts,
stored results and remaining reasons. Check every audited retained failure where identities remain
available; report unmatched historical evidence explicitly rather than silently excluding it.

Review correction proposals against original sources and supporting sources before using the offline
command in [the service contract](service.md#operator-context-correction). Keep each complete expected
note, proposed attributes, supporting-source references and review rationale alongside the acknowledged
result or unresolved error in private run artifacts. This is evaluation evidence, not runtime metadata
or a permanent version store. Exercise restart replay on an isolated copy before live use. Stop the
service for the live correction session and restart it for resumed ingestion and fresh retrieval.

Compare the same preserved queries, direct limits and nonzero linked budgets after recovery/correction.
Separate changes from fresh generation/recovery from targeted context correction. Correction preserves
existing links, so it does not by itself repair old noisy edges. Evaluate meaningful link selection on
isolated before/after replays of the same retained sources, and report unchanged historical link noise
in live probes. Do not claim old-link repair, remove those links, or change retrieval policy to conceal
noise. If old edges prevent the accepted comparison from showing improvement, report that remaining
limitation for an explicit scope decision rather than silently widening maintenance permissions.

Include later related and unrelated insertions on isolated copies to assess whether corrected subjects
expand again. Report deterministic protocol verification separately from real model-quality evidence;
keep remaining failure, fidelity and relevance limitations explicit.

### Baseline tooling

`experiments/baseline/` implements this procedure as an operator CLI over one private evidence root.
It reads the live journal and collection through their public and provider contracts and never writes
them; the evidence root stays outside the repository, and only the tooling and its deterministic
tests are committed.

```bash
npm run baseline -- capture --root <private-root> --journal <live-journal> --qdrant-url <url> \
  --queries <private-root>/declared-queries.jsonl --revision <revision> \
  --model-endpoint <endpoint> --model-id <id> --service-url <service>
npm run baseline -- receipts --root <private-root>
npm run baseline -- restore --root <private-root> --work <private-root>/restore-work --qdrant-url <url>
npm run baseline -- reproduce --root <private-root> --revision <executing-revision> \
  --qdrant-url <url> --model-endpoint <endpoint> --model-id <id> --embedding-cache <cache> \
  [--prompts baseline|current] [--reverse-order] [--exclude-source <id> ...]
npm run baseline -- defects --root <private-root>
npm run baseline -- compare --root <private-root> --before <run-id> --after <run-id>
npm run baseline -- retrieval --root <private-root> --qdrant-url <url> --embedding-cache <cache>
npm run baseline -- metrics --root <private-root>
```

The root holds `baseline/` (journal copy, collection snapshot, manifest, receipts and the declared
queries fixed before any run), `restore-work/` and `restore-report.json`, `accounting.json`,
`failed-evidence.json`, `reproduction/`, `runs/`, `retrieval.json`, `matched-comparison.json` and
`baseline-metrics.json`.
`capture` refuses an existing evidence directory, so each new baseline needs a new root.

`capture` takes the journal with SQLite's online backup before the collection snapshot and attests
quiescence with a second receipt-state copy; `restore` copies the pair into an isolated journal
directory and collection, refuses the captured live collection and any existing destination before
uploading, and fails unless every retention check passes; only a collection whose restored identity
this invocation verified is ever cleaned up. The retained prompt text is the one in force at
capture; a later generation change may make it differ from the current defaults without invalidating
the baseline. `receipts` keeps the raw failed-output limit explicit, reports cumulative claims
grouped by each receipt's current outcome with the total-attempt denominator, states that
per-attempt failure history is not retained, and writes the representative fixture; `reproduce`
replays it in an isolated recorded run with the live host's provider adjustments, labels the run
with the executing revision the operator states explicitly, records the retained baseline revision
and the prompt source as run conditions, and uses the retained baseline prompt text by default
(`--prompts current` selects this revision's defaults), so before/after evidence stays attributable.
A `--reverse-order` run of the same fixture gives the first-run sources candidate context for their
evolution calls. `--exclude-source` keeps a named source out of insertion, so a matched before/after
pair can exclude the same sources and hold identical membership even when one prompt cannot ingest
them. `compare` pairs two completed reproduction runs whose fixture, insertion order, included
membership, queries, limits, revision and provider settings agree and whose recorded prompt text
sources differ, refuses any other pairing, and writes `matched-comparison.json` with each run's
direct recovery and linked additions — and the reviewed verdicts when a run retains its
`linked-additions-review.json` — so an isolated prompt comparison is measured rather than inferred. `defects` re-validates every recorded response, null included, with the public
schemas and the captured candidate identities, and separates unusable-output failures from provider
or connectivity failures by the transport category the recorder now retains; each classified run
keeps the prompt text source its manifest recorded and the report groups the failing calls by that
source, so a prompt change's before/after adherence is reportable rather than inferred; `retrieval`
runs the declared queries direct and with the declared linked budget. The operator's bounded semantic review
of the linked additions beyond expected evidence lives in `linked-additions-review.json` (one
useful, unrelated or unresolved verdict with a reason per reviewed addition), either for the
restored baseline retrieval or next to one reproduction run; `metrics` aggregates
the numbers with denominators, reports the reviewed verdicts with the assessed-sample denominator,
and keeps unmeasured evidence — an absent review included — null or explicit instead of zero.

## Performance and cost

Measure cold startup separately from warm insert/search. Report medians and p95 with sample count,
outliers, corpus size, dimensions, source/neighbor lengths, indexed-vector count, Qdrant configuration,
hardware and concurrency. Break insertion into generation, embeddings, search and persistence. Report
direct retrieval separately from linked expansion and avoid mixing embedding-free database timing
with end-to-end search timing.

With N successful insertions, each uses one construction call and at most one evolution call when
candidates exist. A fresh uninterrupted run therefore uses at most `2N - 1` successful generation
calls. Failed attempts and host retries are additional. For k candidates, an insertion requires one
initial embedding, up to k changed-neighbor embeddings, and at most one incoming re-embedding after
tag changes. Reads require no generation; a search requires one query embedding.

Bounded candidate count does not bound source length, output tokens or database latency as corpus
size grows. Use actual usage for cost; do not extrapolate from note count alone:

```text
cost = (uncached_input_tokens * uncached_input_rate
      + cached_input_tokens * cached_input_rate
      + output_tokens * output_rate) / 1,000,000
```

Rates are per-million-token inputs to the report with currency and effective date, not hardcoded
current prices. If a provider reports total input including cache hits, subtract cache hits before
the uncached term. Unknown usage remains unknown; when only the cache split is unknown, an estimate
or bound is reported separately from measured cost. Include failed calls, experiment reruns,
embedding compute, database hosting and backup costs separately where measured. Live evaluation is
explicit opt-in with a declared call/token budget and no default retries; record its stopping
reason in the artifacts. Generation stops once reported usage reaches the declared token budget,
and a call whose usage the provider does not report leaves that budget unverifiable: the run stops
and records why instead of continuing with an unenforced budget.

Raw float32 vectors occupy `N * dimensions * 4` bytes (4,096 bytes per 1,024-dimensional note).
One million such vectors is 4.096 GB decimal before payloads, indexes, WAL, replicas, allocator
overhead or backups. Measure payload bytes and actual database disk/RAM separately. Quantized
encoder weights do not reduce these raw vector bytes. Report synthetic correctness tests separately
from realistic scale measurements; do not claim million-note readiness from the prototype.

## Graph inspection

Provide an offline HTML graph/report generated from run artifacts, with no server or production UI
dependency. Nodes identify notes, edges show directed outgoing links, and selection displays original
content, current context, attributes and provenance. Offer construction-versus-final comparison where
available, and source/scope labels for inspection. Layout position has no semantic meaning. The
graph must show real stored IDs and links, not invent similarity edges or turn every evolution update
into a stored link. Escape source text when rendering; do not execute source HTML.

The graph is an inspection tool, not a quality score. Export enough JSON alongside it to reproduce
the evidence without the old prototype or an active database.

For live inspection with vector-based positions, freshness and request highlighting, see the
separate [Sigma.js dashboard design](dashboard.md). Its projected positions have approximate semantic
meaning; this offline report's topology layout does not.
