/**
 * The standalone development listener of the read-only dashboard: the same inspection routes and
 * WebSocket channel the bundled service mounts, on their own loopback port for a host that points
 * at an already running memory service. Deployment uses the bundled listener; this host exists so
 * the dashboard can be developed and inspected against any service URL.
 *
 * See docs/dashboard.md#launching-the-host and docs/service.md#bundled-dashboard.
 */
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";

import {
  assertTrustedAuthority,
  bindAuthority,
  UntrustedAuthorityError,
  type BoundAuthority,
} from "../service/loopback-authority.js";
import { createGraphEvents, type GraphEventHub } from "./events.js";
import {
  handleInspectionRequest,
  InspectionHttpFailure,
  sendInspectionFailure,
  type InspectionHttpOptions,
  type InspectionReads,
} from "./routes.js";
import type { InspectionSession } from "./session.js";

export type { InspectionReads } from "./routes.js";
export type { GraphEventHub } from "./events.js";

export interface InspectionServerOptions {
  readonly reads: InspectionReads;
  readonly session: InspectionSession;
  /** The static UI directory, which must exist before the host is exposed. */
  readonly uiDirectory: string;
  readonly port: number;
  readonly host?: string;
  readonly now?: () => Date;
  /** The event channel; the caller may substitute one for tests. */
  readonly events?: GraphEventHub;
}

/** A running inspection server. */
export interface InspectionServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Refuse an untrusted handshake, then let the event hub claim its own path. The listener owns the
 * loopback authority rules; the hub owns only the upgrade it serves.
 */
export const claimGraphUpgrade = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  bound: BoundAuthority,
  events: GraphEventHub,
): boolean => {
  try {
    assertTrustedAuthority(request, bound);
  } catch (cause) {
    if (cause instanceof UntrustedAuthorityError) {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json; charset=utf-8\r\n" +
          "connection: close\r\n\r\n" +
          JSON.stringify({ error: cause.message }),
      );
      return true;
    }
    throw cause;
  }
  return events.handleUpgrade(request, socket, head);
};

/**
 * Start the loopback inspection server; every response is JSON except the static UI files. The
 * listener validates the bound authority of every request and WebSocket handshake, including a
 * hostname rebound to the loopback address.
 */
export const startInspectionServer = async (
  options: InspectionServerOptions,
): Promise<InspectionServer> => {
  const boundHost = options.host ?? "127.0.0.1";
  const uiDirectory = path.resolve(options.uiDirectory);
  const stats = await stat(uiDirectory).catch(() => undefined);
  if (stats === undefined || !stats.isDirectory()) {
    throw new Error(
      `The inspection UI directory "${uiDirectory}" does not exist or is not a directory.`,
    );
  }
  let bound = bindAuthority(boundHost, options.port);
  const events = options.events ?? createGraphEvents({});
  // Every served state change reaches the browser channel; HTTP stays the snapshot source.
  const unsubscribe = options.session.subscribe(() => {
    events.notify();
  });
  const httpOptions: InspectionHttpOptions = {
    reads: options.reads,
    session: options.session,
    uiDirectory,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const server = createServer((request, response) => {
    void (async () => {
      try {
        assertTrustedAuthority(request, bound);
        if (await handleInspectionRequest(request, response, httpOptions)) {
          return;
        }
        throw new InspectionHttpFailure(404, "No such inspection route.");
      } catch (cause) {
        const failure =
          cause instanceof UntrustedAuthorityError
            ? new InspectionHttpFailure(400, cause.message)
            : cause instanceof InspectionHttpFailure
              ? cause
              : new InspectionHttpFailure(
                  500,
                  "The inspection host could not serve the request.",
                  { cause },
                );
        if (failure.status >= 500) {
          console.error(
            `[inspector] ${request.method ?? "GET"} ${request.url ?? ""} failed:`,
            failure.cause ?? failure,
          );
        }
        sendInspectionFailure(response, failure);
      }
    })();
  });
  server.on("upgrade", (request, socket: Duplex, head) => {
    if (!claimGraphUpgrade(request, socket, head, bound, events)) {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, boundHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : options.port;
  bound = bindAuthority(boundHost, port);
  return {
    port,
    close: async () => {
      unsubscribe();
      await events.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
        // Pending detail/search reads and incomplete request bodies must not delay shutdown.
        server.closeAllConnections();
      });
    },
  };
};
