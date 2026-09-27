# Development and delivery

## Repository layout and public boundaries

Use one npm package initially. Give each logical component a directory with a public `index.ts`
and keep internal helpers behind it. The package root re-exports supported public APIs. Consumers,
tests spanning components and examples must not import another component's private modules.
The layout is:

```text
src/
  memory/          # orchestration, response interpretation, prompts
  note-store/      # note schema and persistence contract; Qdrant implementation
  embeddings/      # encoder contract, settings and local implementation
  language-model/  # host invocation contract
  index.ts        # supported package exports
examples/         # host composition and provider transport example
experiments/      # replay, evaluation and graph artifact consumers
test/             # contract/integration/system fixtures and journeys
docs/             # authoritative design
```

Unit/component tests may be colocated with their owner. The physical layout enforces the logical
boundaries in [architecture](architecture.md#relationships-and-replacement); it does not introduce
extra packages. Model-response schemas belong under memory, persisted-record schemas under
note-store, and each owner derives TypeScript types from its runtime schemas. Public interfaces can
be established before their concrete implementations without temporary methods that report success.

## Toolchain and validation commands

Follow [tech stack](tech-stack.md) and [testing](testing.md). Pin Node 24, lock dependencies, and
provide these npm scripts:

| Command            | Responsibility                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `format:check`     | Check source and Markdown formatting without changing files                                |
| `lint`             | ESLint                                                                                     |
| `typecheck`        | TypeScript static checking                                                                 |
| `boundaries`       | Dependency Cruiser public imports and dependency directions                                |
| `test`             | Deterministic unit/component tests, no paid calls or external services                     |
| `test:integration` | Isolated real-Qdrant contract and system checks; clearly report unavailable infrastructure |
| `test:embeddings`  | Explicit pinned-artifact encoder integration check                                         |
| `build`            | Produce JavaScript ESM and type declarations                                               |
| `validate`         | Formatting, lint, types, boundaries, deterministic tests and build                         |

Integrations must not silently skip and report success when requested. Separate expensive model
loading and external-state checks from deterministic cacheable validation. The first foundation
change establishes the real toolchain; subsequent tasks add their tests to the appropriate scopes.
Provide a pinned local Qdrant fixture and cleanup instructions with the persistence implementation.

Validate a packed build from a temporary consumer directory before considering the library usable.
The package must not include private fixtures, `.data`, secrets, model caches or prototype paths as
runtime dependencies. Document public usage and fresh Linux/WSL preparation. Publishing to npm,
deploying a server and integrating Nexus as a memory consumer are not part of this backlog.

## Nexus delivery configuration

The repository's [nexus.project.json](../nexus.project.json) is the sole project delivery configuration.
Nexus runs from WSL; its host credentials and runtime settings remain outside this repository.
The Jira project is [AMEM](https://malton-family.atlassian.net/jira/software/projects/AMEM/boards/68)
and repository is [saintiago/agentic-memory](https://github.com/saintiago/agentic-memory).

Delivery selects Task issues labeled `memory-build` in To Do, ordered by Rank. The existing project
configuration names the workspace and pull-request fields and all delivery/refinement statuses.
Do not duplicate their IDs in implementation code or read this configuration from the memory library.

This documentation bootstrap has no executable checks yet. The foundation implementation must set
preparation to `npm ci` and a delivery check to `npm run validate` using Nexus's project command schema.
Subsequent components keep the aggregate check complete. Relevant real-provider tests are performed
and reported per [testing](testing.md), not replaced by cached unit success.

GitHub delivery follows the reference projects: main branch, Nexus Lens review check, stale-review
dismissal, zero separately required approving reviews, no force pushes/deletion, admin enforcement,
squash merging and automatic branch cleanup. GitHub Actions is disabled; delivery checks run through
Nexus. Do not add a second CI system to complete a component task.

## Implementation sequence

Establish toolchain and public contracts; implement persistence, embeddings and model/prompt
boundaries; implement insertion/evolution; assemble retrieval and consumer usage; then implement
replay/evaluation and graph inspection. [Task inventory](tasks.md) maps this sequence to Jira.
Tickets state scope and link to the owning docs. Any new requirement must first be documented at
its owning boundary rather than being added only to a ticket.
