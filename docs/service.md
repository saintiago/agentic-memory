# Local memory service

## Purpose

Run memory as one supervised service under Linux/WSL, independently of agent processes. Multiple
clients submit observations and retrieve memories through a versioned HTTP JSON API. One service
instance owns one configured collection, one shared embedding runtime and one durable ingestion
queue. Agents do not load their own encoder, access the queue files or write the collection directly.

## Interface and ownership

The service composes the public [Memory](memory.md), [NoteStore](note-store.md),
[Embeddings](embeddings.md), [LanguageModel](language-model.md) and
[ingestion queue](ingestion-queue.md) contracts. It owns HTTP validation, settings, provider lifecycle
and availability reporting. The queue owns durability, writer exclusion, retry and crash recovery;
Memory owns semantic construction, evolution and retrieval. Do not duplicate those rules here.

Clients own source extraction and stable source identities. The dashboard is a read-only API
consumer served by the same process and HTTP listener; its inspection module owns projection. Neither client
nor dashboard receives provider credentials. The reusable library remains usable independently for
separately owned collections; it must not be a competing writer to the service-owned collection.

## API

Bind to `127.0.0.1:4748` by default, with an explicit port override. `/v1` selects the API contract
version. The configured collection is fixed for the instance; requests cannot select another store,
provider, model or filesystem path. Publish an OpenAPI definition with the service implementing
these routes and validate requests and responses against the owned schemas.

