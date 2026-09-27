# Prototype findings and design consequences

## How to use this evidence

This document records the observations needed to understand the clean design without opening either
prototype. It is an evidence record, not a second set of runtime requirements. Component documents
own the contracts; [evaluation](evaluation.md) owns future measurement. Measurements below are local
September 2026 experiments, not current provider prices, capacity guarantees or controlled scientific
replications. Thinking was disabled in the reported Flash runs.

The progression was from a package-based, evidence-group wrapper to a direct implementation of
construction, linking and evolution. The package name alone did not establish fidelity to A-MEM.
The [paper audit](paper-alignment.md) separately records our methodological choices.

## Package-based prototype

The first standalone prototype used unmodified `@amemhq/core@2.1.3` through its public API. Our wrapper
grouped findings, responses and assessments, generated cited observations, and retained revisions.

### What failed

- The package's list operation performed one scroll capped at 10,000 and discarded its cursor.
  Hybrid search and our identity/group lookups depended on that incomplete list. A deliberately
  last-sorted point was directly readable in Qdrant and ranked first in dense search, but was absent
  from full memory search and wrapper lookup. A conflicting contribution then slipped past our
  wrapper's promised ID check. This was a demonstrated correctness failure, not just slow code.
- Each ordinary search rebuilt BM25 from the downloaded corpus; the wrapper fetched it again.
  A measured search made 25 HTTP calls, including package retrieval-tracking writes. The prototype
  mixed wrapper scans, package scans and rich history payloads; the responsibility was not solely
  the model or solely the package.
- Evolving every member of a growing group repeatedly duplicated context and history. For g inputs,
  the policy made `g(g+1)/2` context updates plus g initial embeddings. Copying an expanding revision
  history into every member could produce cubic retained-history growth. This is a property of that
  wrapper policy, not an inherent requirement of note evolution.
- Exact quoted-substring validation established that text appeared in a source, not that an
  observation followed from it. In 47 contributions across 15 groups, 42 initial evolutions passed;
  all five requested repairs failed (four length failures, one non-verbatim quote). Three notes in
  one group retained stale context at the end. Asking for shorter text did not reliably fix it.

### Measurements and limits

| Corpus size |                              Median full search |
| ----------: | ----------------------------------------------: |
|         100 |                                         0.234 s |
|       1,000 |                                         0.975 s |
|       5,000 |                                         4.754 s |
|      10,000 | 8.856 s, two successful samples; a third failed |

Normally three sequential samples were taken. The 10,000-point connection failure's cause was not
established. An earlier interrupted run under unrelated memory pressure was excluded. At 10,002
points, dense-only search averaged 128 ms, excluding query embedding (warm median 83 ms). It omitted
hybrid ranking, expansion and hydration, so it was not an equivalent end-to-end comparison. Qdrant
reported zero HNSW-indexed vectors at these checkpoints.

The application reached about 3.74 GiB peak RSS around 10,000 notes. The replay's logical payload
averaged 21,112 bytes per note, plus 4,096 vector bytes. Neither value estimates the clean design.
Across 52 generation calls the provider reported 27,823 uncached input, 33,024 cached input and
25,677 output tokens. Historical monetary extrapolations depended on that corpus, policy and rate
card; they are not a price estimate for this service.

The machine was WSL on an Intel i7-13700KF with 24 logical CPUs and approximately 16 GiB assigned
RAM, Node 24, Qdrant 1.19.1 and local 1,024-dimensional BGE-M3 q8. Replicated load fixtures reused
vectors and were not evidence of realistic semantic diversity or insertion throughput.

### Adopted consequence

Reuse Qdrant and embedding infrastructure directly. Use indexed identity lookup, complete paged
inspection, bounded vector queries, current-note storage and selective re-embedding. Remove the
package's high-level retrieval path and our group/history/citation machinery. Earlier proposals
for durable repair queues, shared group interpretations, lexical ranking and fixed worker pools
were exploratory recommendations; they were not adopted requirements for this A-MEM baseline.

## Direct prototype: mechanism and correctness

