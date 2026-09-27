# Replay and retrieval evaluation

These tools replay a source fixture through the public library, write the run artifacts the
[evaluation specification](../docs/evaluation.md) requires and compare the documented retrieval
modes: original content, constructed attributes, evolved direct matches and evolved linked
expansion. They are consumers of the public contracts; they implement no memory algorithm and the
runtime library never imports them.

## Layout

| Path        | Purpose                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `fixtures/` | Small synthetic JSONL fixtures authored for this repository, with their expected sources |
| `replay/`   | Fixture contract, instrumentation, run artifacts, comparison modes, measures and runner  |
| `demo/`     | The deterministic demonstration: in-memory collections and fixture-driven stand-ins      |
| `live/`     | The opt-in live run: real Qdrant collections, the pinned encoder and a host transport    |

## Deterministic demonstration

```bash
npm run demo:evaluation
```

The demonstration replays `fixtures/synthetic-sources.jsonl` with the deterministic token-hashing
embedder and the fixture-driven model stand-in in `demo/`, writes a fresh run directory under
`AMEM_DEMO_RUNS_DIR` (default `.data/evaluations`) and prints the measurement report. It needs no
credential, external service or paid call, and repeated runs make the same insertion, link and
retrieval decisions. `AMEM_DEMO_RUN_ID` names the run directory so a second invocation writes a new
run instead of overwriting the first.

The stand-ins exist to exercise the harness. They are not an encoder, a model or evidence about
memory quality, and their timings do not describe Qdrant or a provider.

## Live evaluation

`npm run replay:live` is explicit opt-in. It fails when a required setting is missing instead of
reporting a pass, uses no implicit retries and stops once a call reaches the declared call or token
budget, recording the stopping reason. Because a token budget cannot be verified without reported
usage, a call that omits its input or output tokens stops the run instead of continuing beyond an
unknown total:

```bash
export AMEM_LIVE_QDRANT_URL=http://127.0.0.1:16333
export AMEM_LIVE_MODEL_ENDPOINT=https://provider.example/chat/completions
export AMEM_LIVE_MODEL_ID=provider-model-id
export AMEM_LIVE_MODEL_API_KEY=...            # optional for an unauthenticated local gateway
export AMEM_LIVE_CALL_BUDGET=200
export AMEM_LIVE_TOKEN_BUDGET=2000000
export AMEM_LIVE_COST_RATES='{"currency":"USD","effectiveDate":"2026-09-01","uncachedInputPerMillion":0.28,"cachedInputPerMillion":0.028,"outputPerMillion":0.42}'
npm run replay:live
```

Required settings are `AMEM_LIVE_QDRANT_URL`, `AMEM_LIVE_MODEL_ENDPOINT`, `AMEM_LIVE_MODEL_ID`,
`AMEM_LIVE_CALL_BUDGET` and `AMEM_LIVE_TOKEN_BUDGET`. Optional settings:

| Setting                                  | Default                      | Meaning                                                                                                                |
| ---------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `AMEM_LIVE_QDRANT_API_KEY`               | none                         | Qdrant credential; never written to artifacts or records                                                               |
| `AMEM_LIVE_QDRANT_TIMEOUT_MS`            | `120000`                     | Qdrant request timeout                                                                                                 |
| `AMEM_LIVE_COLLECTION_BASE`              | `amem-live-evaluation`       | Prefix of the collections the run may create                                                                           |
| `AMEM_LIVE_MODEL_API_KEY`                | none                         | Provider credential, redacted from every diagnostic                                                                    |
| `AMEM_LIVE_MODEL_TIMEOUT_MS`             | `120000`                     | Provider request timeout                                                                                               |
| `AMEM_LIVE_MODEL_MAX_OUTPUT_TOKENS`      | `6000`                       | Provider output budget per request                                                                                     |
| `AMEM_LIVE_MODEL_THINKING`               | `false`                      | Provider thinking setting the host declares; the transport does not send it, so the provider or model ID must honor it |
| `AMEM_LIVE_EMBEDDING_CACHE`              | `.data/embeddings`           | Pinned encoder artifact cache                                                                                          |
| `AMEM_LIVE_ALLOW_EMBEDDING_DOWNLOADS`    | `true`                       | Whether missing pinned artifacts may be downloaded                                                                     |
| `AMEM_LIVE_RUNS_DIR`                     | `.data/evaluations`          | Directory that receives one subdirectory per run                                                                       |
| `AMEM_LIVE_SOURCES`, `AMEM_LIVE_QUERIES` | committed synthetic fixtures | Ordered JSONL fixtures to replay                                                                                       |
| `AMEM_LIVE_INSERTION_ORDER`              | fixture order                | Comma-separated source IDs that reorder the insertion                                                                  |
| `AMEM_LIVE_REVISION`                     | `unknown`                    | Code revision recorded in the manifest                                                                                 |
| `AMEM_LIVE_RECORD_RAW_EXCHANGES`         | `false`                      | Store complete prompts and raw provider bodies in `calls.jsonl`                                                        |
| `AMEM_LIVE_KEEP_COLLECTIONS`             | `false`                      | Keep the disposable collections after the run                                                                          |
| `AMEM_LIVE_COST_RATES`                   | none (cost stays unknown)    | Per-million-token rates with currency and effective date                                                               |

