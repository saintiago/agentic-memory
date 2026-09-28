# Local memory inspection host

The separate local host of the [Sigma memory dashboard](../docs/dashboard.md). It opens one
explicitly configured collection through the public memory and storage contracts, projects the
stored vectors, serves the same-origin browser API on loopback and keeps the last completed view
interactive while work is pending. It never writes a memory, never calls a language model and
holds no runtime persistence of its own. The browser UI lives in `ui/`: a host client, a view
planner that parses and diffs served payloads in a worker, a Graphology display model, inert DOM
panels and a thin Sigma v3 rendering adapter that is the only module the renderer touches.

## Launching

From the repository root:

```bash
export AMEM_QDRANT_URL=http://127.0.0.1:16333
export AMEM_QDRANT_COLLECTION=amem-notes
npm run inspector
```

The process prints the loopback URL it serves (`http://127.0.0.1:4747/` by default), starts the
initial paginated export and projection in the background, and stops periodic refresh, pending jobs,
HTTP and the projection worker on `SIGINT` or `SIGTERM` without waiting for an in-flight export or
projection. It needs no generation-provider credential, starts no Qdrant server and imports no
Nexus configuration.

`npm run inspector` first builds the browser bundle of `ui/` into `ui/build/` (see
`npm run inspector:build`) and then runs the TypeScript entry point through the pinned `tsx`
loader; the projection worker thread uses the same loader. The worker holds the fitted projection,
the exported vectors, the coordinates and the comparison state for this process only. Open the
printed loopback URL to use the dashboard; the page needs no build step of its own because the
host serves the built bundle.

## Browser dashboard

The page is one composition of a status line, a zoomable Sigma map, a query bar with an ordered
result list, a details panel and an explicit stored-vector comparison. It states that positions
are an approximate embedding projection and labels a non-semantic fallback layout as such.

| Part                     | Behavior                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map                      | Directed stored links, freshness fill from the fixed palette, zoom/pan through Sigma, **Fit all**, **Fit results**, **Focus selected** and all-links versus focused-links |
| Freshness legend         | The labeled age ranges and the neutral unknown-update color, comparable between refreshes                                                                                 |
| Query bar                | Real `AgenticMemory.search` through the host; results keep returned order, **Direct match** scores and **Linked addition** labels, and highlight exactly the returned IDs |
| Details                  | Original content, context, keywords, tags, provenance, the memory timestamp, the exact update time with its age (or `unknown`) and the capture time of the displayed view |
| Stored-vector comparison | Original-space cosine similarity of the two most recently selected memories, with the capture time of the view that holds them and explicitly not a retrieval score       |

Updates are asynchronous: the page polls `GET /api/graph`, parses and diffs each payload in a
worker, applies the mutations to the existing Graphology graph in bounded batches and never
recreates Sigma, so the camera and selection survive a refresh. The status line reports a running
refresh and an in-progress application of a completed view. A failed poll or refresh keeps the last
completed view and shows the error instead of an empty map. Returned memories the current view does
not contain stay in the result list, are marked as not in the current map and request one paginated
inspection refresh. Ages are recomputed without re-embedding or moving nodes. The map renders the
graph after the first completed view is applied, so a large initial import costs one draw rather
than one draw per batch, and it skips the link layer while the camera moves to keep zoom and pan
responsive with tens of thousands of links.

## Host settings

Every setting comes from the host environment. A missing or malformed value fails before the
encoder is opened or the collection is touched.

| Setting                           | Default            | Meaning                                                                               |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `AMEM_QDRANT_URL`                 | required           | Qdrant endpoint of the inspected collection                                           |
| `AMEM_QDRANT_COLLECTION`          | required           | The one collection this host reads                                                    |
| `AMEM_QDRANT_API_KEY`             | none               | Qdrant credential; never returned to the browser                                      |
| `AMEM_QDRANT_TIMEOUT_MS`          | `120000`           | Qdrant request timeout                                                                |
| `AMEM_EMBEDDING_CACHE`            | `.data/embeddings` | Pinned encoder artifact cache used for query embeddings                               |
| `AMEM_ALLOW_EMBEDDING_DOWNLOADS`  | `true`             | Whether a missing pinned encoder artifact may be downloaded                           |
| `AMEM_INSPECTOR_PORT`             | `4747`             | Loopback port; `0` selects a free port                                                |
| `AMEM_INSPECTOR_POLL_INTERVAL_MS` | `30000`            | Delay between periodic refreshes; `0` keeps the host to explicit refreshes            |
| `AMEM_INSPECTOR_ARTIFACTS_DIR`    | `.data/inspector`  | Directory of the disposable `projection.json` coordinates and their recorded identity |
| `AMEM_INSPECTOR_UI_DIR`           | `inspector/ui`     | Static UI directory; it must exist, and `/` serves its `index.html`                   |

The Qdrant URL, credential and timeout rules belong to the NoteStore initialization contract, which
validates them before the first request. The host opens the collection with the pinned encoder's
declared embedding space, so an incompatible collection fails at startup instead of projecting
foreign vectors.

