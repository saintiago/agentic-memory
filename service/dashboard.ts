/**
 * The bundled read-only dashboard of the local memory service: it composes the inspection module
 * with the service's own public read, search and paginated vector capabilities in-process, runs
 * projection in a background worker and mounts the browser API, the WebSocket notification channel
 * and the built UI on the service's existing loopback listener. Nothing here calls the service over
 * HTTP, opens another database client or loads another encoder.
 *
 * See docs/service.md#bundled-dashboard.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import { createProjectionArtifactStore } from "../inspector/artifacts.js";
import { createGraphEvents, type GraphEventHub } from "../inspector/events.js";
import {
  createThreadProjectionRunner,
  type ProjectionRunner,
} from "../inspector/projection-runner.js";
import {
  handleInspectionRequest,
  InspectionHttpFailure,
  sendInspectionFailure,
} from "../inspector/routes.js";
import { InspectionSession } from "../inspector/session.js";
import {
  InspectionInputError,
  type InspectionSource,
} from "../inspector/source.js";
import { decodeCursor } from "./cursor.js";
import { ServiceFailure } from "./errors.js";
import type { BundledDashboardSurface } from "./server.js";
import type { MemoryService } from "./service.js";

export interface BundledDashboardOptions {
  /** The built browser assets; missing assets are an explicit dashboard-unavailable response. */
  readonly uiDirectory: string;
  /** The disposable projection artifacts; keep them with the service's own local state. */
  readonly artifactsDirectory: string;
  /** A projection runner substitute for tests; the thread worker is the default. */
  readonly runner?: ProjectionRunner;
  /** An event hub substitute for tests; the loopback channel is the default. */
  readonly events?: GraphEventHub;
  readonly pageLimit?: number;
  readonly now?: () => Date;
}

/** One running bundled dashboard inside the service process. */
export interface BundledDashboard {
  /** The routes the service listener mounts next to its unchanged `/v1` routes. */
  readonly routes: BundledDashboardSurface;
  /** Begin the initial export and projection without waiting for a view or a provider. */
  start(): void;
  /** Invalidate the served view after a completed ingestion or recovery write. */
  invalidate(): void;
  /** Stop refresh work, close subscriptions and release the projection worker. */
  stop(): Promise<void>;
}

/** A request the service itself refused as invalid is the dashboard caller's error. */
const translate = (cause: unknown): unknown =>
  cause instanceof ServiceFailure &&
  cause.status === 400 &&
  cause.code === "invalid-request"
    ? new InspectionInputError(cause)
    : cause;

/**
 * Compose the dashboard over the service's own public capabilities. The service supplies focused
 * read contracts; the dashboard never imports a database client, an encoder or a second Memory.
 */
export const openBundledDashboard = (options: {
  readonly service: MemoryService;
  readonly dashboard: BundledDashboardOptions;
}): BundledDashboard => {
  const { service, dashboard } = options;
  const source: InspectionSource = {
    async identity() {
      const status = await service.status();
      return {
        collection: status.collection,
        embeddingSpaceId: status.embeddingSpace.id,
      };
    },

    async pageEmbedded(limit, cursor) {
      try {
        const page = await service.inspectionRecords(
          limit,
          cursor === undefined ? undefined : decodeCursor(cursor),
        );
        return {
          records: page.records,
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      } catch (cause) {
        throw translate(cause);
      }
    },

    async get(id) {
      try {
        return await service.note(id);
      } catch (cause) {
        throw translate(cause);
      }
    },

    async search(query, searchOptions) {
      try {
        const outcome = await service.search(query, searchOptions ?? {});
        return outcome.results;
      } catch (cause) {
        throw translate(cause);
      }
    },
  };

  const events = dashboard.events ?? createGraphEvents({});
  const session = new InspectionSession({
    source,
    runner: dashboard.runner ?? createThreadProjectionRunner(),
    artifacts: createProjectionArtifactStore(dashboard.artifactsDirectory),
    // The bundled service is event-driven: refresh on completed writes and manual requests.
    pollIntervalMs: 0,
    ...(dashboard.pageLimit === undefined
      ? {}
      : { pageLimit: dashboard.pageLimit }),
    ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
  });
  // Every served state change reaches the browser channel; HTTP stays the snapshot source.
  session.subscribe(() => {
    events.notify();
  });

  return {
    routes: {
      handle: async (request, response) => {
        try {
          return await handleInspectionRequest(request, response, {
            reads: source,
            session,
            uiDirectory: dashboard.uiDirectory,
            ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
          });
        } catch (cause) {
          const failure =
            cause instanceof InspectionHttpFailure
              ? cause
              : new InspectionHttpFailure(
                  500,
                  "The dashboard could not serve the request.",
                  { cause },
                );
          if (failure.status >= 500) {
            console.error(
              `[service] dashboard ${request.method ?? "GET"} ${request.url ?? ""} failed:`,
              failure.cause ?? failure,
            );
          }
          sendInspectionFailure(response, failure);
          return true;
        }
      },
      upgrade: (request, socket, head) =>
        events.handleUpgrade(request, socket, head),
    },
    start: () => {
      void reportMissingBuild(dashboard.uiDirectory);
      session.start();
    },
    invalidate: () => {
      session.refresh();
    },
    stop: async () => {
      await session.stop();
      await events.close();
    },
  };
};

/** Announce a missing build instead of failing or serving a misleading empty dashboard. */
const reportMissingBuild = async (uiDirectory: string): Promise<void> => {
  const index = path.join(path.resolve(uiDirectory), "index.html");
  const stats = await stat(index).catch(() => undefined);
  if (stats === undefined) {
    console.warn(
      `[service] the dashboard build is missing at "${index}"; / serves an explicit ` +
        "dashboard-unavailable response and the memory API stays available. Run " +
        "`npm run inspector:build` to build it.",
    );
  }
};
