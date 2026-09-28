# Local memory inspection host

The separate local host of the [Sigma memory dashboard](../docs/dashboard.md). It opens one
explicitly configured collection through the public memory and storage contracts, projects the
stored vectors, serves the same-origin browser API on loopback and keeps the last completed view
interactive while work is pending. It never writes a memory, never calls a language model and
holds no runtime persistence of its own. The browser UI is implemented by AMEM-11 and replaces the
placeholder page in `ui/`.

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

`npm run inspector` runs the TypeScript entry point through the pinned `tsx` loader, and the
projection worker thread uses the same loader. The worker holds the fitted projection, the exported
vectors, the coordinates and the comparison state for this process only.

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
failures never turn into an empty graph or an empty search result.

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
nearest committed memory instead of failing the refresh.

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

The authoritative design, including the acceptance checks that belong to the AMEM-11 UI, is
[docs/dashboard.md](../docs/dashboard.md).