Prototype 2 stored 47 source notes from three workspaces, with 93 model calls, 117 insertion
embeddings, 54 neighbor update events and 85 directed links. All insertions completed; there were
no cross-workspace links in that run. Original content was preserved. A finding's context could
progress from the reported defect through a developer's claimed repair to a review that still found
incomplete cleanup. This illustrated contextual evolution, not independent verification.

The initial median insertion was 4.21 seconds, p95 9.33 seconds and maximum 21.89 seconds. Six
end-to-end searches took 39–140 ms. Mean context grew from 264 characters at construction to 649
after evolution, with a final maximum of 1,562. Payloads totaled about 110.9 KiB; raw vectors added
188 KiB. These exclude database indexes, WAL, caches, model artifacts and experiment snapshots.

Six known-finding queries ranked their expected finding first under construction, evolution and
linked expansion alike. An already-perfect tiny diagnostic cannot establish additional retrieval
value. Five initial unit tests covered mechanics; a real-Qdrant test covered lookup, vector search,
complete pagination and reopening across 10,001 synthetic four-dimensional points. That resolved
the old visibility regression but did not measure production-scale retrieval.

## Prompt iterations

Identifier removal alone did not prevent long event histories. A subsequent concise-context replay
used the same 47 sources and order, with no added workspace:

| Measurement                       |    Earlier prompt |   Concise prompt |
| --------------------------------- | ----------------: | ---------------: |
| Mean / maximum context characters |     1,249 / 4,186 |        507 / 976 |
| Output tokens                     |            46,354 |           24,364 |
| Mean text in first five results   | 18,644 characters | 9,994 characters |
| Directed links                    |                94 |               82 |
| Expected finding connections      |             31/32 |            32/32 |
| Known-finding retrieval checks    |               6/6 |              6/6 |

Result text used the canonical content/keywords/tags/context representation, not billed tokens.
The concise run still had a 43.9-second insertion outlier. Lower median time did not establish
predictable tail latency. Fewer links alone was not a quality improvement measure.

Manual review found a response mislabeled as a stale-build issue, an explicit reviewer resolution
lost in generated context, unsupported claims that verification remained pending, and another
subject's copied status becoming stale. A domain-specific example in the prompt was a possible
contamination source, not a proven cause. This motivated project-agnostic defaults, attribution,
preservation of explicit conclusions, and rewriting context rather than appending a running history.

Prompt preferences remain fallible. The generic mixed replay later repeated ticket identifiers in
29 of 47 workspace contexts. There is no runtime identifier filter or automatic context repair.
The benefit established by the concise replay was less generated and retrieved text; source fidelity
and broader retrieval value remained open questions.

## Mixed domains in one collection

The next replay combined the same 47 workspace sources with 24 manually paraphrased New Zealand
driving-rule sources. Twenty driving questions and six workspace queries were excluded from input;
expected supporting source IDs were fixed before insertion. No answer-generation score was used.

| Driving queries, 20 total               | Original content | Constructed | Evolved |
| --------------------------------------- | ---------------: | ----------: | ------: |
| Required source first                   |               18 |          17 |      20 |
| All required sources in direct top five |               19 |          20 |      19 |
| All required sources after expansion    |               19 |          20 |      20 |
| Mean returned characters                |            1,039 |       2,664 |   5,744 |

The 71 notes had 138 links: 90 among workspace notes and 48 among road notes. No cross-domain links,
updates or retrieved results occurred in the tested queries. Topic separation emerged in that run;
it is not a domain-isolation guarantee. All six workspace sources appeared within five results.

For driving queries, expansion added 63 note appearances and recovered one otherwise-missing
required source. A higher-speed-limit note linked to a needed general safe-speed condition, but
headlight and cycle-lane queries also gained broad rules unrelated to their requested thresholds.
The workspace queries gained 21 appearances without recovering a missing required source. Extra
text increased by roughly 67% for driving and 91% for workspace results relative to direct evolved
retrieval. Not every non-required addition was useless, but the cost needed explicit measurement.

Evolution sometimes preserved useful conditional contrasts; it also changed an obligation into a
recommendation and broadened a conditional signaling statement. Concision remained uneven. A
null keyword was rejected before persistence; the experiment resumed after checking stored state.
There were 142 generation calls including the rejected attempt, and zero generation calls for
retrieval. Seven mechanics tests passed after prompt configurability was added.

