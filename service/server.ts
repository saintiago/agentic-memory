/**
 * The HTTP surface of the local memory service: the documented `/v1` JSON routes on loopback.
 * Requests and responses are validated against the owned schemas, browser origins and hosts must
 * match the bound service authority, state-changing requests must be JSON, and failures become
 * one sanitized error body. The optional bundled dashboard mounts the read-only inspection routes
 * and its static UI on the same listener; `/v1` stays unchanged next to them.
 *
 * See docs/service.md#api, docs/service.md#bundled-dashboard and
 * docs/service.md#configuration-and-local-access.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";

import { noteIdSchema, noteSchema, type Cursor } from "../src/index.js";
import { decodeCursor, InvalidCursorError } from "./cursor.js";
import { invalidRequest, payloadTooLarge, ServiceFailure } from "./errors.js";
import {
  assertTrustedAuthority,
  bindAuthority,
  UntrustedAuthorityError,
  type BoundAuthority,
} from "./loopback-authority.js";
import {
  inspectionPageSchema,
  notesPageSchema,
  observationRequestSchema,
  receiptSchema,
  searchRequestSchema,
  searchResponseSchema,
  serviceErrorSchema,
  serviceStatusSchema,
} from "./schemas.js";
import type { MemoryService } from "./service.js";

/** One documented `/v1` route: the method and the OpenAPI-style path template. */
export interface ServiceRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
}

/** The complete route set of the documented API; the OpenAPI definition describes the same set. */
export const serviceRoutes: readonly ServiceRoute[] = [
  { method: "POST", path: "/v1/observations" },
  { method: "GET", path: "/v1/receipts/{receiptId}" },
  { method: "POST", path: "/v1/search" },
  { method: "GET", path: "/v1/notes/{noteId}" },
  { method: "GET", path: "/v1/notes" },
  { method: "GET", path: "/v1/inspection/records" },
  { method: "GET", path: "/v1/status" },
];

export interface MemoryServiceServerOptions {
  readonly service: MemoryService;
  readonly port: number;
  /** The maximum JSON request body size in UTF-8 bytes. */
  readonly bodyLimitBytes: number;
  /** The bound host; loopback only unless a future deployment review changes it. */
  readonly host?: string;
  /**
   * The bundled read-only dashboard, mounted on this listener. It claims every path outside
   * `/v1`, so unknown API routes stay API errors and a browser never sees an HTML fallback.
   */
  readonly dashboard?: BundledDashboardSurface;
}

/** The dashboard surface one listener mounts next to the memory API. */
export interface BundledDashboardSurface {
  /** Serve one dashboard request (browser API or static UI); only called for non-`/v1` paths. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /** Claim one WebSocket upgrade; returns false when the request names another path. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

/** A running service listener. */
export interface MemoryServiceServer {
  readonly port: number;
  /** Stop accepting connections; already accepted requests still finish. */
  close(): Promise<void>;
  /** Resolve once no accepted request is still being handled. */
  settled(): Promise<void>;
}

const uuidSchema = z.uuid();

const methodNotAllowed = (response: ServerResponse, allowed: string): never => {
  response.setHeader("allow", allowed);
  throw new ServiceFailure({
    status: 405,
    code: "invalid-request",
    message: `The route accepts ${allowed} requests.`,
    retryable: false,
  });
};

/** Serialize one validated response body; an invalid body is a service defect, not a client error. */
const sendJson = (
  response: ServerResponse,
  status: number,
  schema: z.ZodType,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `The service produced a response outside its own schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}.`,
    );
  }
  const text = JSON.stringify(parsed.data);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
};

const sendFailure = (
  response: ServerResponse,
  failure: ServiceFailure,
): void => {
  const body = serviceErrorSchema.parse({
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    },
  });
  const headers =
    failure.retryAfterSeconds === undefined
      ? {}
      : { "retry-after": String(failure.retryAfterSeconds) };
  sendJson(response, failure.status, serviceErrorSchema, body, headers);
};

