# Documentation guide

Define intent before implementation. Correct code that contradicts it, or explicitly change the
requirement before implementing a different behavior. Do not rewrite requirements merely to match
existing code or a prototype.

- The charter owns purpose, vision and product scope. Architecture owns component boundaries,
  relationships and public behavioral contracts. Tech stack owns tools; testing owns verification
  approach. Component designs own detailed schemas, algorithms and failure behavior. Prompts own
  model instructions and response envelopes; development owns packaging and delivery checks.
- Keep the high-level architecture focused on ownership and interactions. Algorithms, file layouts,
  method signatures, schemas and provider protocols belong with their owning component when needed.
- Keep each requirement in one authoritative home and link to it from tasks. Tasks identify the
  problem, desired outcome and scope without adding hidden requirements or copied policy.
- Describe the intended system, not implementation progress, run history or ticket chronology.
  Keep progress in tasks and Git history, and raw experiment evidence with the experiment artifacts.
  The dedicated prototype-findings document preserves measured lessons and limits; the paper audit
  records fidelity decisions. Both are self-contained reference material, not duplicate contracts.
- Treat the separate prototype as reference evidence. Do not import it, move its data, or assume
  that every experimental choice is a requirement for the clean implementation.
- Keep the reference index in `AGENTS.md` synchronized. Keep README short and human-facing, without
  duplicating the document index. Review relative links and consistency when changing documentation.

Follow the documentation-first rebuild sequence: define purpose and boundaries, specify a component's
behavior when needed, then implement and validate against that contract. Do not copy implementation
into the new workspace as a substitute for design. Existing authorization covers the current agreed
scope; routine choices do not require an additional approval ceremony.
