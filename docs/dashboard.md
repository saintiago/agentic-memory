# Memory inspection dashboard (Sigma.js)

## Purpose and scope

Provide a local, personal inspection dashboard to evaluate stored memories: explore semantic
neighborhoods and explicit links together, see freshness, and run real memory requests with their
results highlighted. This is a personal inspection tool, not a Nexus production frontend. It does not change the memory algorithm or introduce memory editing.

The dashboard complements the offline graph report in
[evaluation](evaluation.md#graph-inspection). That report uses a topology layout with no semantic
position meaning; this dashboard uses an explicitly labeled embedding projection. Quality judgments
still require reading evidence: clusters, freshness and connectivity do not establish correctness.

## Tools and ownership

Use **Sigma.js v3 with Graphology** for the browser graph. Pin exact compatible versions when
implementing; this design uses the stable v3 API, not the v4 alpha. Both libraries use MIT licenses.
Sigma owns rendering and camera interaction; Graphology holds the displayed nodes and directed edges.
The local memory service serves the browser UI and inspection routes on its existing loopback listener.
Keep its dependencies and entry point separate from the runtime library; no React requirement.
The inspection module lives in `inspector/` and is composed by `npm run service`; its
settings and checks are documented in [inspector/README.md](../inspector/README.md). The browser UI
lives in `inspector/ui/` as TypeScript modules — a host client, a worker that parses and diffs
served payloads, a Graphology display model, inert DOM panels and the Sigma adapter — and
`npm run inspector:build` bundles them into the served directory together with the entry page and
its stylesheet. Only those modules import Sigma, so the data access, projection and display
contracts stay independent of the renderer.

Projection runs outside the rendering thread. Use a maintained UMAP implementation with cosine
metric and support for transforming new vectors into an existing fitted projection. Pin its version
and parameters with the inspection artifacts. The projection library is an inspection dependency,
not an encoder replacement or part of memory retrieval.

## Interface and data sources

Use the [memory service API](service.md#api) for note details, search and paginated vector inspection,
and [embedding-space identity](embeddings.md#interface) to identify compatible vectors. The service
owns provider settings and credentials and supplies inspection with its existing read capabilities. The browser
receives display data, not provider credentials.
UI identity comparisons follow the NoteStore UUID contract; returned note and link spellings remain
unchanged in displayed evidence.

Search calls `POST /v1/search` against the service-owned collection
with the same configuration used by its consumer. Show the returned `via` classification and preserve
result order. The dashboard does not reimplement search with browser distances or a second ranking.

The display needs:

| Data                                                    | Purpose                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| Note UUID, short label and current note fields          | Stable identity, selection and evidence inspection           |
| Stored outgoing link IDs                                | Directed relationship edges                                  |
| Stored vector and embedding-space ID                    | Projection and original-space cosine comparisons in the host |
| Projected `x`, `y` and projection identity              | Browser positions without shipping full vectors              |
| Persisted `updatedAt`, when known                       | Freshness color and exact age                                |
| Search results with IDs, order, `via` and direct scores | Query-result list and graph highlighting                     |

The selected data contracts are `NoteStore.pageEmbedded(limit, cursor)` for stored-vector export
and persisted `Note.updatedAt` for freshness. Their authoritative shapes, validation and legacy-record
handling live in [NoteStore](note-store.md#interface); timestamp assignment lives in
[Memory](memory.md#update-time). Unknown legacy update times remain visibly unknown.

Inspection export follows existing pagination limitations: reads during writes are not an atomic
snapshot. Display capture time and refresh status. A failure is not an empty collection. Retain the
last successful view with an error indication until refresh succeeds.

## Local inspection host

### Startup and composition

Run inspection as a module of the [local service](service.md#bundled-dashboard), sharing its process,
configuration, encoder and HTTP listener. The dashboard is available at `/`, memory clients use
`/v1/...`, and browser inspection uses `/api/...` on the same origin, normally port 4748. No separate
inspector process, display port or service-URL configuration is required for this deployment.

The service composition supplies public read/search and paginated vector capabilities in-process.
Inspection does not initialize Qdrant, load an encoder, construct another Memory instance or make
HTTP requests back to its own service. Obtain collection and embedding identity from that shared
source. Keep projection off the HTTP event loop in a service-owned background worker. Preserve the
last completed view on failure and never fall back to direct database access. The UI has no memory
insertion or editing controls.

### Browser API

The following routes are local inspection contracts, not new memory-library operations:

| Route                          | Behavior                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/graph`               | Return the most recent completed graph view, or loading status before the first one is ready.                                                                   |
| `GET /api/notes/:id`           | Call public `get`; return the current complete note or 404.                                                                                                     |
| `POST /api/search`             | Accept `{ query, limit?, linkedLimit? }`; call public `search` and return `{ searchedAt, results }`. Results use the existing `SearchResult[]` shape unchanged. |
| `POST /api/refresh`            | Request one paginated inspection refresh; return 202 while it runs.                                                                                             |
| `POST /api/projection/rebuild` | Request a fresh fit on the next complete export; return 202 while it runs.                                                                                      |
| `POST /api/compare`            | Accept two note IDs and return their stored-vector cosine similarity with the capture time of the view used.                                                    |

`GET /api/graph` returns this logical JSON shape. Optional values are omitted rather than guessed:

```ts
interface GraphView {
  status: "loading" | "ready" | "error";
  refreshing: boolean;
  error?: string;
  view?: {
    capturedAt: string;
    embeddingSpaceId: string;
    projectionId: string;
    layout: "umap" | "non-semantic";
    bounds: { x: [number, number]; y: [number, number] };
    nodes: Array<{
      id: string;
      label: string;
      x: number;
      y: number;
      updatedAt?: string;
    }>;
    edges: Array<{ source: string; target: string }>;
  };
}
```

Edges connect displayed endpoints and retain stored direction. Missing targets remain available in
full note details. `capturedAt` is export completion time, not an atomic database snapshot time.
`projectionId` identifies a fitted transform, while `capturedAt` distinguishes refreshed views.
The response includes no raw vectors or full note text. Comparison uses the host's latest completed
export and fails explicitly if either vector is absent. Search results include their returned full
notes, so their evidence does not depend on a subsequent detail read.

Validate HTTP inputs against the existing public constraints. Return validation, missing-record and
operation errors distinctly (400, 404 and 500); sanitize error text. An empty successful search is
`results: []`. Operation failures never become empty graph/search success. Fetching the graph also
reports a refresh error alongside the last successful view when available.

### Refresh and projection lifecycle

On startup, traverse the supplied paginated vector source to completion, fit the initial projection outside the HTTP
request handler, then publish a completed view. Serve loading status while this happens. Start
event-driven refresh afterward: completed ingestion/recovery writes invalidate the view; manual
refresh uses the same path. Permit one export/projection job at a time and coalesce requests. If a
change arrives during export/projection, retain a dirty flag and run another pass afterward, so it
cannot be lost when the current view publishes. No 30-second polling loop is required.

On each refresh, stage pages separately, compare notes and vectors by ID, transform new or changed
vectors with the fitted model, and publish only after the traversal and projection succeed. Retain
the previous view on failure. Do not use `updatedAt` alone to detect changes: it can be unknown and
is not a unique revision. A refresh is observationally consistent with public pagination, not a
transactional snapshot. Search remains independently available during refresh.

The browser fetches `GET /api/graph` on WebSocket notifications, applies changes to its existing Graphology graph and preserves
camera/selection. A result missing from the current view remains in the result list and triggers a
refresh; there is no invented vector-by-ID API. Cache vectors/coordinates and the fitted model as
disposable inspection state, with collection and embedding-space identity. Do not persist a second
runtime memory database. On restart, obtain a fresh export before presenting a cache as current;
incompatible caches are discarded. Keep full fits explicit after the initial fit. On shutdown,
stop refresh jobs, close WebSocket connections and HTTP, and release provider/projection resources.

### WebSocket updates

Expose `GET /api/events` as a WebSocket upgrade on the same service listener. This is a read-only
notification channel, not a second memory API. Validate the handshake Host and browser Origin using
the service's existing loopback rules. It does not accept observation submissions or graph edits.

Send JSON `{ type: "graph-changed" }` when a completed graph view or its loading/refresh/error state
changes. On every connection send `{ type: "resync" }`; the browser then fetches the latest
`GET /api/graph`. Subscribe before the initial fetch, and keep a dirty flag for notifications received
during a fetch so a newer state is retrieved afterward. Serialize fetches and discard obsolete
responses. Payloads contain no vectors or full graph; HTTP remains the authoritative snapshot source.

Automatically reconnect with bounded exponential backoff (1 second to 30 seconds). Update the
[connection indicator](#connection-indicator) and retain the last view while disconnected. Every reconnect performs a
fresh sync, including after a service restart; no persisted event log or replay guarantee is needed.
The service also refreshes from storage on startup, so writes completed before a crash are discovered.
If graph refresh failed temporarily, retry that refresh with bounded backoff until successful or
superseded by a new trigger; do not wait for another memory write to recover. This is failure recovery,
not steady-state polling. Keep freshness-color timers local to the browser.

Use connection liveness checks, bounded send buffers and coalesced notifications. A slow or abandoned
client must not block ingestion or accumulate graph payloads; disconnect it and allow resync. Keep
manual Refresh graph and Rebuild projection actions. Test a write during a refresh, a notification
during a fetch, idle connections, disconnect/reconnect, service restart, refresh failure recovery,
and camera/selection preservation. Stored memories must appear without manual reload or periodic
30-second polling; no timing guarantee may imply that queued observations are already stored.

### Launching the host

Use `npm run service` for the combined service and dashboard; see
[service deployment](service.md#bundled-dashboard). The launch/build path supplies the bundled
`inspector/ui` assets and uses one port and supervised lifecycle. `npm run inspector` may remain a
development entry point sharing the same inspection implementation, not a second required service.

## Visual behavior

The main view contains a zoomable graph, a query bar and ordered result list, and a details panel.

| Visual          | Meaning                                                       |
| --------------- | ------------------------------------------------------------- |
| Position        | Approximate semantic neighborhood in the embedding projection |
| Arrow           | An actual stored outgoing link; no inferred similarity edges  |
| Fill color      | Age since the last evidenced update                           |
| Highlight/label | Selection or membership in the current request's results      |

Use a sequential freshness palette with fixed, labeled age ranges so colors are comparable between
refreshes. Unknown freshness has a separate neutral color. Show the exact update time and elapsed age
in the details panel, separately from observation time. Recompute age colors periodically without
re-embedding or moving nodes. Freshness means recent change, not verified truth or usefulness.

Zoom and pan use Sigma's camera. Provide **Fit all**, **Fit results**, and focus on a selected memory.
Do not move the camera automatically on refresh or after every request. At overview scale, suppress
most labels and keep links unobtrusive. On selection, emphasize incoming/outgoing links and nearby
notes; keep arrow direction inspectable. Offer a simple all-links versus focused-links control.

Selection opens original content, current context, keywords, tags, provenance, observation time and
update evidence. Render source text as text, never executable HTML. Use note IDs as identities even
when labels repeat. List unresolved link targets in details without inventing positioned nodes.

### Connection indicator

Keep a compact connection indicator visible in the dashboard header. Use the existing `/api/events`
WebSocket lifecycle: show a neutral dot and **Connecting** before the first connection, a green dot
and **Online** while connected, and an amber dot and **Offline · reconnecting** when disconnected.
Text accompanies the color so the state is understandable without color. Reconnection updates the
indicator automatically and performs the existing graph resync; no page reload or separate status
polling is needed.

Online means the service event channel is connected, not that ingestion, providers or graph
projection have finished. Keep loading and graph-refresh errors in their existing status display.
The last completed graph remains interactive while offline.

## Vector projection and proximity

Fit a two-dimensional UMAP projection from the stored vectors of one compatible embedding space.
Record the space ID, input identities, algorithm version, seed and parameters with the projection.
Never mix spaces because they happen to share dimensions. Keep the fitted transform and coordinates
as disposable inspection artifacts outside runtime persistence.

Supply the projection's `x` and `y` directly to Graphology. Do not run ForceAtlas2 or another graph
layout afterward: links must not pull points away from their semantic positions. Label the map
**Approximate embedding projection**. Distance on screen is not an exact cosine distance and can
misrepresent global relationships or apparent cluster separation.

Show actual direct-match cosine scores from search. For an explicit comparison between selected
memories, compute cosine similarity from their original stored vectors in the host. Keep this
comparison separate from retrieval scores and never assign a fabricated search score to linked
additions. Tiny collections without enough points to fit UMAP show a clearly labeled non-semantic
layout until a projection can be fitted.

## Memory requests

The query bar accepts query text, direct limit and linked limit using the existing search constraints.
Show results in the exact returned order with a **Direct match** or **Linked addition** label; only
direct matches have a retrieval score. The details panel and graph selection stay synchronized.

Highlight returned IDs over the existing map without replacing freshness fill colors, using Sigma's
highlight treatment and forced labels; show retrieval kind in labels and the result list. Dim
unrelated nodes and edges. Clearing results restores the normal map. Merely being near a returned
point must not imply that a memory was returned.

Keep the returned note payload as evidence of that request. Refreshing the graph does not silently
rerun the request or replace its result text. Show request time and whether the map has since refreshed.
If a result is not yet mapped, retain it in the list, request a paginated inspection refresh and project it when
available. A returned memory the map does not contain yet stays selectable through its returned
payload, which is shown as its details evidence, and the actions that need a position stay
unavailable. A completed refresh keeps the selected memory current: returned payloads stay as the
request's evidence, details read from the host are read again once the displayed view moves, and a
selection that leaves both the map and the results is cleared together with any answer still in
flight for it. Failed requests show an error, not a successful zero-result count. A later submitted
request takes precedence over an older request that finishes afterward.

## Live updates with Sigma

Consume the completed views delivered over the [WebSocket channel](#websocket-updates) and the
manual refresh actions. Diff by stable IDs and apply successful refreshes to the existing
Graphology instance; do not recreate Sigma each time. The channel carries notifications, not an
event log: `GET /api/graph` stays the authoritative snapshot source and every reconnect resyncs.

- Add/remove nodes and directed edges through Graphology mutations as they appear/disappear in a
  completed export. Never infer deletion from an incomplete page traversal or failed refresh.
- Update attributes for changed notes. Changed colors or links do not require re-projection.
- Transform new or changed vectors through the existing fitted UMAP model, retaining other nodes'
  coordinates. Show pending projection explicitly instead of presenting stale coordinates as current.
- Provide an explicit **Rebuild projection** action when the corpus has changed substantially.
  A full refit may rearrange the map; it is not evidence that all memories changed.
- Preserve selection and camera state, including active wheel zoom and drag inertia. Use Sigma's
  `setCustomBBox()` to keep normalization fixed for the renderer's lifetime, so refreshes leave
  both the viewport transformation and active gesture/animation targets unchanged. Track the
  growing graph extent separately for explicit **Fit all**. An added outlier must not rescale or
  move memories that were already displayed. Apply the coordinates of a completed full refit in
  one commit, so no frame draws a mixture of the old and new projections.

Sigma subscribes to Graphology changes and refreshes automatically. Use v3 `nodeReducer` and
`edgeReducer` for temporary result/selection styling, retaining underlying note data. When external
highlight state or freshness time changes, call `scheduleRefresh()` to coalesce redraws. Use partial
refreshes where appropriate; `skipIndexation` is only suitable when position, size and other indexed
attributes have not changed. Call `kill()` when disposing the view.

## Asynchronous data updates

All data loading, refresh, search and projection work runs asynchronously relative to interaction.
The existing graph remains zoomable, pannable and selectable while requests or updates are pending.
Show loading/progress without clearing or blocking the current view.

Use asynchronous storage and HTTP I/O. Run CPU-heavy projection, vector comparison and export/diff
processing in a worker thread or separate process rather than the HTTP event loop. Declaring a
function `async` does not make synchronous CPU work non-blocking. In the browser, move substantial
response parsing/diff work to a Web Worker and apply Graphology mutations in bounded batches that
yield between animation frames. Coalesce Sigma refreshes; do not redraw once per changed node.

Serialize refresh jobs, coalesce pending notifications, and ignore obsolete responses when a newer request
or view supersedes them. A projection rebuild is a background job; swap the completed projection in
without exposing a mixture of old and new coordinate systems. Release workers and cancel pending
requests when closing the inspector. Errors leave the last successful graph interactive.

Validate responsiveness while importing and refreshing a representative 10,000-node graph with
about 50,000 directed links: exercise zoom/pan, selection and a search during updates, record main
thread stalls and update latency, and check that neither stale responses nor partial failures
replace newer successful state. This is a required responsiveness check, not a claimed throughput
benchmark. Keep Sigma-specific rendering separate from data access and projection so a later
renderer replacement does not change those contracts.

## Large collections

Use paged export, compact browser node data and on-demand full-text details. Keep high-dimensional
vectors and UMAP work in the host/projection process. Batch refresh work and avoid labels on every
node or emphasized edges across the whole graph.

Measure load time, projection time, refresh time, browser memory and pan/zoom responsiveness against
representative note and edge counts on the user's machine. Sigma's WebGL rendering does not promise
a particular million-node capacity, and fitting UMAP or exporting a collection can cost more than
rendering it. Start with the full selected collection; add sampling or viewport loading only if
measurements require it. Any reduced view must state its coverage and keep all request results
visible in the list, including those absent from the map.

## Acceptance checks

1. A small fixture renders the exact stored IDs and directed links at supplied projected positions;
   adding links does not change coordinates.
2. Known update times yield the expected age colors; unknown times stay unknown and observation
   timestamps are never substituted for update times.
3. A real search displays and highlights exactly its returned IDs, order, direct scores and linked
   classifications, including zero results and results not yet mapped.
4. Refresh adds and changes memories without resetting zoom or selection; failed/incomplete refreshes
   preserve existing data and do not invent deletions; an added outlier leaves already displayed
   memories at their screen positions.
5. New vectors use the existing projection; full refitting is explicit. The UI distinguishes
   projected proximity from original-vector similarity.
6. Representative scale checks report corpus size, link count and hardware alongside measurements;
   all displayed source text is inert.
7. The connection indicator shows connecting, online and offline/reconnecting states, including
   service restart, and restores online automatically without clearing the last completed graph.

The evidence for these checks is recorded with the dashboard's tests and its responsive scale check
in [inspector/README.md](../inspector/README.md#acceptance-checks).

## References

- [Sigma v3 graph data and reducers](https://www.sigmajs.org/docs/advanced/data/)
- [Sigma rendering lifecycle](https://www.sigmajs.org/docs/advanced/lifecycle/)
- [Sigma coordinate systems](https://www.sigmajs.org/docs/advanced/coordinate-systems/)
- [Sigma API: refresh and camera/bounds controls](https://www.sigmajs.org/docs/typedoc/sigma/src/classes/Sigma/)
- [Sigma source and MIT license](https://github.com/jacomyal/sigma.js)
- [Graphology source and MIT license](https://github.com/graphology/graphology)
- [UMAP: transforming new data](https://umap-learn.readthedocs.io/en/latest/transform.html)
