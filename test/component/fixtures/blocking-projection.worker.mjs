/**
 * A projection worker substitute for the responsiveness test: it occupies its worker thread for a
 * fixed window, imitating a CPU-heavy projection, and then answers with fixture coordinates. It is
 * test scaffolding, not a projection implementation and not evidence about UMAP quality.
 */
import { parentPort } from "node:worker_threads";

const busyMs = 700;

const occupyThread = () => {
  const until = Date.now() + busyMs;
  let ticks = 0;
  while (Date.now() < until) {
    ticks += 1;
  }
  return ticks;
};

parentPort.on("message", (message) => {
  if (message.type === "project") {
    occupyThread();
    const coordinates = message.request.inputs.map((input, index) => ({
      id: input.id,
      x: index,
      y: -index,
      vectorId: `fixture:${input.id}`,
    }));
    parentPort.postMessage({
      type: "projected",
      requestId: message.requestId,
      artifact: {
        schemaVersion: 1,
        collection: message.request.collection,
        embeddingSpaceId: message.request.embeddingSpaceId,
        layout: "non-semantic",
        projectionId: "fixture-projection",
        algorithm: { name: "umap-js", version: "1.4.0" },
        parameters: {
          metric: "cosine",
          nComponents: 2,
          nNeighbors: 15,
          minDist: 0.1,
          seed: 42,
          nEpochs: "library-default",
        },
        builtAt: new Date().toISOString(),
        fitInputs: coordinates.map(({ id, vectorId }) => ({
          id: id.toLowerCase(),
          vectorId,
        })),
        coordinates,
      },
    });
    return;
  }
  parentPort.postMessage({
    type: "compared",
    requestId: message.requestId,
    similarity: 0.25,
  });
});
