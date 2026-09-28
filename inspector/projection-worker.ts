/**
 * Projection worker entry: projection fits, vector transforms, vector identities and vector
 * comparisons run here, off the HTTP event loop. The worker holds only disposable inspection
 * state and never writes a memory or calls a model.
 *
 * See docs/dashboard.md#asynchronous-data-updates.
 */
import { parentPort } from "node:worker_threads";

import { ProjectionState } from "./projection.js";
import {
  handleProjectionMessage,
  type ProjectionWorkerRequest,
} from "./projection-protocol.js";

if (parentPort === null) {
  throw new Error("The projection worker must run as a worker thread.");
}

const port = parentPort;
const state = new ProjectionState();
port.on("message", (message: ProjectionWorkerRequest) => {
  port.postMessage(handleProjectionMessage(state, message));
});
