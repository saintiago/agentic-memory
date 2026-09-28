# Local memory service

The separate local process of the [documented memory service](../docs/service.md). It owns one
configured collection, one durable [ingestion queue](../docs/ingestion-queue.md), one shared pinned
encoder and the loopback `/v1` HTTP API. Producers submit observations over HTTP; the service
accepts them durably and its supervised worker applies them through Memory's public prepare/apply
contract. Clients never open the queue files, load an encoder or write the collection.

The implementation lives here:

| Module                | Responsibility                                                                         |
| --------------------- | -------------------------------------------------------------------------------------- |
| `main.ts`             | Entry point: settings, startup, signal handling                                        |
| `settings.ts`         | Every `AMEM_*` host setting, validated before the journal or a provider is opened      |
| `lifecycle.ts`        | Composition: journal and worker ownership first, provider initialization in background |
| `providers.ts`        | Lazy provider stack with bounded retries and per-capability availability               |
| `scheduler.ts`        | Bounded, fair admission of inference shared by ingestion and search                    |
| `encoder-host.ts`     | Host side of the shared encoder thread: load, inference requests and release           |
| `encoder-worker.ts`   | Worker entry that loads the pinned encoder and serves inference off the HTTP loop      |
| `encoder-protocol.ts` | The inference message protocol and its pure handler                                    |
| `service.ts`          | Submission, retrieval, inspection and availability behavior behind the HTTP layer      |
| `server.ts`           | The `/v1` routes, request/response validation, origin and body rules, error mapping    |
| `client.ts`           | The typed, validating client boundary consumers and the dashboard host use             |
| `supervisor.ts`       | Restarts a stopped ingestion worker inside the service process                         |
| `openapi.json`        | The published OpenAPI 3.1 definition of exactly the implemented routes                 |
| `model-transport.ts`  | The OpenAI-compatible LanguageModel transport the service composes                     |

## Launching

From the repository root:

```bash
export AMEM_QDRANT_URL=http://127.0.0.1:16333
export AMEM_QDRANT_COLLECTION=amem-notes
export AMEM_MODEL_ENDPOINT=https://api.deepseek.com/chat/completions
export AMEM_MODEL_ID=deepseek-chat
export AMEM_MODEL_API_KEY=host-owned-secret
export AMEM_SERVICE_DATA_DIR=/var/lib/amem/service
npm run service
```

The process prints the loopback URL it serves (`http://127.0.0.1:4748/` by default). It opens the
durable journal and takes queue ownership before it starts the listener, then loads the encoder,
opens the collection and builds the model transport in the background. The listener answers while
those providers are unavailable: submissions remain durable and `GET /v1/status` reports retrieval
and ingestion as unavailable with a safe diagnostic. A second service naming the same queue is
refused instead of starting a competing writer.

The pinned encoder loads and runs in its own worker thread. Its blocking tokenization and native
inference therefore never stall HTTP requests, durable submission acknowledgements, status reports
or shutdown timers, and one loaded encoder still serves both ingestion and search. The bounded
scheduler serializes inference; `GET /v1/status` reports a capability as unavailable from the
moment a provider failure is observed until that capability serves again.

`npm run service` runs `service/main.ts` through the pinned `tsx` loader. The process stops on
`SIGINT` or `SIGTERM`: it stops admitting requests, settles accepted requests and the active
operation, closes the journal and exits. If it does not stop within
`AMEM_SERVICE_SHUTDOWN_GRACE_MS`, the host forces the exit; the durable journal holds every accepted
observation and the next start replays interrupted insertion plans before later mutations.

### Supervision

The service is a standalone process, so a host supervisor owns restarting it independently of
agent tasks. Any supervisor works; for example a systemd user unit:

```ini
[Unit]
Description=Agentic Memory local service
After=network.target

[Service]
WorkingDirectory=%h/agentic-memory
EnvironmentFile=%h/.config/amem/service.env
ExecStart=/usr/bin/npm run service
Restart=always
RestartSec=2
TimeoutStopSec=35
KillSignal=SIGTERM

[Install]
WantedBy=default.target
```

The service also supervises the pieces a crash would otherwise strand: a failed provider
initialization keeps retrying with bounded backoff, and a stopped ingestion worker is restarted
inside the process.

## Settings

Every setting comes from the host environment; nothing is discovered from Nexus. A missing or
malformed value fails before the journal, the listener or a provider is touched. That includes the
provider-owned rules: the Qdrant URL, credential, collection and timeout and the model endpoint,
model ID, credential and request bounds are validated before the durable journal is created or
bound, so a corrected configuration starts a fresh queue instead of a journal already owned by an
unusable endpoint.