/** Refuse a request that does not name the bound loopback authority. */
const assertTrustedRequest = (
  request: IncomingMessage,
  bound: BoundAuthority,
): void => {
  try {
    assertTrustedAuthority(request, bound);
  } catch (cause) {
    if (cause instanceof UntrustedAuthorityError) {
      throw invalidRequest(
        cause.reason === "origin"
          ? "The request Origin is not trusted."
          : "The request host is not the local memory service.",
      );
    }
    throw cause;
  }
};

/** State-changing requests carry JSON, never a form or an implicit content type. */
const assertJsonContentType = (request: IncomingMessage): void => {
  const header = request.headers["content-type"];
  const value = Array.isArray(header) ? header[0] : header;
  const mediaType = value?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw invalidRequest("A JSON request body is required.");
  }
};

/** Read one bounded JSON request body. */
const readJsonBody = async (
  request: IncomingMessage,
  bodyLimitBytes: number,
): Promise<unknown> => {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > bodyLimitBytes) {
    throw payloadTooLarge("The request body is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > bodyLimitBytes) {
      throw payloadTooLarge("The request body is too large.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    throw invalidRequest("A JSON request body is required.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidRequest("The request body is not valid JSON.");
  }
};

/** Parse an optional positive-integer limit query parameter. */
const limitParameter = (url: URL): number | undefined => {
  const raw = url.searchParams.get("limit");
  if (raw === null) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw invalidRequest("The limit must be a positive integer.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidRequest("The limit must be a positive integer.");
  }
  return value;
};

/** Parse an optional opaque cursor query parameter. */
const cursorParameter = (url: URL): Cursor | undefined => {
  const raw = url.searchParams.get("cursor");
  if (raw === null) {
    return undefined;
  }
  try {
    return decodeCursor(raw);
  } catch (cause) {
    if (cause instanceof InvalidCursorError) {
      throw invalidRequest(cause.message, cause);
    }
    throw cause;
  }
};

/** Read one path identity, refusing a malformed component before any lookup. */
const pathIdentity = (pathname: string, prefix: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    throw invalidRequest("The request path is not valid.");
  }
  return decoded;
};

const handleObservations = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: MemoryServiceServerOptions,
): Promise<void> => {
  assertJsonContentType(request);
  const body = await readJsonBody(request, options.bodyLimitBytes);
  const parsed = observationRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidRequest(
      "The observation is not a valid submission.",
      parsed.error,
    );
  }
  const submission = await options.service.submit(parsed.data);
  const { created, ...receipt } = submission;
  // A new durable acceptance is `202`; an identical resubmission found the existing receipt.
  const status = created ? 202 : 200;
  sendJson(response, status, receiptSchema, receipt, {
    location: `/v1/receipts/${submission.id}`,
  });
};

