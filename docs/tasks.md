# Implementation task inventory

Jira is authoritative for current status. The baseline tasks were created in **To Do** with label
`memory-build`; dependency links and queue rank follow the sequence below. The baseline is
documentation-only. This index adds no architecture or acceptance requirements.

| Task                                                        | Scope                                                         | Prerequisites          |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ---------------------- |
| [AMEM-1](https://malton-family.atlassian.net/browse/AMEM-1) | Establish the library toolchain and public contracts          | None                   |
| [AMEM-2](https://malton-family.atlassian.net/browse/AMEM-2) | Implement the Qdrant NoteStore                                | AMEM-1                 |
| [AMEM-3](https://malton-family.atlassian.net/browse/AMEM-3) | Implement the pinned local embedding provider                 | AMEM-1                 |
| [AMEM-4](https://malton-family.atlassian.net/browse/AMEM-4) | Implement configurable prompts and the model boundary example | AMEM-1                 |
| [AMEM-5](https://malton-family.atlassian.net/browse/AMEM-5) | Implement note insertion, linking and evolution               | AMEM-2, AMEM-3, AMEM-4 |
| [AMEM-6](https://malton-family.atlassian.net/browse/AMEM-6) | Complete retrieval, inspection and library composition        | AMEM-5                 |
| [AMEM-7](https://malton-family.atlassian.net/browse/AMEM-7) | Implement reproducible replay and retrieval evaluation        | AMEM-6                 |
| [AMEM-8](https://malton-family.atlassian.net/browse/AMEM-8) | Implement offline memory graph inspection                     | AMEM-7                 |

Each task links to its owning repository sections. Read [development](development.md) for delivery
and packaging, [architecture](architecture.md) for component boundaries, and [testing](testing.md)
for verification. The [paper audit](paper-alignment.md) and [prototype findings](prototype-findings.md)
explain the baseline's evidence and limits. The baseline backlog does not include Nexus memory integration,
an HTTP server, npm publication, distributed writers or automatic interrupted-write recovery.

## Local dashboard

Implement the [Sigma dashboard](dashboard.md) in this dependency/queue order. These tasks use the
`memory-build` label and were created in To Do; Jira remains authoritative for current status.

| Task                                                          | Scope                                                                                                      | Prerequisites    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| [AMEM-10](https://malton-family.atlassian.net/browse/AMEM-10) | Public vector inspection and persisted update times per [NoteStore](note-store.md) and [Memory](memory.md) | Existing library |
| [AMEM-9](https://malton-family.atlassian.net/browse/AMEM-9)   | Local asynchronous inspection host and projection lifecycle                                                | AMEM-10          |
| [AMEM-11](https://malton-family.atlassian.net/browse/AMEM-11) | Sigma UI, asynchronous live updates and complete inspector verification                                    | AMEM-9           |