## Browser API

| Route                          | Behavior                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `GET /api/graph`               | The most recent completed view, or loading/error status with the last one kept     |
| `GET /api/notes/:id`           | The complete current note or 404                                                   |
| `POST /api/search`             | `{ query, limit?, linkedLimit? }` through the public search, in returned order     |
| `POST /api/refresh`            | One paginated inspection refresh; 202 while it runs and coalesced once running     |
| `POST /api/projection/rebuild` | A fresh fit on the next complete export; 202 while it runs                         |
| `POST /api/compare`            | `{ leftId, rightId }` stored-vector cosine similarity of the latest completed view |

Validation failures are 400, a note that the latest view or the collection does not contain is 404,
a comparison before the first completed view is 409, and operation failures are 500 with a fixed
message. Failure text is sanitized; details stay on the host's stderr. Refresh and projection
failures never turn into an empty graph or an empty search result. The served shapes are defined
once in [payloads.ts](payloads.ts), the host sends what that module accepts and the browser
validates what it receives with the same schemas, so a malformed or drifted payload fails visibly
instead of rendering an empty collection.

## Projection and inspection state

The initial export traverses `pageEmbedded` to completion before anything is published, then fits a
two-dimensional UMAP projection with cosine distance and the pinned umap-js 1.4.0 parameters
(`nNeighbors: 15`, `minDist: 0.1`, seed `42`, library-default epochs, 2 components). Fewer than 16
notes are shown in a clearly labeled non-semantic ring until a fit is possible. Later exports
transform only new or changed vectors through the fitted model and keep every other coordinate; a
fresh fit happens only for `POST /api/projection/rebuild`. Refreshes diff vectors by their exact
stored values, so `updatedAt` alone is never treated as a change. Vectors are transformed one at a
time, because umap-js 1.4.0 moves its fitted training coordinates when a transform batch is as long
as the training set. A vector whose neighbors are all at zero distance, as for a memory that
repeats an equivalent stored vector, cannot be placed by the library; it keeps the position of its
nearest fitted anchor instead of failing the refresh. Fitted anchors survive complete removal of
displayed notes and are replaced only on a new fit.

`projection.json` under the artifact directory records the collection, embedding-space ID, layout,
projection ID, algorithm and parameters, build time, fit inputs and current coordinates with the
vector identity each coordinate came from. On startup the host still obtains a fresh export before
presenting anything as current: a stored projection is reused only when it belongs to the configured
collection and embedding space and covers exactly that export, and an incompatible or malformed
artifact is discarded. No stored vector or note text is written to the artifact directory.

A comparison always describes the completed export that holds its vectors: it waits for a refresh
in flight instead of mixing similarity, membership and capture time from two exports.