## Related jurisdictions in one collection

The latest experiment retained the exact 47-note workspace seed, regenerated the 24 New Zealand
sources under stronger scope/claim-strength guidance, then added eight Great Britain sources. It
was not a fresh 79-note replay under one prompt. The preceding collection and graph were preserved.

The 32 new insertions used 64 generation calls, 57,456 reported input and 7,849 output tokens, with
no failures. Generation took about 77 seconds and insertion plus snapshots about 84 seconds. The
final graph had 79 notes and 143 directed links. Eight links crossed from Great Britain to New
Zealand notes; three New Zealand contexts changed following Great Britain additions. No links
connected software material to road rules.

Across 33 explicitly scoped road queries, the first result had the correct jurisdiction in 33/33,
the required source ranked first in 29/33, and all required sources occurred in the direct top five
in 33/33. Fourteen queries also returned another jurisdiction. All eight Great Britain queries
ranked their required source first; four of five new New Zealand queries did so. Ambiguous towing
and hazard-light queries returned both jurisdictions, a reasonable outcome rather than an automatic
failure. Scope labels guided similarity; they did not act as filters.

The original 20 New Zealand questions moved from 20 first-source hits / 19 complete top-five hits
under the preceding prompt to 18/20 after regeneration, then 17/20 after adding Great Britain.
Here `18/20` and `17/20` mean first-source hits / complete top-five hits, each out of 20 questions.
Thus complete evidence coverage improved while first-result accuracy fell. The six workspace checks
remained five first-source hits and six complete top-five hits.

Country labels generally survived evolution, yet one cycling recommendation became a requirement.
A Great Britain towing limit was copied into a New Zealand following-gap context with attribution
but questionable usefulness. The new prompt therefore did not solve semantic fidelity. Distinct
England/Wales notes remained distinguishable in the scoped queries; this does not certify driving
advice or correctness beyond the supplied experimental text.

## Remaining limits and explicit decisions

- Small, manually selected corpora and single stochastic runs do not establish general quality.
  Temporal belief revision needs more direct evaluation than static-rule fixtures provide.
- Preserve source content and return it with generated context. Metadata provides provenance and
  inspection value; it does not automatically improve embeddings or constrain applicability.
- Link and evolution decisions use a retrieved neighborhood. Stronger global relationships can be
  missed when their notes are outside it. No exhaustive model scan is adopted.
- Keep read paths independent of slow generation and free of write effects. Bounded candidate
  counts remove application-wide scans, but source length and context growth still drive cost.
- No measured production throughput, concurrent-writer safety, crash recovery or huge-corpus
  quality claim exists. The clean contracts specify one writer and honest uncertain-write outcomes.
- Collection embedding identity, complete payload schemas, typed failure stages and construction
  timestamp inclusion are clean-design requirements beyond what the prototype fully checked.

## Optional local evidence map

These locations identify retained evidence in WSL `NexusAiur`; none is required to implement the
contracts and none is imported by the new project.

| Reference             | Evidence location                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Package measurements  | `/home/aiur/projects/evidence-memory/SCALING.md` and `.data/scale-study/`                                                   |
| Initial direct replay | `/home/aiur/projects/amem-prototype2/VALIDATION.md` and `.data/amem2_replay_50224bd9c9d34dfe98a393710c6733f5/`              |
| Context revisions     | `/home/aiur/projects/amem-prototype2/CONTEXT-UPDATE.md`, `CONCISE-CONTEXT.md`, `.data/concise-prompt-update/before/`        |
| Mixed-domain replay   | `/home/aiur/projects/amem-prototype2/MIXED-RETRIEVAL.md` and `.data/mixed_memory_796dc427a2a24901a48cb59eac0ab9f6/`         |
| Jurisdiction replay   | `/home/aiur/projects/amem-prototype2/JURISDICTION-EVALUATION.md` and `.data/jurisdiction_03eb78713af74667ae26ce832659400b/` |

Run directories retain manifests, model calls, snapshots, retrieval lists, metrics and standalone
graphs. Raw source artifacts remain private. Do not copy those corpora into this public repository
as part of implementing the documented synthetic evaluation harness.
