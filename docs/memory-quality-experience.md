# Memory quality experience

## Applicability and scope

The [accepted quality requirements](memory-quality-requirements.md) affect agents submitting and
interpreting observations and operators recovering retained failures and correcting contexts. UX
is applicable to those interactions. Use the existing agent tools, service status/receipts,
read-only dashboard and evaluation artifacts; this outcome needs no new browser navigation or
memory-editing controls.

Nexus is a consumer, not the interface being designed. Its preparation applicability guidance
reserves reporting-terminal changes for explicit terminal scope. This work does not change that
terminal or introduce ticket/status navigation. Consumer source selection follows the
[charter](project-charter.md#vision); Nexus extraction changes remain consumer-owned.

This document owns the interaction sequence and feedback choices. The requirements own acceptance;
linked component documents own behavior. Architecture selects the maintenance entry points,
schemas, scheduling and interruption handling.

## Agent path: submit, then retrieve evidence

Use [the existing MCP tools](mcp.md#tools). Submit one selected observation with its source identity
and provenance. The save receipt is the stopping point for the producer: durable acceptance lets
the agent continue its task without waiting for ingestion. Interpret its status as processing
evidence, not a claim that the observation is searchable. A lost acknowledgement leads to the
documented identical resubmission, rather than composing another observation. An explicit refusal
or unknown outcome remains distinct from success.

For retrieval, ask the focused question through the existing search tool. Read the original content
and provenance alongside generated context. Treat direct scores as similarity and linked additions
as further evidence to inspect. Use `linkedLimit: 0` when isolating direct retrieval; defaults remain
unchanged. This gives the agent a short path to useful evidence without suggesting that returned
neighbors answer an uncovered question. Search failures remain errors, distinct from an empty
successful result.

## Operator path: inspect, maintain, verify

1. **Inspect ingestion separately from the map.** Start with [service status and receipt lookup](service.md#api).
   Read outcome counts as well as backlog and availability; follow a retained receipt identity to
   its status, attempt count and safe diagnostic. The graph contains stored notes, so absence there
   is a reason to inspect ingestion evidence, not to resubmit with a new identity. An empty backlog
   alone is not a completion signal.
2. **Resolve the cause and choose the existing recovery path.** Review retained failure evidence
   before acting. Use [explicit failed-observation recovery](ingestion-queue.md#recovery-of-failed-observations)
   for known-unwritten failures and the existing replay/reconciliation path for uncertain work.
   The maintenance interaction identifies the selected receipt and explains which path applies;
   an ineligible request explains why instead of implying that recovery began. Initiating recovery
   means pending work, while the resulting receipt supplies the storage outcome. Keep prior failure
   and attempt evidence visible so repeated requests cannot be mistaken for additional observations.
3. **Inspect questionable meaning in the existing dashboard.** Use Memory request, the ordered
   Results list and Details, as specified in [dashboard memory requests](dashboard.md#memory-requests).
   Compare direct-only results with the same question and a bounded linked request. Select a result
   to read source, generated context and provenance; use focused links when following its neighborhood.
   This separates relevance review from visually interesting clusters. Existing request-time and
   refresh feedback distinguish returned evidence from the current map.
4. **Correct supported cases through maintenance, then compare.** Identify affected note IDs from
   source/context inspection. Preserve the baseline before using the Architecture-defined
   [context-correction interface](memory.md#existing-context-correction). Keep mutation outside the
   dashboard. Review acknowledged outcomes and deferred cases in the
   [before/after evaluation evidence](evaluation.md#quality-change-acceptance), then issue a fresh
   search to inspect corrected retrieval. A graph refresh updates the map; it does not rerun an old
   search or establish that all maintenance succeeded.

This sequence keeps routine agent use short and gives the operator evidence before a maintenance
decision. Recovery feedback follows accepted identities; correction review follows original sources.
Neither graph visibility nor a successful sample replaces receipt accounting and semantic review.

## Refinement questions

No new visual interaction needs a Storybook prototype. Existing dashboard behavior remains owned by
[its design and acceptance checks](dashboard.md#acceptance-checks). The concrete experience questions
for the eventual maintenance interface can be exercised with representative receipt responses and
a walkthrough, without inventing browser controls:

- With an empty backlog and a retained failed receipt, can the operator identify the missing work
  and distinguish known-unwritten recovery from uncertain-write reconciliation?
- After requesting recovery twice, can the operator follow the same receipt and distinguish pending
  recovery, another failure and confirmed storage without treating either request as a new source?
- After correcting a context while an old search is displayed, can the operator distinguish that
  request's evidence from refreshed details and run the same query again for the comparison?

Use failed, blocked, pending and stored examples, plus an original/context pair with unrelated
expansion. Exact maintenance interface choices remain for Architecture; these questions do not add
new statuses, screens or quality thresholds.
