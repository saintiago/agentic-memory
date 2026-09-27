# Replay, retrieval evaluation and inspection

## Purpose and boundary

The evaluation tools consume public APIs. They replay a source stream, expose resulting notes and
links, and test the memories returned for known questions. They do not implement another memory
algorithm, reach into provider internals, or become dependencies of the runtime library.

Private source corpora and run outputs stay outside the public repository. Commit small synthetic
fixtures authored for this project and their expected source IDs. Do not copy private workspace logs
or assume that a public driving handbook permits republishing adapted text under any license.
Source labels are examples of applicability, not legal advice or a driving-rule validation service.

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
read every log and discover experiences. A task description, developer report, individual reviewer
finding and individual developer response can each form a separate note. Keep each statement's
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

| Artifact             | Required contents                                                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`      | Run ID, code revision, input/query hashes, insertion order, seed/resume provenance if any, exact prompt text, model endpoint identity without credentials, model ID/settings including thinking, output budget/timeout, encoder settings/space ID, storage version/configuration, hardware and timing conditions |
| `sources.jsonl`      | Supplied entries and source-to-note mapping; private unless explicitly chosen for publication                                                                                                                                                                                                                    |
| `calls.jsonl`        | Stage, source/note identity, full request and raw response when enabled, parsed response/error, duration, finish reason, usage including cached input if available; record failed calls too                                                                                                                      |
| `construction.jsonl` | Attributes immediately after successful construction, before evolution; correlated to source ID                                                                                                                                                                                                                  |
| `changes.jsonl`      | Before/after current-note snapshots for each successful insertion and its changed neighbors, including links; failed/uncertain operations recorded separately                                                                                                                                                    |
| `notes.jsonl`        | Complete final notes exported through pagination, plus source mapping                                                                                                                                                                                                                                            |
| `retrieval.jsonl`    | Query and mode, expected IDs, full ordered results, direct scores and link origin classification, latency and returned text size                                                                                                                                                                                 |
| `report.json`        | Counts and metrics with denominators, failures, input exclusions, semantic review findings, timings, usage and clearly labeled extrapolations                                                                                                                                                                    |

Instrument host-supplied contracts to capture construction, usage and proposed writes. A prepared
write is not a committed snapshot until acknowledged. This is experiment history, not a runtime
revision store. Use public get/page operations to verify persisted state after the run.

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
the uncached term. Unknown usage remains unknown. Include failed calls, experiment reruns, embedding
compute, database hosting and backup costs separately where measured. Live evaluation is explicit
opt-in with a declared call/token budget and no default retries; record its stopping reason.

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
