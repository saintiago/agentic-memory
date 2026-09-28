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
inspector/        # local inspection host: entry point, HTTP API and projection worker
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

| Command                | Responsibility                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `format:check`         | Check source and Markdown formatting without changing files                                |
| `lint`                 | ESLint                                                                                     |
| `typecheck`            | TypeScript static checking                                                                 |
| `boundaries`           | Dependency Cruiser public imports and dependency directions                                |
| `test`                 | Deterministic unit/component tests, no paid calls or external services                     |
| `test:integration`     | Isolated real-Qdrant contract and system checks; clearly report unavailable infrastructure |
| `test:embeddings`      | Explicit pinned-artifact encoder integration check                                         |
| `demo:evaluation`      | Deterministic in-memory replay of the synthetic fixtures with its measurement report       |
| `replay:live`          | Opt-in live replay with a declared call/token budget and recorded stopping reason          |
| `graph:inspect`        | Offline HTML graph and JSON evidence rendered from one saved run directory                 |
| `inspector`            | Local inspection host serving the loopback browser API and the built Sigma dashboard       |
| `inspector:build`      | Bundle the browser dashboard of the inspection UI                                          |
| `inspector:responsive` | Real-browser scale, responsiveness and camera-preservation checks of the dashboard         |
| `build`                | Produce JavaScript ESM and type declarations                                               |
| `validate`             | Formatting, lint, types, boundaries, deterministic tests and build                         |

Integrations must not silently skip and report success when requested. Separate expensive model
loading and external-state checks from deterministic cacheable validation. The first foundation
change establishes the real toolchain; subsequent tasks add their tests to the appropriate scopes.

Validate a packed build from a temporary consumer directory before considering the library usable.
`npm run verify:pack` builds, packs and installs the package there, and the consumer check exercises
the public exports and the assembled add, search and inspection operations without
repository-relative imports. The package must not include private fixtures, `.data`, secrets, model
caches or prototype paths as runtime dependencies. Document public usage and fresh Linux/WSL
preparation. Publishing to npm, deploying a server and integrating Nexus as a memory consumer are
not part of this backlog.

### Local Qdrant fixture

`npm run test:integration` runs against real Qdrant 1.19. The pinned fixture publishes a dedicated
port, so a prototype or user instance on the default port is never touched and no volume is
retained:

```bash
docker compose -f test/integration/fixtures/qdrant/compose.yaml up -d
AMEM_QDRANT_URL=http://127.0.0.1:16333 npm run test:integration
docker compose -f test/integration/fixtures/qdrant/compose.yaml down
```

Without Docker, point `AMEM_QDRANT_BIN` at a pinned Qdrant 1.19 binary. The fixture starts it on a
free port with a temporary storage directory and removes both on shutdown:

```bash
AMEM_QDRANT_BIN=/path/to/qdrant npm run test:integration
```

Each case uses uniquely named collections and removes them, including after a failure. A server
that is not Qdrant 1.19, or a missing server, fails the run with these instructions instead of
reporting a pass.

### Local encoder fixture

`npm run test:embeddings` loads the pinned `Xenova/bge-m3` revision through Transformers.js with the
declared q8 CPU settings and verifies the space identity, vector dimensions, normalization and
long-input truncation, and that a complete cache initializes and embeds with network access blocked.
Artifacts are cached under `AMEM_EMBEDDING_CACHE` (default `.data/embeddings`), which is not
published; the first run downloads about 590 MB from the pinned revision, and later runs reuse the
cache offline. A run without the artifacts and without network access fails instead of reporting a
pass. The check is separate from the cached `npm run validate` scope because it loads a real model.

### Replay and evaluation runs

`experiments/` holds the replay and comparison consumers specified by [evaluation](evaluation.md);
they import the public contracts only and are covered by `npm run validate`.
`npm run demo:evaluation` replays the committed synthetic fixtures with an in-memory store and
deterministic stand-ins, writes a fresh run directory under `AMEM_DEMO_RUNS_DIR`
(default `.data/evaluations`) and prints the measurement report. It needs no credential, external
service or paid call, and repeated runs make the same decisions.

`npm run replay:live` is explicit opt-in: it requires the `AMEM_LIVE_*` host settings, including the
Qdrant endpoint, the provider endpoint and model ID, and a declared call and token budget. It stops
at that budget with the stopping reason recorded, uses no implicit retries and fails instead of
reporting a pass when a required setting is missing. Run directories, live collections and private
source corpora stay outside the published package; a run deletes only the disposable collections it
created unless the host asks to keep them. [experiments/README.md](../experiments/README.md) lists
every setting and artifact.

`npm run graph:inspect` renders one saved run directory into `<run directory>/graph/graph.html` and
`<run directory>/graph/graph.json`; `AMEM_GRAPH_RUN_DIR` names the run directory and
`AMEM_GRAPH_OUT_DIR` overrides the output location. The offline report reads the saved artifacts
only, needs no service and fails instead of reporting a pass when the run directory or a required
artifact is missing.

## Nexus delivery configuration

The repository's [nexus.project.json](../nexus.project.json) is the sole project delivery configuration.
Nexus runs from WSL; its host credentials and runtime settings remain outside this repository.
The Jira project is [AMEM](https://malton-family.atlassian.net/jira/software/projects/AMEM/boards/68)
and repository is [saintiago/agentic-memory](https://github.com/saintiago/agentic-memory).

Delivery selects Task issues labeled `memory-build` in To Do, ordered by Rank. The existing project
configuration names the workspace and pull-request fields and all delivery/refinement statuses.
Do not duplicate their IDs in implementation code or read this configuration from the memory library.

Nexus preparation installs the locked dependencies with `npm ci` and delivery runs the aggregate
`npm run validate` check. Subsequent components keep the aggregate check complete. Relevant
real-provider tests are performed and reported per [testing](testing.md), not replaced by cached
unit success.

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
