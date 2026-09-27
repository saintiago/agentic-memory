# Agentic Memory

A standalone memory library for agents, following the A-MEM approach: retain source notes,
connect related material, evolve contextual descriptions and retrieve useful experience. The design
documents in this repository define the contracts; implementation follows them.

Start with the [project charter](docs/project-charter.md) and [architecture](docs/architecture.md).
The [A-MEM audit](docs/paper-alignment.md) identifies adaptations, and the
[prototype findings](docs/prototype-findings.md) preserve the evidence behind the design.

The reference prototype remains at `/home/aiur/projects/amem-prototype2`; implementation requires
only this repository's docs. This project is independent of it and of Nexus.

## Development

Use Linux or WSL with Node.js 24. Preparation installs the locked dependencies, and the aggregate
check covers formatting, linting, types, component boundaries, deterministic tests and the build:

```bash
npm ci
npm run validate
```

`npm run build` emits the ESM package and its type declarations into `dist/`; `npm run verify:pack`
packs that build and imports it from a temporary consumer directory. The real-infrastructure scopes
`npm run test:integration` (Qdrant) and `npm run test:embeddings` (pinned encoder artifacts) are
empty until those components exist, so they report that no cases were found instead of passing.

See [development and delivery](docs/development.md) for the commands and the build plan, and the
[implementation tasks](docs/tasks.md) for the backlog.
