import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveEnvironment } from "../../experiments/live/environment.js";
import {
  modelDescription,
  ScriptedModel,
  TokenEmbedder,
} from "./support/harness.js";

afterEach(() => vi.restoreAllMocks());

/** Controlled Qdrant observations; real collection behavior is covered by integration/evaluation. */
describe("live storage observation", () => {
  it.each([0, 2, null, undefined])(
    "keeps indexed vectors (%s) distinct from stored points",
    async (indexed) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname === "/") return Response.json({ version: "1.19.0" });
        const result = url.pathname.endsWith("/points/count")
          ? { count: 3 }
          : {
              points_count: 3,
              ...(indexed === undefined
                ? {}
                : { indexed_vectors_count: indexed }),
              config: { params: { vectors: { size: 4, distance: "Cosine" } } },
            };
        return Response.json({ result, status: "ok", time: 0 });
      });
      const embedder = new TokenEmbedder();
      const environment = createLiveEnvironment({
        url: "http://127.0.0.1:16333",
        baseName: "observation",
        space: embedder.space,
        embedder,
        model: new ScriptedModel(),
        exchanges: null,
        encoderSettings: null,
        modelDescription,
      });
      expect(await environment.observe!("collection")).toMatchObject({
        indexedVectors: indexed ?? null,
        configuration: { vectors: { size: 4, distance: "Cosine" } },
      });
    },
  );
});