| Setting                          | Default            | Meaning                                                                 |
| -------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `AMEM_SERVICE_PORT`              | `4748`             | Loopback port; `0` selects a free port                                  |
| `AMEM_SERVICE_DATA_DIR`          | `.data/service`    | Durable queue directory; keep it outside temporary and task directories |
| `AMEM_SERVICE_BODY_LIMIT_BYTES`  | `1048576`          | Maximum JSON body size in UTF-8 bytes                                   |
| `AMEM_SERVICE_SHUTDOWN_GRACE_MS` | `30000`            | Grace period before the host forces an exit                             |
| `AMEM_QDRANT_URL`                | required           | Qdrant endpoint of the service-owned collection                         |
| `AMEM_QDRANT_COLLECTION`         | required           | The one collection this service owns                                    |
| `AMEM_QDRANT_API_KEY`            | none               | Qdrant credential; never returned to clients                            |
| `AMEM_QDRANT_TIMEOUT_MS`         | `120000`           | Qdrant request timeout                                                  |
| `AMEM_EMBEDDING_CACHE`           | `.data/embeddings` | Pinned encoder artifact cache shared by ingestion and search            |
| `AMEM_ALLOW_EMBEDDING_DOWNLOADS` | `true`             | Whether a missing pinned encoder artifact may be downloaded             |
| `AMEM_MODEL_ENDPOINT`            | required           | Full chat-completions URL of the model the service invokes              |
| `AMEM_MODEL_ID`                  | required           | Provider model ID                                                       |
| `AMEM_MODEL_API_KEY`             | none               | Model credential; never returned to clients                             |
| `AMEM_MODEL_TIMEOUT_MS`          | `120000`           | Model request timeout                                                   |
| `AMEM_MODEL_MAX_OUTPUT_TOKENS`   | `6000`             | Provider output-token budget for one request                            |

The queue directory holds the SQLite journal and the worker lock; back up the journal together with
the collection. The encoder cache and the journal stay outside the repository's published package.

## API and client boundary

The service implements exactly the routes documented in [docs/service.md](../docs/service.md#api);
[openapi.json](openapi.json) is the published OpenAPI 3.1 definition of the same route set.
Consumers configure only the base URL and their own source identity:

```ts
import { createMemoryServiceClient } from "./service/client.js";

const client = createMemoryServiceClient({ url: "http://127.0.0.1:4748" });
const submission = await client.submit({
  sourceKey: "task-42/observation-1",
  content: "The deployment requires an approval record.",
});
const receipt = await client.receipt(submission.receipt.id);
const { results } = await client.search("deployment approval", { limit: 5 });
```

`submit` reports whether the call created the receipt, so a client whose response was lost can
resubmit the identical source key and payload and find the same receipt. The client validates every
served body, keeps cursors opaque, maps a missing note or receipt to `undefined` and reports every
other failure as a `ServiceClientError` with its status, code and retryability.

Consumers reach the service through the loopback authority it serves (`127.0.0.1:port`, or
`localhost:port` for the same machine). A request whose `Host` names anything else is refused
before routing, and a browser `Origin` must name a trusted loopback authority; this is the
deployment's DNS-rebinding guard, not a general remote-access boundary.

## Checks

`npm run validate` covers the service component tests:

- the HTTP contract of every route, request validation, duplicate and conflicting submissions,
  body-size overflow, untrusted origins, missing records, method and route failures;
- opaque cursor round-trips through the note and inspection pages;
- availability: submission while the providers are unavailable, retrieval `503`, status reporting,
  recovery once initialization succeeds, and capability outages reported until the capability
  serves again (invalid input is never an outage);
- a blocking encoder hosted in its own worker thread: HTTP requests, receipts and status keep
  answering while inference occupies the thread, and the real worker entry reports a failed pinned
  load as a safe diagnostic;
- bounded fair scheduling: ingestion does not starve a waiting search, and overload is an explicit
  `429` with `Retry-After`;
- supervised lifecycle: worker restart after a stopped worker, graceful shutdown that stops
  claiming queued work before it waits for in-flight requests and settles the active operation, and
  a second service refusing the same queue;
- transport and configuration guards: a rebound hostname with a matching Origin is refused without
  reaching the queue, and malformed provider endpoints or credentials are refused before the
  journal is created;
- restart recovery through the service: accepted observations and partially applied plans are
  replayed by a new process over the same queue directory.

The authoritative behavior is [docs/service.md](../docs/service.md); the queue semantics the
service composes are [docs/ingestion-queue.md](../docs/ingestion-queue.md).