const handleSearch = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: MemoryServiceServerOptions,
): Promise<void> => {
  assertJsonContentType(request);
  const body = await readJsonBody(request, options.bodyLimitBytes);
  const parsed = searchRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidRequest("The search request is not valid.", parsed.error);
  }
  const outcome = await options.service.search(parsed.data.query, {
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    ...(parsed.data.linkedLimit === undefined
      ? {}
      : { linkedLimit: parsed.data.linkedLimit }),
  });
  sendJson(response, 200, searchResponseSchema, outcome);
};

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: MemoryServiceServerOptions,
  bound: BoundAuthority,
): Promise<void> => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${bound.authority}`);
  const pathname = url.pathname;
  assertTrustedRequest(request, bound);

  if (
    options.dashboard !== undefined &&
    pathname !== "/v1" &&
    !pathname.startsWith("/v1/")
  ) {
    // The dashboard owns `/`, its assets and `/api`; unknown routes there stay API errors.
    await options.dashboard.handle(request, response);
    return;
  }

  if (pathname === "/v1/observations") {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
    }
    return await handleObservations(request, response, options);
  }
  if (pathname === "/v1/search") {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
    }
    return await handleSearch(request, response, options);
  }
  if (pathname === "/v1/status") {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
    }
    sendJson(
      response,
      200,
      serviceStatusSchema,
      await options.service.status(),
    );
    return;
  }
  if (pathname === "/v1/notes") {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
    }
    const page = await options.service.notes(
      limitParameter(url),
      cursorParameter(url),
    );
    sendJson(response, 200, notesPageSchema, page);
    return;
  }
  if (pathname === "/v1/inspection/records") {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
    }
    const page = await options.service.inspectionRecords(
      limitParameter(url),
      cursorParameter(url),
    );
    sendJson(response, 200, inspectionPageSchema, page);
    return;
  }
  if (pathname.startsWith("/v1/notes/")) {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
    }
    const parsedId = noteIdSchema.safeParse(
      pathIdentity(pathname, "/v1/notes/"),
    );
    if (!parsedId.success) {
      throw invalidRequest("The note ID is not valid.", parsedId.error);
    }
    const note = await options.service.note(parsedId.data);
    if (note === undefined) {
      throw new ServiceFailure({
        status: 404,
        code: "not-found",
        message: "No note exists with that ID.",
        retryable: false,
      });
    }
    sendJson(response, 200, noteSchema, note);
    return;
  }
  if (pathname.startsWith("/v1/receipts/")) {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
    }
    const parsedId = uuidSchema.safeParse(
      pathIdentity(pathname, "/v1/receipts/"),
    );
    if (!parsedId.success) {
      throw invalidRequest("The receipt ID is not valid.", parsedId.error);
    }
    const receipt = await options.service.receipt(parsedId.data);
    if (receipt === undefined) {
      throw new ServiceFailure({
        status: 404,
        code: "not-found",
        message: "No receipt exists with that ID.",
        retryable: false,
      });
    }
    sendJson(response, 200, receiptSchema, receipt);
    return;
  }
  throw new ServiceFailure({
    status: 404,
    code: "not-found",
    message: "No such memory service route.",
    retryable: false,
  });
};

/** Start the loopback service listener. */
export const startMemoryServiceServer = async (
  options: MemoryServiceServerOptions,
): Promise<MemoryServiceServer> => {
  const boundHost = options.host ?? "127.0.0.1";
  const inflight = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const handled = handleRequest(request, response, options, bound).catch(
      (cause: unknown) => {
        const failure =
          cause instanceof ServiceFailure
            ? cause
            : new ServiceFailure({
                status: 500,
                code: "internal",
                message: "The memory service could not serve the request.",
                retryable: false,
                cause,
              });
        if (failure.status >= 500) {
          console.error(
            `[service] ${request.method ?? "GET"} ${request.url ?? ""} failed:`,
            failure.cause ?? failure,
          );
        }
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendFailure(response, failure);
      },
    );
    inflight.add(handled);
    void handled.finally(() => inflight.delete(handled));
  });
  if (options.dashboard !== undefined) {
    const dashboard = options.dashboard;
    server.on("upgrade", (request, socket, head) => {
      try {
        // The loopback authority rules hold for the handshake exactly as for an HTTP request.
        assertTrustedRequest(request, bound);
      } catch (cause) {
        const failure =
          cause instanceof ServiceFailure
            ? cause
            : new ServiceFailure({
                status: 500,
                code: "internal",
                message: "The memory service could not serve the request.",
                retryable: false,
                cause,
              });
        const body = JSON.stringify({
          error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
          },
        });
        socket.end(
          `HTTP/1.1 ${String(failure.status)} ` +
            `${failure.status === 400 ? "Bad Request" : "Internal Server Error"}\r\n` +
            "content-type: application/json; charset=utf-8\r\n" +
            "connection: close\r\n" +
            `content-length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
        );
        return;
      }
      let claimed = false;
      try {
        claimed = dashboard.upgrade(request, socket, head);
      } catch (cause) {
        console.error(
          `[service] ${request.method ?? "GET"} ${request.url ?? ""} upgrade failed:`,
          cause,
        );
      }
      if (!claimed) {
        // An upgrade the dashboard does not know is refused instead of left half-open.
        socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      }
    });
  }
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
  const bound = bindAuthority(boundHost, port);
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
        // Idle keep-alive sockets must not keep the listener open during shutdown.
        server.closeIdleConnections();
      });
    },
    settled: async () => {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
};
