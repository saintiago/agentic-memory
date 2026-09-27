# A-MEM alignment audit

## Reference and conclusion

Reviewed the full 28-page [A-MEM v11 PDF](https://arxiv.org/pdf/2502.12110v11), including appendices,
examples, evaluation tables and checklist, on 2026-09-27. This is a mechanism-aligned implementation,
not a reproduction of the authors' code, prompts, experimental setup or reported scores.

## Paper anchors

| Reference           | Relevant specification                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.1, equations 1–3 | Original content, time, generated keywords/tags/context, vector and links; construction sees content and time; embedding combines content and generated attributes.                       |
| §3.2, equations 4–6 | Cosine top-k candidates precede model-selected links.                                                                                                                                     |
| §3.3, equation 7    | Retrieved neighbors' context, keywords and tags can evolve.                                                                                                                               |
| §3.4; Figure 2      | Query embedding retrieves top-k; the figure also describes accessing linked memories. Exact graph traversal limits are unspecified.                                                       |
| Appendix B.1–B.3    | JSON responses; construction requests one-sentence context; evolution discusses strengthening and neighbor updates. Its example also lists merge/prune without defining their algorithms. |
| §4.2; Appendix A.5  | Experiments use all-MiniLM-L6-v2 and model/category-dependent retrieval counts.                                                                                                           |

Source: [paper methodology and appendices](https://arxiv.org/pdf/2502.12110v11).

## Our decisions and their status

The prototype's source is evidence for the following implementation facts. The component documents
are authoritative for the clean implementation.

| Our behavior                                                                     | Assessment and disposition                                                                                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full original source plus generated context, keywords, tags, time and links      | Retain the data model. UUID and optional opaque metadata are additional engineering fields.                                                                   |
| Embed original content plus all three generated attributes                       | Retain. Metadata is not automatically semantic context. Re-embed changed representations.                                                                     |
| Retrieve candidate notes before selecting links                                  | Retain. Model decisions are limited to that supplied neighborhood; IDs do not introduce an additional restriction.                                            |
| One call combining link decisions and neighbor updates                           | Deliberate batching choice. It does not reproduce separately formulated conceptual stages call-for-call.                                                      |
| Replace neighbor attributes; update incoming tags                                | Retain. Do not rewrite original source or perform recursive evolution.                                                                                        |
| UUID-keyed updates instead of positional output arrays                           | Deliberate wire-contract choice; validate references and reject duplicate updates. JSON itself is not our invention.                                          |
| Construction sees content but not timestamp                                      | Prototype mismatch. The clean contract now includes the resolved timestamp in construction data. Preserve old runs as old runs; do not relabel their prompts. |
| Directed new-to-existing links, one outgoing hop, separate linked budget         | Explicit traversal policy chosen for this library. Do not claim this exact policy is uniquely required by A-MEM.                                              |
| BGE-M3 q8, Qdrant, DeepSeek Flash with thinking disabled                         | Our infrastructure and evaluation choices, not benchmark reproduction settings.                                                                               |
| Five candidates, five direct results and five optional linked results by default | Our configurable defaults. Do not label them the paper's defaults or optimized values.                                                                        |
| Concision, attribution, scope and identifier guidance                            | User-approved prompt adaptations motivated by our experiments. Quality remains an empirical question.                                                         |
| No merge, prune, permanent history, importance score or decay                    | Baseline scope remains unchanged. No defined destructive operation is inferred from an ambiguous action label.                                                |
| Single writer, explicit write uncertainty, schemas and collection compatibility  | Engineering contracts for this service; do not attribute these guarantees to the research.                                                                    |

## Fidelity and evaluation boundary

Our current tests establish mechanics and boundary behavior; they do not establish equivalence to
the authors' implementation or reproduce its benchmark performance. Our evaluation deliberately
measures returned evidence and source fidelity rather than relying only on answer quality. The
prototype's small corpus, selected questions, different encoder/model and prompt revisions prevent
a direct performance comparison with published numbers.

Do not infer production storage cost, insertion cost or end-to-end retrieval latency from another
system's headline figures. Use our [measurement protocol](evaluation.md#performance-and-cost).
The new implementation must first pass its documented contracts and replay comparisons. Any claim
of closer paper reproduction would require a separately specified experimental configuration and
evidence; it is not an implicit requirement hidden in an implementation ticket.

## Correction captured by this audit

Resolve time before construction and include `timestamp` beside `content` in its JSON data envelope.
Everything else listed above is explicitly classified rather than silently described as exact
fidelity. Keep prompts configurable and retain the accepted project-agnostic instructions. No new
memory policy or additional provider is introduced by this correction.
