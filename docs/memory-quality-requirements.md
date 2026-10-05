# Memory ingestion and retrieval quality requirements

## Outcome and evidence

Agents can retain valid, useful observations and retrieve relevant original evidence with concise,
faithful context and useful linked additions. Operators can recover retained ingestion failures and
correct affected existing contexts while preserving the live corpus.

The [live audit](evaluation-memory-quality-2026-10-05.md) observed 64 failed receipts among 318
accepted submissions, including 63 evolution-response contract failures. It also found unrelated
context expansion, noisy linked additions and some bookkeeping-only sources. These are attributed
snapshot observations, not proof that every failure has the same cause or that every link is poor.
Existing [prompt guidance](prompts.md) already requires concise, source-focused evolution; enforce
and evaluate that intent rather than replacing it with new summary semantics.

## Affected categories and rule ownership

| Category                                 | Required behavior and authoritative home                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source selection                         | Consumers select reusable observations and preserve attribution; [charter](project-charter.md#vision). AMEM accepts selected material without Nexus event policy.                                                                                                                                               |
| Valid ingestion                          | Validate source input and all generated decisions before writing, preserve sources and expose failure; [Memory](memory.md#insertion-decisions), [response validation](prompts.md#validation). Improve generation/contract adherence for the audited failure cases without silently accepting invalid decisions. |
| Durable outcomes and recovery            | Acceptance differs from storage. Preserve accepted work and explicitly recover known-unwritten failed observations; [queue](ingestion-queue.md#recovery-of-failed-observations). Uncertain writes follow existing replay/reconciliation rules.                                                                  |
| Concise evolution                        | Rewrite around the note's subject, retain meaningful evidence and caveats, and avoid unrelated status/history; [prompts](prompts.md#evolution-instructions). Correct identified existing contexts through [Memory](memory.md#existing-context-correction).                                                      |
| Direct and linked retrieval              | Keep relevant evidence inspectable, distinguish scored matches from bounded linked additions and support direct-only search; [Memory](memory.md#retrieval-and-inspection). Select meaningful links under existing prompt guidance.                                                                              |
| Quality evidence and corpus preservation | Compare source recovery, fidelity and noise before/after, account for failures and preserve the corpus; [evaluation](evaluation.md#quality-change-acceptance).                                                                                                                                                  |

This document owns the affected journey and observable acceptance examples. Detailed rules stay in
the linked owning documents; APIs, schemas, algorithms and implementation tasks belong to Architecture.

## Journey and activities

1. **Select and submit.** A producer selects one useful observation with conditions and evidence,
   supplies a stable source key and provenance, and receives durable acceptance or an explicit error.
2. **Process and inspect the outcome.** Ingestion constructs and evolves within the selected
   neighborhood, persists valid results, and exposes stored, retrying, failed or blocked outcomes.
   The producer can finish after acceptance; the operator can distinguish failures from an empty backlog.
3. **Recover retained work.** After the failure cause is corrected, the operator identifies
   known-unwritten failed observations and explicitly resumes them with their accepted identities.
   Uncertain work is reconciled or replayed under the existing rules.
4. **Retrieve and interpret.** An agent searches its question, reads direct and optional linked
   evidence with original content and provenance, and judges applicability and uncertainty.
5. **Correct and evaluate.** The operator identifies expanded existing contexts, preserves the
   baseline, corrects supported cases, and compares ingestion, context fidelity and retrieval
   before/after. Useful later evolution remains possible without turning a note into a subject catalogue.

## Observable acceptance examples

| Situation                                                                                   | Observable acceptance                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A valid observation triggers an audited evolution-contract defect                           | A representative reproduction ingests successfully after the correction with complete valid decisions and original source/provenance intact. Invalid responses still cause no partial write; remaining failures are diagnosed and counted.  |
| A failed observation remains in the journal but is absent from search                       | Explicit recovery after correcting the cause produces one stored note under the originally allocated identity. Receipt/source key, observation timestamp, provenance and attempt accounting survive; repeated recovery cannot duplicate it. |
| The failed attempt actually has uncertain persistence or a committed plan                   | Recovery does not generate a fresh insertion. Existing plan replay or explicit reconciliation resolves it before later writes.                                                                                                              |
| The backlog is empty but some accepted observations failed                                  | Status/receipt evidence still exposes those failures; the evaluation reports accepted and stored counts separately.                                                                                                                         |
| An unrelated checkpointing observation neighbors a source about retaining analysis evidence | The source's context stays focused on evidence retention and its qualifications. Shared vocabulary alone does not justify a link or copying checkpointing status into the context.                                                          |
| A later repair changes the interpretation of an earlier defect                              | The revised context attributes the repair evidence and preserves applicable limits. Repeated claims do not become independent verification, and a recommendation does not become a requirement.                                             |
| A retained audit context includes unrelated subjects and running history                    | Targeted correction removes the excess while preserving supported meaning. Original content, provenance, identity, source timestamp and links survive; changed semantics are searchable under their corresponding embeddings.               |
| An agent asks a known-topic audit question or an available paraphrase                       | Relevant-first direct recovery is retained on the comparison cases. With the same linked budget, identified noisy cases add less unrelated material while useful related sources remain available.                                          |
| An agent asks about a subject absent from the corpus                                        | Results remain attributed retrieved evidence; scores or linked additions do not establish an answer or applicability. No new answer-generation promise is introduced.                                                                       |
| A consumer receives only a routine approval or successful-check announcement                | Published source-selection guidance excludes that event alone as a lesson. Evaluation identifies bookkeeping-only sources and any required consumer follow-up; AMEM introduces no ticket-specific rejection or deletion policy.             |
| Recovery and context correction run against the live corpus                                 | A recoverable baseline is retained; every retained failed observation is accounted for and affected contexts are corrected or explicitly deferred. Existing source records are preserved and the live collection is not reset.              |

Acceptance uses [the existing comparison procedure](evaluation.md#quality-change-acceptance),
including semantic review and denominators. Deterministic protocol tests and model-quality evidence
remain distinct; a successful fixture alone does not establish general model reliability.

## Scope and unsettled choices

Include ingestion reliability, concise source-focused evolution, meaningful direct/linked retrieval,
explicit failed-observation recovery, warranted existing-context correction and before/after evidence.
Keep source extraction changes for Nexus in HARN if the consumer needs them; AMEM supplies general
guidance and preserves original submitted material. Existing bookkeeping-only notes are not deleted
or rewritten as if they contained lessons their sources never stated.

Retain existing bounds, retrieval classification, configurable prompts, strict decision validation,
single-writer ownership and uncertain-write protections. This outcome does not require automatic
pruning/merging, workflow filters, answer generation, a retrieval-time model, a schema-repair loop or
a prose-length gate. Architecture selects the corrective mechanism and maintenance interfaces,
using retained failure evidence rather than assuming a cause from the audit counts.

No global numerical reliability, context-length or retrieval-accuracy target has been selected.
The acceptance examples define the bounded change; any broader target or change to retrieval
policy/defaults remains an explicit product proposal requiring supporting evaluation and an owner
decision. No such decision is needed to proceed with these requirements.