The fitted transform itself is process-local state of the projection worker: a run that reused
stored coordinates has no fitted model, so the first later export that differs from the stored one
is fitted fresh (that process's initial fit) instead of transforming into a layout it cannot
reproduce. Within one run, later exports transform new or changed vectors and keep every other
coordinate.

On SIGINT or SIGTERM, the standalone host stops polling, cancels pending jobs, terminates the
projection worker and disconnects all HTTP clients, including pending detail/search requests.
It then exits explicitly: the public NoteStore and Embedder contracts expose no disposal API,
so process termination releases outstanding provider sockets, SDK timers and encoder resources
without waiting for provider timeouts. `InspectionSession.stop()` alone cancels inspection work;
the process owns provider cleanup.

## Checks

`npm run validate` covers formatting, linting, types, component boundaries, deterministic tests and
the build, including the host's component tests:

- the HTTP contract of every route, its validation, missing-record and failure statuses, and the
  loading/ready/error graph states;
- the refresh lifecycle: paginated traversal, coalesced requests, explicit rebuilds, retained views
  after failures, cancelled work on shutdown and the stored projection offered to a restarted host;
- the real UMAP fit, transforms that keep the fitted anchors, removal-only refreshes, repeated
  equivalent vectors, the non-semantic fallback, comparisons of one completed export and
  worker-thread execution;
- responsiveness: while a CPU-bound projection occupies its worker thread, the graph route keeps
  answering and the view is published once the worker finishes.

The dashboard's own tests are colocated with its modules under `ui/tests/` and run in the same
deterministic scope. They exercise the real Graphology model, view planner and DOM panels with a
substituted HTTP host and a recording renderer: the imported identities and directed links at the
served positions, positions that survive a link-only refresh, removals only from completed views,
the freshness palette and its unknown-update neutral, returned order with direct scores and linked
classifications, a zero-result search, a superseded request, retained views after failures,
unmapped results and their returned evidence, the details and comparison panels, details that are
re-read when a completed view changes them, comparison answers a later selection supersedes, the
inline planner's fallback after a worker failure, atomic projection refits, camera and selection
preservation across a refresh, and source text that stays inert. `npm run validate` also builds
the browser bundle, so a broken bundle fails the aggregate check.

### Responsive browser checks

`npm run inspector:responsive` builds the bundle and runs two checks in a real headless Chromium
through `playwright-core`, against the real inspection session and HTTP server with a synthetic
collection and projection.

The required scale check imports and refreshes 10,000 memories with 49,996 directed links (the
refresh adds 500 memories and 2,500 links) and exercises zoom, pan, selection and a search while
that update is provably pending: it holds the next export open until the interactions are done, so
the update window is explicit, and only then captures the preservation baseline and releases the
export. It records the corpus size, link count, hardware, browser, load time, update latency, long
tasks, frame gaps and the largest viewport drift of an unchanged memory in
`.data/inspector-responsive/report.json` (`AMEM_INSPECTOR_RESPONSIVE_OUT` overrides the path). It
fails with instructions when the browser build or the Chromium download is missing, and it fails
when the displayed view or the selection does not survive the update, when a failed refresh empties
the map, or when the main thread is frozen.

The added-outlier check (`test/responsive/inspector-camera.responsive.ts`) fits a small corpus,
moves and zooms the camera, then refreshes into a completed view whose extent grows far to one side
through an asymmetric outlier. It compares the viewport positions of unchanged memories before and
after that update through the real renderer, so an added outlier that rescales the existing view
fails the check instead of passing a camera sample taken after the fact. Separate real-renderer
cases use a controlled browser clock to grow bounds during wheel zoom and drag inertia, compare
the trajectory with identical input without a refresh, and verify that **Fit all** includes the
added outlier. Mixed-case UUID component cases cover refresh reconciliation, result highlighting,
link navigation and comparison selection while preserving returned evidence.

Recorded run on the development machine (13th Gen Intel Core i7-13700KF, 24 cores, 16 GiB, WSL2;
Chromium 153 with software WebGL through SwiftShader):

| Measurement                       | Value                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Corpus and update                 | 10,000 memories and 49,996 directed links; refresh adds 500 and 2,500                                            |
| Initial load                      | 2943 ms from navigation to the displayed view; 222 ms to apply it in 12 batches                                  |
| Refresh, request to applied view  | 27765 ms wall clock including the held interaction window; 10 ms to apply the diff in 1 batch                    |
| Interaction during the update     | search → results panel 3656 ms, click → panels 56 ms, wheel → camera 47 ms, drag → camera 4426 ms                |
| Main thread                       | 46 long tasks, longest 1842 ms; frame gaps p95 1306 ms over 192 samples                                          |
| Preservation and failure handling | interaction ran while pending, viewport drift 0 px, camera and selection preserved, failed refresh kept the view |

The browser fell back to software WebGL in this environment, so one full redraw of the 50,000-link
layer costs about 1.3 s, and repeated runs of the same check vary with how many of those redraws
are already queued when an interaction arrives. The check records the renderer string with the
numbers instead of presenting them as a hardware-accelerated result; zoom, pan, selection and
search still complete, and the update applies in one batch while they run. The recorded search and
click figures are the page's own handler latencies (submission to the updated results panel, click
to the updated panels); the driver-observed round trips that include queued redraws are in the
report as `observedSearchMs` and `observedClickMs`. The scale check's growth also changes the
fit extent slightly; the normalization box and camera state stay fixed while the displayed
memories keep their screen positions.

## Acceptance checks

Each acceptance check of [docs/dashboard.md](../docs/dashboard.md#acceptance-checks) has its
evidence in this scope:

| Check                                                                                                                          | Evidence                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Stored IDs and directed links at the served positions; links do not move nodes                                                 | `ui/tests/graph-model.test.ts` and the scale check's served-position assertion                       |
| Known update times yield the expected age colors, unknown stays unknown                                                        | `ui/tests/freshness.test.ts`, `ui/tests/style.test.ts` and `ui/tests/details.test.ts`                |
| A real search displays and highlights exactly its returned IDs, order, scores and classifications                              | `ui/tests/results.test.ts`, `ui/tests/dashboard.test.ts` and the scale check's search step           |
| Refresh adds and changes memories without resetting zoom or selection; failures preserve data                                  | `ui/tests/dashboard.test.ts`, `ui/tests/graph-model.test.ts` and the scale check's held refresh step |
| An added outlier leaves already displayed memories at their screen positions                                                   | `test/responsive/inspector-camera.responsive.ts` (real renderer, asymmetric extent growth)           |
| New vectors use the existing projection; full refitting is explicit; projection is distinguished from stored-vector similarity | `ui/tests/dashboard.test.ts` (explicit rebuild, labelled comparison) and the host's projection tests |
| Representative scale check reports corpus size, links and hardware; displayed text is inert                                    | `npm run inspector:responsive` and `ui/tests/dashboard.test.ts` (inertness)                          |

The authoritative design, including the acceptance checks that belong to the AMEM-11 UI, is
[docs/dashboard.md](../docs/dashboard.md).
