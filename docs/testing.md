# Testing architecture

## Choosing scope

Test documented behavior at the smallest scope that reliably exposes the relevant failure. Use
many focused tests, fewer integration tests and a small set of complete journeys. No percentage
or test-count target is required; broader tests must establish evidence narrower tests cannot.

| Scope          | Real parts                                                                               | Evidence                                                                 |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Unit           | A focused rule or transformation                                                         | Validation and decisions independent of infrastructure                   |
| Component      | A component through its public contract, with internal logic assembled                   | Observable promises under supplied dependency outcomes                   |
| Integration    | The actual participants in one boundary interaction                                      | Compatibility, persistence, vector search and provider protocol handling |
| System journey | Assembled library and isolated real storage, with controlled model and embedding outputs | A complete memory operation remains usable across wiring and persistence |

Keep ordinary internal collaborators real. Substitute dependencies outside the tested scope.
Component tests need no network, real filesystem or paid model calls. Control time and response
ordering. An in-memory store cannot prove Qdrant search, persistence or write-failure behavior.

## Main risks and ownership

| Owner                | Focused evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory               | Original content and provenance survive evolution; only supplied candidates can be linked or changed; invalid model decisions fail before writes; changed semantic attributes receive updated embeddings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Memory retrieval     | Ranked direct matches, bounded one-hop expansion, no duplicates, complete returned note fields and no model calls; zero linked limit disables expansion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| NoteStore            | Actual written records can be read and searched; scores and limits follow its contract; persistence survives reconnection; write failures and uncertain outcomes remain distinguishable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Embeddings           | Declared model/configuration identity, output dimensions and usable finite vectors; failures are reported rather than substituted with invented vectors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| LanguageModel        | Request and response handling, provider failures, timeout and any explicitly supported retry behavior; credentials are not exposed in failures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Composition          | Host-supplied implementations and prompt configuration are honored without constructing hidden defaults or importing prototype/Nexus internals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Inspection host      | Paged embedded export and projection lifecycle, loading/ready/error graph states, bounded-backoff recovery of a failed refresh, the browser route contract with sanitized validation, missing-record and failure responses, the WebSocket resync/graph-changed notifications with coalescing and bounded backpressure, the same routes mounted next to the unchanged `/v1` API on one service listener, and responsiveness while CPU-heavy projection runs off the HTTP event loop                                                                                                                                                                                                                                                                        |
| Inspection dashboard | Served payload validation, the display model and its view diffing, freshness ranges, request highlighting and result order, retained views after failures, inert rendered text, and the recorded real-browser checks of the Sigma UI (scale, camera preservation across an added outlier during settled state, wheel zoom and drag inertia)                                                                                                                                                                                                                                                                                                                                                                                                               |
| Ingestion queue      | Durable acceptance before acknowledgement, source-key deduplication and conflicts, acceptance during a worker or provider outage, one worker per queue including through filesystem aliases, drain order without overtaking, retry delay and blocking classification by machine-readable model failure category, corrupt or lost committed plans blocking for reconciliation, exact persisted-plan replay after a partial write, a lost acknowledgement and a restart, idempotent legacy receipt migration whose uncertainty blocks every collection write, shutdown during startup, shared worker availability and durable blocking diagnostics, and a producer event loop that stays responsive while another connection holds the journal's write lock |

Verify new identities for distinct insertion requests, including identical source content. Do not
introduce content deduplication or caller-ID comparison tests for behavior the design does not offer.
Verify serialization for the supported single-writer instance, including continuation after a failed
operation. Do not present this as evidence for distributed concurrency.

## Contracts and cooperation

Exercise provider-owned public contracts. Assert observable results and meaningful effects, not
private methods or incidental call order. Verify ordering when it is the promise, such as completing
validation and embeddings before beginning writes.

For a changed boundary, use actual provider output in its consumer or run both together. Do not
replace both sides with independently invented fixtures. Type checking and schema validation prove
shape compatibility; behavioral assertions establish semantics.

Run focused NoteStore contract cases against real Qdrant, including retrieval after updates and
reconnection. Use controlled protocol responses for failures that cannot be induced reliably in a
local server. Label that evidence separately from observed real-provider behavior. Use prepared
small vectors to test storage search without conflating it with encoder quality.

Exercise the real embedding runtime separately with a fixed model artifact and small text fixtures.
This establishes encoding compatibility and runtime integration, not general retrieval quality.
Routine checks must not silently download mutable model versions or depend on paid provider access.

