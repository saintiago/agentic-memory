# Tech stack

## Platform and language

Run on Linux. On Windows, dependency installation, builds, tests and library execution take place
inside WSL. Use Node.js 24, TypeScript ES modules and npm. The deliverable is a library; a web server,
browser application or workflow engine is not required.

## Infrastructure

| Boundary                           | Initial technology                                                                              | Selection ownership                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Note persistence and vector search | Qdrant through its maintained JavaScript client                                                 | NoteStore implementation and host connection configuration                             |
| Local embeddings                   | Transformers.js with BGE-M3, quantized q8, normalized CLS pooling and 1,024-dimensional vectors | Embeddings implementation; model revision and encoding settings fixed for a collection |
| Language-model invocation          | Host-supplied LanguageModel implementation                                                      | Host chooses provider, model, credentials, timeout and retry settings                  |

Use the direct Qdrant and embedding libraries. Do not depend on `@amemhq/core` or either prototype.
DeepSeek Flash with thinking disabled is the reference experiment configuration, not a mandatory
consumer model or a reason to couple Memory to a provider API. Explicitly record model settings
when evaluating behavior.

Credentials belong in host configuration, not source, fixtures or published packages. Use maintained
libraries for established infrastructure and keep integration glue small. Additional dependencies
must reduce total implementation and maintenance complexity.

## Contracts and validation

Use Zod for runtime validation at external data boundaries. The owning component defines each schema
once and derives TypeScript types from it where runtime validation is needed. Static types do not
validate stored payloads or model responses.

Use TypeScript for static checking, ESLint for linting and Prettier for formatting source and
documentation. Use Dependency Cruiser to enforce the architecture's public imports and dependency
directions, including type-only imports.

Use Turborepo for local deterministic validation caching and tool-native caches where appropriate.
Declare complete inputs and outputs. Live provider checks, experiments and external storage state
are not established by cached results.

## Testing and reproducibility

Use Vitest for unit, component, integration and system tests, including contract tests. Use its
assertions, supplied dependencies, fake timers and lifecycle hooks. Use Node.js standard filesystem
and process APIs for isolated integration resources.

Run persistence integration tests against an isolated real Qdrant instance. Keep model evaluation
separate from routine validation. There is no browser-test or Python requirement for the library;
experimental tools can use their own tooling without becoming runtime dependencies.

Commit dependency lockfiles and pin the Qdrant version and embedding model revision used for
repeatable checks. Document preparation from a fresh Linux/WSL checkout. Provide focused checks and
an aggregate validation command covering formatting, linting, types, boundaries, tests and build.
Verify that an intentionally forbidden import fails the boundary check.

Component boundaries do not require npm workspaces or one package per component. Begin with the
simplest layout that enforces the contracts. Publication, CI and deployment choices are separate
from this documentation baseline.
