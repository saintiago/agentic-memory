# Project charter

## Purpose

Help agents carry useful experience from earlier work into later decisions without rereading
entire histories. Retain what happened, preserve where it came from, and make relevant experience
available when a new task needs it.

Every proposal should answer: **Does this help an agent find and interpret useful prior experience
with less irrelevant context and a manageable operating cost?** More stored notes, more links or
longer summaries are not benefits by themselves.

## Vision

Provide a reusable memory capability that can serve different agents, applications and subjects.
New observations should enrich the context of related memories while preserving original sources
and distinctions such as attribution, applicability, time and jurisdiction. Retrieval should expose
enough evidence for the consuming agent to judge whether a memory applies.

Nexus is a prospective consumer. Its tickets, review findings, handoffs and workspace layout do not
define the memory model. Source extraction belongs to the application supplying memories.

## Core jobs

1. Accept source material as notes with optional provenance, independent of its originating workflow.
2. Generate concise context and semantic attributes, connect related notes and evolve their context
   as new material arrives.
3. Retrieve relevant notes and optional linked material, including original content and provenance.
4. Let developers inspect memory behavior and evaluate whether evolution improves retrieval over
   simpler baselines.

An experience is not a required aggregate of task, attempt, finding and response. Those may be
separate source notes whose relationships emerge through the memory mechanism.

## Product principles

- Follow the A-MEM mechanism before introducing additional memory policies. Improvements need
  evidence from representative retrieval and evolution behavior.
- Preserve original content. Generated context is an interpretation, not a replacement for evidence
  or an assurance of truth.
- Keep prompts configurable and project-agnostic. The host chooses its model and operating settings.
- Make relevance inspectable: distinguish direct similarity matches from linked additions and retain
  source provenance. Similarity is not proof of applicability.
- Keep unattended use understandable through explicit write outcomes, bounded work per operation
  and measurable model, storage and retrieval costs.

## Scope

The product is a library with replaceable infrastructure boundaries. Its initial design covers note
insertion, linking, evolution, retrieval and inspection. It uses Qdrant and embeddings directly,
without depending on the earlier A-MEM package or either prototype's implementation.

Artifact parsers, Nexus integration, an agent runtime, answer generation, a hosted service and a
production graph UI are separate consumer concerns. Automatic pruning, merging, permanent evolution
history, domain-specific filters and distributed concurrent writers are outside the initial scope.

## Evidence of value

Evaluate returned memories against known source evidence, including important conditions and
scope distinctions. Compare original-content, constructed-note and evolved-note retrieval; measure
linked expansion separately. An agent answering correctly from prior model knowledge does not
establish that memory helped.

Track relevant-source recovery, irrelevant context, fidelity of evolved statements, latency, model
usage and storage at declared corpus sizes. Small successful experiments justify development, not
claims of general retrieval quality or production-scale reliability. Purpose guides improvements;
no fixed accuracy or throughput promise is selected here.
