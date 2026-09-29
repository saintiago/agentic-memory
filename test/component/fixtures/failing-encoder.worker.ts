/** Controlled terminal exits and request failures through the real encoder host protocol. */
import { parentPort, workerData } from "node:worker_threads";

import { referenceEmbeddingSpace } from "../../../src/index.js";
import {
  handleEncoderMessage,
  type EncoderWorkerRequest,
} from "../../../service/encoder-protocol.js";

if (parentPort === null) {
  throw new Error("A worker thread is required.");
}
const port = parentPort;
const options = workerData as { cacheDir: string; allowDownloads: boolean };
port.postMessage({ type: "ready", space: referenceEmbeddingSpace });
if (options.cacheDir === "exit-idle") {
  // Exit without any inference request or error event, after the ready handshake.
  port.close();
} else {
  port.on("message", (request: EncoderWorkerRequest) => {
    if (!options.allowDownloads) {
      process.exit(17);
    }
    void handleEncoderMessage(
      {
        space: referenceEmbeddingSpace,
        embed: async (text: string) => {
          if (text === "reject-inference") {
            throw new Error("temporary inference failure");
          }
          const vector = new Array<number>(
            referenceEmbeddingSpace.dimensions,
          ).fill(0);
          vector[0] = 1;
          return vector;
        },
      },
      request,
    ).then((response) => port.postMessage(response));
  });
}
