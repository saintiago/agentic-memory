# Agentic Memory

A standalone memory library for agents, following the A-MEM approach: retain source notes,
connect related material, evolve contextual descriptions and retrieve useful experience. The design
documents in this repository define the contracts; implementation follows them.

Start with the [project charter](docs/project-charter.md) and [architecture](docs/architecture.md).
The [A-MEM audit](docs/paper-alignment.md) identifies adaptations, and the
[prototype findings](docs/prototype-findings.md) preserve the evidence behind the design.

The reference prototype remains at `/home/aiur/projects/amem-prototype2`; implementation requires
only this repository's docs. This project is independent of it and of Nexus.

## Usage

The package exports the provider contracts and the `AgenticMemory` operations: add source
material, search ranked direct matches with bounded linked expansion, and inspect stored notes. A
host supplies its own NoteStore, Embedder and LanguageModel implementations, owns their settings,
credentials and lifecycle, and constructs one instance per collection:

```ts
import { AgenticMemory } from "agentic-memory";

const memory = new AgenticMemory(store, embedder, model);
const note = await memory.add({
  content: sourceText,
  metadata: { origin: "host" },
});
const results = await memory.search(query, { limit: 5, linkedLimit: 5 });
const current = await memory.get(note.id);
const page = await memory.page(100);
```

Failures are `MemoryError` values naming the operation, stage and persistence; the
[memory design](docs/memory.md) defines the operations, and the [host examples](examples/README.md)
show the assembled composition with the pinned encoder, Qdrant storage and model transport.

Concurrent clients use the durable [ingestion queue](docs/ingestion-queue.md): it accepts an
observation after a local journal commit, deduplicates by source key, drains accepted work through
Memory's `prepare`/`apply` contract with one writer per collection, and replays persisted insertion
plans after a restart.

## Development

Use Linux or WSL with Node.js 24. Preparation installs the locked dependencies, and the aggregate
check covers formatting, linting, types, component boundaries, deterministic tests and the build:

```bash
npm ci
npm run validate
```

`npm run build` emits the ESM package and its type declarations into `dist/`; `npm run verify:pack`
packs that build and imports it from a temporary consumer directory. The real-infrastructure scopes
`npm run test:integration` (Qdrant) and `npm run test:embeddings` (pinned encoder artifacts) never
silently pass: the integration scope runs the NoteStore contract against a real isolated Qdrant
pinned to 1.19 and reports how to prepare it when none is available, and the embeddings scope
loads the pinned local encoder, downloading its artifacts into a cache on the first run.

`npm run demo:evaluation` replays the committed synthetic fixtures with an in-memory store and
deterministic stand-ins, writing run artifacts and a measurement report without a credential or
paid call; `npm run replay:live` is the explicit opt-in live run with a declared call/token budget.
`npm run graph:inspect` renders the offline inspection graph from a saved run directory: one
self-contained HTML report and the JSON evidence it shows, with no server or database.

`npm run service` starts the separate local memory service documented in
[docs/service.md](docs/service.md): it owns one configured collection, one durable ingestion queue
and one shared pinned encoder hosted in its own worker thread, accepts observations durably over
the versioned `/v1` HTTP API (published as [service/openapi.json](service/openapi.json)), and
reports submission, retrieval and ingestion availability while providers load or fail. The same
process serves the read-only Sigma dashboard at `/`, its inspection API under `/api` and live
`/api/events` updates on one listener; a completed write refreshes the projected view without
polling.
[service/README.md](service/README.md) lists its settings, supervision example and the client
boundary.

Operator recovery stays on the service API: `GET /v1/receipts` enumerates retained outcomes and
`POST /v1/receipts/:id/recover` requeues one failed observation once its cause is corrected. For a
reviewed correction of an existing note's generated context, stop the service and run
`npm run memory:maintain -- correct-context --input <proposal.json>`: the offline command takes
the same writer ownership, applies one reviewed plan and leaves a pending plan to replay before
later ingestion when the service restarts.

`npm run inspector` starts the development host of the same dashboard against a separately running
service API — it opens no database and loads no encoder. The dashboard never writes a memory; it
builds the Sigma UI in `inspector/ui`, which shows projected positions with directed links,
freshness, real requests and their highlighted results, and keeps them current from same-origin
WebSocket notifications documented in [docs/dashboard.md](docs/dashboard.md).
[inspector/README.md](inspector/README.md) lists its settings, the dashboard's behavior and the
recorded responsive browser checks (`npm run inspector:responsive`): the required scale check
against a synthetic 10,000-memory graph with about 50,000 directed links and the real-renderer
check that an added outlier does not move already displayed memories.

`npm run --silent mcp` starts the stdio MCP server documented in [docs/mcp.md](docs/mcp.md): a thin
client of the running service that exposes `memory_search` and `memory_save` to agent sessions. It
opens no database and loads no encoder, so concurrent sessions share the service's queue and
encoder; [mcp/README.md](mcp/README.md) publishes the launch command, settings, tool schemas and
behavior.

See [development and delivery](docs/development.md) for the commands and the build plan, and the
[implementation tasks](docs/tasks.md) for the backlog.
