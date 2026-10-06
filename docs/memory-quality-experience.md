# Memory quality experience

## Applicability and scope

The [accepted quality requirements](memory-quality-requirements.md) affect agents submitting and
interpreting observations and operators recovering retained failures, correcting contexts and
reviewing reproduced missed evolution updates or historical relationships. UX is applicable to
those interactions.
Use the existing agent tools, service status/receipts,
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

Use this path for retained ingestion failures and existing-context maintenance. For a reproduced
missed update or historical-link review, use the corresponding bounded path below.

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

## Operator path: compare a reproduced missed update

Use the existing private evaluation artifacts for the
[bounded repair journey](memory-quality-requirements.md#bounded-missed-evolution-repair), following
[missed-update evaluation](evaluation.md#missed-warranted-evolution). No live maintenance step is
needed for this comparison.

1. **Select the evidence.** Start from the retained request and missed target. Read its original
   source, prior context and the incoming repair evidence together so the particular claim being
   revised is clear before reviewing a proposed result.
2. **Compare the variants.** Follow the same target and supplied neighborhood through the before
   and corrected trials, then inspect the related different-mechanism and unrelated controls.
   Keep the comparison in read-only replay or isolated copies; the live dashboard is not a view of
   those trial results. Architecture selects the prompt/input correction and execution entry point.
3. **Review meaning, then outcomes.** Compare each complete revised context with the original and
   supporting sources. Read the defect as historical and the repair as attributed later evidence;
   check that the original explicit reproduction remains understandable. Review other updated
   neighbors and controls before judging the correction. Follow any reported miss or semantic
   defect back to its trial evidence rather than treating a target update alone as completion.

Comparison feedback uses the existing evaluation report: distinguish target updates from faithful
revisions, show control changes and invalid/failed calls with denominators, and retain unsuccessful
trials alongside successful ones. Identify whether the evidence is request replay, isolated
ingestion/persistence or delivered production behavior. This gives the operator a short evidence
path without mistaking a promising sample for a repaired live corpus or a reliability guarantee.

## Operator path: review and correct historical links

Follow the [bounded historical-link journey](memory-quality-requirements.md#bounded-historical-link-correction)
after the queued context and evolution work. Start from retained linked comparisons and preserved
queries, then inspect the current corpus. Historical snapshots locate candidates; they do not
authorize changes to current notes.

1. **Follow the evidence to the directed relationship.** In the existing dashboard, run the
   preserved Memory request, select the Linked addition in Results and read its original content
   and provenance in Details. Inspect the direct matches' outgoing links to identify the actual
   source-to-target edge; a linked result alone does not identify its parent. Use focused links and
   the existing outgoing-link controls to follow the endpoints. Read current notes through the
   public inspection capabilities when the retained request or map is outdated or incomplete.
   Keep the query, edge direction and both sources together in private review artifacts so repeated
   labels or multiple paths do not lead to removal of the wrong relationship.
2. **Review meaning before choosing removal.** Apply [original-source review](evaluation.md#historical-link-correction)
   to both endpoints. Record each relationship as proven incorrect, valid or unresolved with its
   reason and source references. Query-specific irrelevance and contaminated generated context
   are prompts to inspect, not removal decisions. Keep valid and unresolved edges. If none is proven
   incorrect, finish with the supported no-removal report; no maintenance capability is needed.
3. **Review the exact change, then use maintenance.** For warranted removals, review the source ID,
   outgoing target IDs and inspected current state against the recorded reasons before submitting
   to the Architecture-defined [link-maintenance interface](memory.md#existing-link-correction).
   Follow the existing baseline and writer-ownership procedure; exercise removal and interrupted
   recovery on an isolated copy before live use. Keep this step outside the read-only dashboard
   and separate from context correction. A removal affects the selected arrow, not either memory
   or the reverse arrow. Retain each acknowledged result or unresolved error beside its proposal.
4. **Verify relationships, then repeat retrieval.** After restart, inspect the persisted outgoing
   links and preservation evidence. Run fresh searches with the same preserved query text, direct
   limits and nonzero linked budgets. An old Results list remains evidence of its earlier request;
   refreshing the map alone is not a comparison. A target may still be a direct match or arrive
   through another valid edge, and a newly available budget slot may expose another addition.
   Explain those routes and review those additions rather than judging removal by target disappearance.

Keep review verdicts separate from execution outcomes in the private evaluation report. Use the
existing maintenance feedback style: identify the affected source and targets, explain what was
acknowledged or left unchanged, and make the next action clear. These are outcome distinctions,
not new receipt statuses or dashboard badges:

| Observed outcome                                       | Operator interpretation and next action                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Removal acknowledged                                   | Record the exact removed edges, then verify persistence and preservation after restart. This is not a claim of corpus-wide quality.                                    |
| Invalid or stale proposal; storage unchanged           | Read the reason. Correct invalid input or inspect and review current state again; do not reuse a stale proposal.                                                       |
| Ownership conflict or an unchanged preparation failure | Resolve the reported cause before another attempt. A failed read does not establish staleness or successful removal.                                                   |
| Interrupted application or lost acknowledgement        | Keep the outcome unresolved and follow maintenance recovery to establish persisted state before further changes. Do not report success or infer that nothing happened. |
| No proven incorrect edge                               | Report valid and unresolved findings with reasons, without implying an execution failure or hiding remaining noise.                                                    |

Close the journey with assessed, proven incorrect, removed, valid and unresolved edge counts,
failed removals, direct recovery and useful/unrelated linked additions with denominators, following
[historical-link evaluation](evaluation.md#historical-link-correction). Keep graph identities and raw
source evidence outside Git. This evidence-first sequence supports the charter's useful, attributed
retrieval with less irrelevant context, while preserving valid relationships. The graph stays an
inspection aid: position, freshness colors and animation do not signal semantic correctness or
successful maintenance. Existing navigation, palette and camera behavior remain suitable; no new
visual or motion treatment is needed.

## Refinement questions

No new visual interaction needs a Storybook prototype. Existing dashboard behavior remains owned by
[its design and acceptance checks](dashboard.md#acceptance-checks). The concrete experience questions
for maintenance, bounded comparison and link review can be exercised with representative outcomes,
retained source/context pairs and a walkthrough, without inventing browser controls:

- With an empty backlog and a retained failed receipt, can the operator identify the missing work
  and distinguish known-unwritten recovery from uncertain-write reconciliation?
- After requesting recovery twice, can the operator follow the same receipt and distinguish pending
  recovery, another failure and confirmed storage without treating either request as a new source?
- After correcting a context while an old search is displayed, can the operator distinguish that
  request's evidence from refreshed details and run the same query again for the comparison?
- When a replay updates the target but omits its explicit reproduction evidence, can the operator
  identify the semantic defect and distinguish that trial from a faithful revision and a live repair?
- With one query-irrelevant but valid defect/repair edge, one proven cross-mechanism edge and one
  unavailable-source case, can the operator select only the warranted directed removal and explain
  why the other two remain?
- With a stale proposal, a failed read and a lost acknowledgement, can the operator distinguish
  unchanged storage from unresolved application and choose inspection or recovery appropriately?
- After restart, when a removed target still appears through another valid edge and an old Results
  list is open, can the operator verify the specific removal and make a fresh matched comparison?

For maintenance, use failed, blocked, pending and stored examples, plus an original/context pair
with unrelated expansion. For bounded comparison, use a missed target, a target update with lost
evidence, a faithful revision and both controls. For link review, use the three relationship cases
above, maintenance outcome examples and a multiple-route retrieval example. Exact execution and
maintenance interface choices remain for Architecture; these questions do not add new statuses,
screens or quality thresholds.
