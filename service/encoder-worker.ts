/**
 * Encoder worker entry: the pinned encoder is created inside this thread, and every inference
 * request runs through the protocol handler here. Tokenization and the native model run block this
 * thread only, so service HTTP requests, durable submission acknowledgements and shutdown timers
 * stay responsive while inference is busy.
 *
 * See docs/service.md#async-work-and-resource-sharing.
 */
import { parentPort, workerData } from "node:worker_threads";

import {
  openReferenceEmbedder,
  type ReferenceEmbedderOptions,
} from "../src/index.js";
import {
  handleEncoderMessage,
  type EncoderWorkerReady,
  type EncoderWorkerRequest,
} from "./encoder-protocol.js";

if (parentPort === null) {
  throw new Error("The encoder worker must run as a worker thread.");
}

const port = parentPort;

/** Report the load outcome, then serve inference requests through the protocol handler. */
const start = async (): Promise<void> => {
  const options = workerData as ReferenceEmbedderOptions;
  const embedder = await openReferenceEmbedder(options);
  port.on("message", (message: EncoderWorkerRequest) => {
    void handleEncoderMessage(embedder, message).then((response) => {
      port.postMessage(response);
    });
  });
  const ready: EncoderWorkerReady = { type: "ready", space: embedder.space };
  port.postMessage(ready);
};

void start().catch((cause: unknown) => {
  const failed: EncoderWorkerReady = {
    type: "load-failed",
    message: cause instanceof Error ? cause.message : String(cause),
  };
  port.postMessage(failed);
});
