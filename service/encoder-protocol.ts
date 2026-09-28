/**
 * Message protocol between the memory service and its encoder worker, and the pure handler the
 * worker runs for one inference request. The pinned encoder loads and runs inside the worker
 * thread, so its blocking tokenization and native inference never stall the HTTP event loop.
 *
 * Keeping the handler free of worker-thread APIs makes the protocol testable without loading the
 * pinned artifacts; the worker entry only wires the port to it.
 *
 * See docs/service.md#async-work-and-resource-sharing.
 */
import type { Embedder, EmbeddingSpace } from "../src/index.js";

/** One inference request the service sends to its encoder worker. */
export interface EncoderWorkerRequest {
  readonly type: "embed";
  readonly requestId: number;
  readonly text: string;
}

/**
 * The one startup outcome the worker reports after creating the pinned encoder, or when that
 * creation failed. The failure message is local diagnostics; only the host ever reads it.
 */
export type EncoderWorkerReady =
  | { readonly type: "ready"; readonly space: EmbeddingSpace }
  | { readonly type: "load-failed"; readonly message: string };

/** One inference outcome; the failure message stays on the host's diagnostics. */
export type EncoderWorkerResponse =
  | {
      readonly type: "embedded";
      readonly requestId: number;
      readonly vector: number[];
    }
  | {
      readonly type: "failed";
      readonly requestId: number;
      readonly message: string;
    };

/** Run one inference request against the worker's loaded encoder. */
export const handleEncoderMessage = async (
  embedder: Embedder,
  message: EncoderWorkerRequest,
): Promise<EncoderWorkerResponse> => {
  try {
    return {
      type: "embedded",
      requestId: message.requestId,
      vector: await embedder.embed(message.text),
    };
  } catch (cause) {
    return {
      type: "failed",
      requestId: message.requestId,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
};
