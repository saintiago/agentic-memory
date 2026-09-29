/**
 * An encoder worker substitute for the responsiveness test: it loads instantly, reports the
 * reference embedding space, and then occupies its worker thread for a fixed window before it
 * answers an inference request, imitating the pinned encoder's blocking tokenization and native
 * inference. It is test scaffolding, not an encoder implementation and not evidence about
 * embedding quality.
 */
import { parentPort } from "node:worker_threads";

import { referenceEmbeddingSpace } from "../../../src/index.js";
import {
  handleEncoderMessage,
  type EncoderWorkerReady,
  type EncoderWorkerRequest,
} from "../../../service/encoder-protocol.js";

if (parentPort === null) {
  throw new Error("The blocking encoder fixture must run as a worker thread.");
}

const port = parentPort;
const busyMs = 800;

const embedder = {
  space: referenceEmbeddingSpace,
  embed: (text: string): Promise<number[]> => {
    const until = Date.now() + busyMs;
    let ticks = 0;
    while (Date.now() < until) {
      ticks += 1;
    }
    const vector = new Array<number>(referenceEmbeddingSpace.dimensions).fill(
      0,
    );
    vector[0] = 1;
    vector[1] = text.length + (ticks > 0 ? 0 : 1);
    return Promise.resolve(vector);
  },
};

port.on("message", (message: EncoderWorkerRequest) => {
  void handleEncoderMessage(embedder, message).then((response) => {
    port.postMessage(response);
  });
});

const ready: EncoderWorkerReady = { type: "ready", space: embedder.space };
port.postMessage(ready);