| Route                        | Request                                           | Response                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/observations`      | `{ sourceKey, content, timestamp?, provenance? }` | `202` after durable acceptance: receipt object and `Location: /v1/receipts/:id`. Identical resubmission returns `200` with the existing receipt.                  |
| `GET /v1/receipts/:id`       | Receipt identity                                  | `200` receipt object, or `404`.                                                                                                                                   |
| `POST /v1/search`            | `{ query, limit?, linkedLimit? }`                 | `200 { searchedAt, results }`, preserving Memory's complete notes, ordering, scores and match/link classifications.                                               |
| `GET /v1/notes/:id`          | Note identity                                     | `200` complete note, or `404`.                                                                                                                                    |
| `GET /v1/notes`              | Optional `limit` and opaque `cursor`              | `200 { notes, cursor? }` using public pagination.                                                                                                                 |
| `GET /v1/inspection/records` | Optional `limit` and opaque `cursor`              | `200 { records, cursor?, embeddingSpaceId }`; records contain complete notes and stored vectors for projection.                                                   |
| `GET /v1/status`             | None                                              | `200` collection identity, embedding-space identity, capability availability, queue counts by status, oldest pending age, and safe current error when applicable. |

Receipt objects contain `id`, `sourceKey`, `status`, `acceptedAt`, `updatedAt`, `attemptCount`,
optional `nextRetryAt`, safe `lastError`, and `noteId` once stored. Their statuses and transitions
follow the queue contract. A receipt ID and note ID are different identities. Source keys must be
stable and unique within the collection, including the producer's source namespace where needed.

Use Memory's public input constraints, defaults and pagination semantics. Encode cursors as opaque
URL-safe tokens preserving the underlying string/number value; clients return them unchanged.
Inspection is paginated and not an atomic snapshot. Search and inspection do not generate text or
write memories. Search sees stored records; it does not wait for the ingestion backlog to drain.

Errors return `{ error: { code, message, retryable } }`, with sanitized messages. Invalid requests
return `400`; a source key reused with different input returns `409`; configured body-size overflow
returns `413`. Default maximum JSON body size is 1 MiB, measured in UTF-8 bytes. Temporary overload
returns `429` with `Retry-After`; unavailable capability returns `503`; unexpected failure returns
`500`. A provider failure must not become an empty successful search or acceptance response.

## Async work and resource sharing

Submission awaits only the queue's durable commit, never model generation or vector storage.
Disconnecting after acceptance does not cancel the observation. Lost responses are resolved by
resubmitting the identical source key and payload; the service returns the existing receipt.
Clients may poll receipt status. Dashboard graph updates use the WebSocket notification channel
defined in [dashboard updates](dashboard.md#websocket-updates).
The client classifies interrupted response bodies, including timeouts after headers, as retryable
transport failures and preserves the received HTTP status and cause. Fully received malformed JSON
is a separate protocol failure.

The service loads one pinned encoder and shares it between query and insertion requests.
Use bounded scheduling of inference with fair admission so ingestion cannot indefinitely starve
search and bursts cannot create unbounded in-memory work. Serialize model access when required by
the encoder runtime; concurrent HTTP requests do not promise parallel inference. Run blocking
inference and journal operations outside the HTTP event loop. Only the durable queue accumulates
accepted ingestion work. Projection runs in a background worker owned by the service, outside the HTTP event loop.

## Availability, restart and shutdown

Start the API and durable queue independently of provider initialization. Status reports separate
availability for submission, retrieval and ingestion. With a healthy journal, submissions remain
available while the encoder loads or the database/model is down; unavailable reads return `503`.
A dead service cannot acknowledge submissions: the client retains its source observation and retries
the same identity after reconnection. Durability is guaranteed only after acceptance, including an
acceptance whose response was lost. Do not claim that an unsent observation is already queued.
Retain a known operation outage until that operation succeeds; unrelated reads or writes do not
demonstrate recovery. Capability availability aggregates these operation outcomes without requiring
health probes.

The provider runtime supervises the encoder thread for its full lifetime, including idle exits.
After a terminal failure it releases the failed encoder and replaces it through the bounded provider
retry loop, retaining the shared scheduler, store and durable observations. Ordinary inference
rejections report an outage without replacing a healthy thread.

The host supervisor starts and restarts the service independently of Nexus task lifetimes. Acquire
queue ownership before starting its worker and reject a second service using the same queue. On
restart, resume accepted work and replay interrupted plans using the queue recovery contract before
later mutations. Do not start Qdrant implicitly or require a new agent handoff to trigger recovery.

On shutdown stop admitting new requests and claiming new work, settle active submissions, and allow
the current operation to finish within the host's shutdown grace period. A forced exit relies on the
durable journal; it must not mark an interrupted write stored. Release owned providers on clean exit.

## Bundled dashboard

One service process, configuration and startup command serve both memory and inspection at the
same loopback address (default `http://127.0.0.1:4748`). Serve the built Sigma dashboard at `/` and
its assets from the same origin. Keep `/v1/...` memory API routes unchanged and mount the existing
`/api/...` dashboard routes from [the dashboard contract](dashboard.md#browser-api) on that listener.
Unknown API routes return API errors, never a successful HTML fallback.

Compose the inspection module with the service's existing public read/search capabilities and
paginated vector source in-process. Do not call the service through its own HTTP listener, create
another Memory instance, load another encoder, or give inspection a separate database client.
Preserve public boundaries: the service composition supplies focused contracts, not private imports.
The browser remains a read-only consumer; projection, refresh and vector comparison stay server-side.

Start the API without waiting for the first export or projection. Serve a loading graph until ready.
Provider and projection failures preserve the last completed view with an explicit error, while
submission and unrelated API operations remain available. Projection runs in a background worker;
coalesce refreshes, retain asynchronous browser updates, and preserve camera and selection state.
A missing dashboard build produces an explicit dashboard-unavailable response without disabling
memory API access or returning a misleading empty graph.

`npm run service` is the single launch command and must prepare or locate the bundled UI assets;
the production installation guide includes the asset build. Service shutdown owns WebSocket connections, the projection
worker, refresh/retry timers and HTTP listener in addition to memory resources. Document one supervised
service, one port and one configuration. The standalone inspector command may remain for development,
but it is not required for deployment. Avoid duplicating its route and projection implementations.

Verify the root/assets, unchanged `/v1` responses and mounted `/api` routes on one listener; query
highlighting and automatic refresh; one encoder instance; API responsiveness during projection;
startup with unavailable providers; missing UI assets; WebSocket reconnect/resync; and clean shutdown
of inspection workers. The service invalidates inspection after completed ingestion/recovery writes
and exposes `/api/events` on the same listener, replacing steady-state dashboard polling.

## Configuration and local access

The service owns database connection, collection identity, durable directory, pinned encoder/cache,
model endpoint and credentials, HTTP port and request-size limit. Store durable state outside task
workspaces. Consumers configure only the service URL and their source identity; connection failures
remain explicit. No Nexus-specific configuration discovery is part of the service.

The concrete variables, launch command, supervision example and client usage are in
[service/README.md](../service/README.md); the service publishes the route definition in
[service/openapi.json](../service/openapi.json).

Initial deployment is loopback-only and trusts local operating-system users. Do not enable permissive
CORS. Requests must name the bound loopback authority: reject a foreign `Host` header and a browser
`Origin` that is not that authority, so a hostname rebound to the loopback address cannot reach the
API. State-changing requests require JSON. The bundled dashboard uses same-origin routes and exposes
no memory-editing controls. Its UI is read-only; observation submission remains an API capability. Remote binding, authentication for remote clients
and multi-host service replicas are outside scope.

## Migration and verification

Stop direct writers, import existing receipts according to the queue contract, then switch all agents
and the dashboard to the service URL. Preserve existing collection and embedding identity. Do not
run an old direct writer alongside the service or silently fall back to direct access when it fails.

Contract tests cover each endpoint, validation, duplicate/conflicting submissions, pagination and
error classification. Integration tests exercise concurrent clients with one encoder and writer,
submission during provider outage, reads during ingestion, lost HTTP acknowledgement, and service
restart with accepted and partially applied work. The pinned-artifact encoder check loads the
pinned encoder through the service's own encoder thread and confirms it serves the same vectors as
the in-process reference encoder. Reuse queue recovery tests instead of redefining their algorithm.
Verify dashboard refresh and query highlighting through the service API, and that an unavailable
service does not turn a successful agent task into a false memory-storage success.