Run the same observable contract cases against replacement implementations. A supplied stub proves
the consumer accepts a replacement; it does not prove the replacement's equivalence. Boundary checks
must reject private imports, dependency cycles and forbidden directions.

## System journeys

Keep a few representative journeys: insert and retrieve after reopening storage; insert related
material, evolve an existing note and retrieve its current content; fail preparation and demonstrate
that stored notes remain unchanged. Exercise storage uncertainty through the owning boundary rather
than duplicating its full failure matrix across every journey.

Use isolated collections and clean up even on failure. Tests must never write to prototype or user
collections. Real model judgments belong in evaluation, not deterministic system-test assertions.

## Quality recovery and maintenance checks

Keep new correctness evidence with its owner. Memory component checks cover correction proposal
validation, a complete expected-note comparison, detached inputs, preserved sources/links, no-op
preparation, re-embedding/update time and application of its actual prepared plan. Use real isolated
storage to verify corrected semantics are searchable after reopening.

Queue checks cover complete receipt traversal, identity-preserving recovery and retained recovery
evidence, stale attempt-count requests, transactional races with claim/recovery, and refusal while
a later write plan is unresolved. Maintenance checks cover the shared lock, no writes before plan
commit, pending-slot status, exact correction replay before subsequent ingestion, and blocking on
damaged slot data. Reopen the previous journal schema and verify upgrade preserves existing receipt
and plan values, including unknown historical evidence. Reuse the existing partial-write/replay
failure controls rather than building another recovery framework.

Service contract checks exercise actual queue receipts for enumeration/recovery, error mapping,
durable acceptance versus storage feedback and client/OpenAPI compatibility. A focused workflow
combines the offline correction command with actual preparation/application and service restart;
it verifies single-writer exclusion and fresh inspection without introducing browser controls.
Use the accepted [experience walkthrough questions](memory-quality-experience.md#refinement-questions)
with failed, pending, stored and blocked examples. Source/link fidelity and smaller unrelated returned
text remain model-quality evidence under [evaluation](evaluation.md#quality-change-acceptance), not
schema, prompt snapshots or prose-length assertions.

## Memory-quality evaluation

Treat evaluation as evidence about models, prompts and source material, separate from correctness
tests. Use known source sets and queries with expected evidence. Measure returned memories rather
than relying on whether an agent can answer from its existing knowledge.

Compare original-content retrieval, constructed-note retrieval and evolved-note retrieval using the
same corpus and queries. Measure direct matches and linked expansion separately. Review relevant
source recovery, ranking, irrelevant returned text, and preserved attribution, conditions, exceptions,
quantities and recommendation/requirement distinctions.

Include unrelated subjects, closely related but differently scoped material, and ambiguous queries.
A cross-scope link is not automatically wrong; evaluate whether it provides a useful, accurately
attributed relationship. A scoped query should prioritize applicable evidence. An unspecified scope
may reasonably return alternatives. Source provenance alone does not establish generated accuracy.

Record input order, model and embedding settings, prompts, corpus, query wording and evaluation
criteria. Preserve runs outside the core runtime so comparisons remain inspectable. Repeat stochastic
runs when drawing conclusions about improvement; one successful run is not a guarantee. Manual
source paraphrases can introduce ambiguity before the model sees them and must be audited too.

## Live boundaries and performance

Routine validation requires no production credentials or paid calls. Targeted live model checks use
explicit experiment settings and record usage and failures separately from simulated protocol tests.

Measure insertion, embedding, model and retrieval time separately, alongside token usage, returned
context size and storage. Declare corpus size, source lengths, model revision, hardware, concurrency
and cold/warm conditions. Distinguish measured observations from extrapolations. Do not turn noisy
timing thresholds into correctness tests or infer large-scale performance from a small replay.

## Test discipline

1. Identify the changed behavior, its owner and a plausible failure; inspect existing coverage.
2. Use small explicit fixtures and the narrowest useful scope. Reproduce a bug before fixing it
   where practical. Do not calculate expected values with the implementation being tested.
3. Await observable completion instead of sleeping. Restore mocks, clocks, files and collections.
4. Run focused checks first; broaden only for affected boundaries or composition. Investigate failures
   rather than retrying until green or weakening assertions.
5. Report what was verified and remaining limits. Documentation-only changes need document review
   and link checks, not application test scaffolding.

Do not test prompt prose by snapshot or claim semantic quality from schema acceptance. Test that
configuration, source material and the response contract reach the model correctly; use evaluation
for the quality of the resulting notes. Stop once the relevant risks have adequate evidence.
