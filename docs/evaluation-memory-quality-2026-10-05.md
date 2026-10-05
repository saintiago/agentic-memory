# Live memory quality audit — 5 October 2026

## Evidence and limits

Read-only inspection covered a 252-note/609-directed-link snapshot of the shared Nexus memory
collection after its 29 September archive/reset, sampled source/context pairs and links, agent
invocation logs, queue receipts, and eight public HTTP search probes. During the audit the live
collection reached 254 notes/618 links. This is a spot check, not a controlled benchmark of agent
productivity. The collection includes Nexus and Keeper experience; these are consumer examples,
not domain-specific requirements for the memory library.

## Observations

- Agent logs recorded 954 search calls (404 working-agent calls and 550 analyst calls) and 207
  explicit save calls. Agents used results alongside code inspection and tests; tool use alone
  does not establish an improvement in outcomes.
- Of 318 durable submissions, 254 were stored and 64 failed permanently: 63 evolution-response
  contract failures and one unusable model-output failure. Failed submissions remain in the queue
  journal but are absent from retrieval. An empty backlog does not establish successful ingestion.
- Many notes preserve useful mechanisms, evidence and caveats. Others retain commit-reference
  corrections or repeated workflow applicability decisions with little reusable substance.
- Forty-nine of 252 notes had context longer than twice their original content. Note
  `9604b08a-34a1-4950-9e1a-d79127d11369` has an 800-character source and an 8,406-character context
  combining analysis-evidence retention, oversized review input and XState checkpointing. Note
  `f8dd980a-77b7-472f-bfc2-dd2ba7a2a17a` has a 515-character source and a 6,850-character context
  spanning separate deployment mechanisms. These violate the existing prompt intent of concise,
  source-focused evolution. Full original sources remain available.
- All inspected link targets existed, with no self-links. Sampled strong links connect defects,
  repairs and later regressions; weaker links connect different mechanisms through broad stale-state
  or revision-identity themes. Search expansion added both useful background and unrelated material.

## Retrieval probes

Use existing notes as source evidence; do not create observations merely to test search. The four
known-topic queries below each ranked a relevant source first with `limit: 3`. Three natural-language
paraphrases of the first three subjects also retrieved the same relevant source first. Linked
expansion with `linkedLimit: 3` added noise in several cases; `linkedLimit: 0` isolates direct search.

| Query subject                                                          | Relevant source note                   |
| ---------------------------------------------------------------------- | -------------------------------------- |
| TypeScript readdir overload makes text names appear as Buffer          | `c542fd47-6869-4928-9121-11e6ecbb816e` |
| CloudFormation executable change set with empty resource Changes       | `01475a15-b3f7-4995-933d-414f26b61061` |
| Relative public-entry imports bypass workspace dependency declarations | `fc9d46a8-617f-4b49-ba53-bb0906904a5a` |
| Prototype applicability for internal repository/CI restructuring       | `2a89cc81-556a-4ccc-8665-f25a51aa5e63` |

The uncovered question “How do we protect agents from malicious prompt instructions in saved
memories?” returned unrelated matches and linked additions. Similarity scores are not applicability
or confidence; returning neighbors does not establish that an answer is present.

## Owning references

Existing intended behavior and evaluation guidance are in [prompts](prompts.md), [Memory](memory.md),
[ingestion queue](ingestion-queue.md), [LanguageModel](language-model.md),
[evaluation](evaluation.md) and [MCP tools](mcp.md). Requirements, UX and Architecture preparation
must assess the requested improvements against these documents before implementation.
