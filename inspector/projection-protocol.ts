/**
 * Message protocol between the inspection host and its projection worker, and the pure handler
 * the worker runs for one message. Keeping the handler free of worker-thread APIs makes the
 * protocol testable without a running thread; the worker entry only wires the port to it.
 *
 * See docs/dashboard.md#asynchronous-data-updates.
 */
import type {
  ProjectionArtifact,
  ProjectionErrorCode,
  ProjectionRequest,
} from "./projection.js";
import { ProjectionError, type ProjectionState } from "./projection.js";

/** One request the host sends to the projection worker. */
export type ProjectionWorkerRequest =
  | {
      readonly type: "project";
      readonly requestId: number;
      readonly request: ProjectionRequest;
    }
  | {
      readonly type: "compare";
      readonly requestId: number;
      readonly leftId: string;
      readonly rightId: string;
    };

/** One response the projection worker sends back. */
export type ProjectionWorkerResponse =
  | {
      readonly type: "projected";
      readonly requestId: number;
      readonly artifact: ProjectionArtifact;
    }
  | {
      readonly type: "compared";
      readonly requestId: number;
      readonly similarity: number;
    }
  | {
      readonly type: "failed";
      readonly requestId: number;
      readonly code: ProjectionErrorCode | "worker-failed";
      readonly message: string;
    };

/**
 * Run one request against the worker's projection state. A projection failure is classified for
 * the host; an unexpected failure is reported as a fixed message while its detail stays in the
 * worker's own diagnostics, so no vector or provider text reaches the browser.
 */
export const handleProjectionMessage = (
  state: ProjectionState,
  message: ProjectionWorkerRequest,
): ProjectionWorkerResponse => {
  try {
    if (message.type === "project") {
      return {
        type: "projected",
        requestId: message.requestId,
        artifact: state.project(message.request),
      };
    }
    return {
      type: "compared",
      requestId: message.requestId,
      similarity: state.compare(message.leftId, message.rightId),
    };
  } catch (cause) {
    if (cause instanceof ProjectionError) {
      return {
        type: "failed",
        requestId: message.requestId,
        code: cause.code,
        message: cause.message,
      };
    }
    console.error("[inspector] projection worker request failed:", cause);
    return {
      type: "failed",
      requestId: message.requestId,
      code: "worker-failed",
      message: "The projection worker could not complete the request.",
    };
  }
};