Every collection name is unique to the run, so a fresh replay never reads or clears an earlier
collection. The runtime collection is opened through the library's Qdrant NoteStore as
`amem-note-v1`; each baseline collection declares its own representation under the
`agenticMemoryEvaluation` metadata key and the runtime store refuses to open it. Unless
`AMEM_LIVE_KEEP_COLLECTIONS=true`, the run deletes exactly the collections it created when it
finishes.

## Run artifacts

Each run writes `manifest.json`, `sources.jsonl`, `calls.jsonl`, `construction.jsonl`,
`changes.jsonl`, `notes.jsonl`, `retrieval.jsonl` and `report.json` under its own directory. Run
directories and source corpora stay outside the published package: the default `.data/evaluations`
directory is ignored by Git, and a private corpus belongs outside this repository entirely.

`sources.jsonl` records every supplied entry, the note UUID its insertion allocated and how far it
got (`inserted`, `failed`, `stopped`, an excluded entry or one the run never reached), so a failed
or stopped run still accounts for its whole input. Every `calls.jsonl` and `construction.jsonl`
record carries the same source ID and, once the insertion resolves, its note ID.
`construction.jsonl` keeps the attributes of a construction that succeeded even when a later stage
of that insertion failed, and `notes.jsonl` exports every note public pagination actually returns,
including a batch whose acknowledgment was lost, mapped to its source where the run can attribute
it. `changes.jsonl` records the state each acknowledged batch replaced and, for a failed write
attempt, the batch Memory prepared without presenting it as committed.

`manifest.json` records the declared call/token budget, and `report.json` states the denominators of
every recovery measure, separates direct matches from linked additions, records missing usage as
unknown, reports the host's cold encoder-loading and transport-setup durations apart from the
first-operation and warm timings, summarizes the selected-neighbor counts and lengths, and records
the indexed-vector count and collection configuration the environment can observe (the in-memory
demonstration identifies those two as unavailable). An exact cost is reported only from complete
reported usage; when the provider omits the cache split and the rates differ, the cost stays unknown
and a labeled all-uncached upper bound is reported separately. The baseline runner emits no
extrapolations; add them deliberately, with their assumptions, when a report needs one. Manual
semantic review findings are supplied to the runner as
`semanticReview` entries and appear under that key; the automated run records none, and the reviewer
judges attribution, claim strength, conditions, scope and unsupported certainty by reading the
retrieval and note artifacts.

Repeating a run uses a new run directory and fresh collections, and the runner accepts an explicit
`insertionOrder` permutation so stochasticity and insertion order can be varied before a claim about
improvement. A cross-scope result or a non-required result is not an automatic error: the artifacts
keep each query's declared scope, each result's origin and the complete returned note, and judging
whether a relationship is useful belongs to the review rather than to the metric.

An unexpected harness error (for example, a store that cannot be opened at all) leaves the run
directory with the artifacts written so far and a `manifest.json` that still says `running`; the
run never deletes or rewrites that directory, so the partial evidence stays inspectable.

## Boundaries

Graph rendering and application-specific artifact extraction are separate concerns: extraction
belongs to the source application's adapter, and the offline graph is a later inspection tool built
from these run artifacts. The harness only replays the supplied entries, maps fixture source IDs to
generated note UUIDs and never inserts query text as memory.
