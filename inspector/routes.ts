/**
 * The HTTP routes of the read-only dashboard: the same-origin browser API and the static UI
 * directory. The module is mounted by the bundled service listener and by the development
 * inspection host, so the route contract exists once. The caller validates the bound loopback
 * authority before dispatch and owns the listener, the WebSocket upgrade and the projection
 * worker lifecycle.
 *
 * See docs/dashboard.md#browser-api.
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";

import {
  MemoryError,
  noteIdSchema,
  type Note,
  type SearchOptions,
  type SearchResult,
} from "../src/index.js";
import { graphEventsPath } from "./events.js";
import {
  InspectionComparisonError,
  type InspectionSession,
} from "./session.js";
import { InspectionInputError } from "./source.js";

/** The public read operations the dashboard composes; it never writes or generates. */
export interface InspectionReads {
  get(id: string): Promise<Note | undefined>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export interface InspectionHttpOptions {
  readonly reads: InspectionReads;
  readonly session: InspectionSession;
  /**
   * The static UI directory. A missing `index.html` is an explicit dashboard-unavailable
   * response; the memory API of the same listener stays available.
   */
  readonly uiDirectory: string;
  readonly now?: () => Date;
}

/** The sanitized text of the missing-build response. */
export const dashboardUnavailableMessage =
  "The dashboard build is not available on this service; the memory API stays available.";

/** The accepted search request; the public memory constraints validate query and limits. */
const searchRequestSchema = z.strictObject({
  query: z.string(),
  limit: z.number().optional(),
  linkedLimit: z.number().optional(),
});

/** The accepted comparison request: exactly two note identities. */
const compareRequestSchema = z.strictObject({
  leftId: noteIdSchema,
  rightId: noteIdSchema,
});

/** The request body limit of the local browser API. */
const bodyLimit = 65_536;

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** Whether the path belongs to the service's `/v1` memory API instead of the dashboard. */
export const isMemoryApiPath = (pathname: string): boolean =>
  pathname === "/v1" || pathname.startsWith("/v1/");

/** A dashboard request refused with a specific status and a sanitized explanation. */
export class InspectionHttpFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InspectionHttpFailure";
    this.status = status;
  }
}

/** Send one JSON body with the dashboard's sanitized error shape. */
export const sendInspectionJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
};

const methodNotAllowed = (response: ServerResponse, allowed: string): never => {
  response.setHeader("allow", allowed);
  throw new InspectionHttpFailure(
    405,
    `The route accepts ${allowed} requests.`,
  );
};

/** Read one JSON request body, bounded and validated only as JSON. */
const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > bodyLimit) {
    throw new InspectionHttpFailure(413, "The request body is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > bodyLimit) {
      throw new InspectionHttpFailure(413, "The request body is too large.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    throw new InspectionHttpFailure(400, "A JSON request body is required.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InspectionHttpFailure(400, "The request body is not valid JSON.");
  }
};

/** Serve one file of the static UI directory, refusing paths that leave it. */
const serveUi = async (
  response: ServerResponse,
  uiDirectory: string,
  pathname: string,
): Promise<void> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new InspectionHttpFailure(400, "The request path is not valid.");
  }
  if (decoded.includes("\0")) {
    throw new InspectionHttpFailure(400, "The request path is not valid.");
  }
  const root = path.resolve(uiDirectory);
  const relative = decoded.replace(/^\/+/, "") || "index.html";
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new InspectionHttpFailure(404, "Not found.");
  }
  const isEntry = relative === "index.html";
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    if (isEntry) {
      // A missing or stale build is never an empty dashboard and never disables the API.
      throw new InspectionHttpFailure(503, dashboardUnavailableMessage);
    }
    throw new InspectionHttpFailure(404, "Not found.");
  }
  response.writeHead(200, {
    "content-type":
      contentTypes[path.extname(file).toLowerCase()] ??
      "application/octet-stream",
    "cache-control": "no-cache",
    "content-length": data.length,
  });
  response.end(data);
};

/**
 * Handle one dashboard request. Returns false only for a `/v1` path the memory API owns, so the
 * bundled listener can route memory and dashboard traffic on one origin.
 */
export const handleInspectionRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: InspectionHttpOptions,
): Promise<boolean> => {
  const method = request.method ?? "GET";
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

  if (isMemoryApiPath(pathname)) {
    return false;
  }
  if (pathname === graphEventsPath) {
    // The upgrade is handled by the listener; a plain request cannot read the channel.
    response.setHeader("upgrade", "websocket");
    throw new InspectionHttpFailure(
      426,
      "The event channel requires a WebSocket upgrade.",
    );
  }
  if (pathname === "/api/graph") {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
    }
    sendInspectionJson(response, 200, options.session.snapshot());
    return true;
  }
  if (pathname === "/api/refresh") {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
    }
    options.session.refresh();
    sendInspectionJson(response, 202, options.session.snapshot());
    return true;
  }
  if (pathname === "/api/projection/rebuild") {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
    }
    options.session.rebuild();
    sendInspectionJson(response, 202, options.session.snapshot());
    return true;
  }
  if (pathname === "/api/search") {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
    }
    const parsed = searchRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      throw new InspectionHttpFailure(400, "The search request is not valid.");
    }
    let results: SearchResult[];
    try {
      results = await options.reads.search(parsed.data.query, {
        ...(parsed.data.limit === undefined
          ? {}
          : { limit: parsed.data.limit }),
        ...(parsed.data.linkedLimit === undefined
          ? {}
          : { linkedLimit: parsed.data.linkedLimit }),
      });
    } catch (cause) {
      // The public API validates the query and limits; its input failures are the caller's.
      if (
        cause instanceof InspectionInputError ||
        (cause instanceof MemoryError && cause.stage === "input")
      ) {
        throw new InspectionHttpFailure(
          400,
          "The search request is not valid.",
          {
            cause,
          },
        );
      }
      throw new InspectionHttpFailure(500, "The search failed.", { cause });
    }
    sendInspectionJson(response, 200, {
      searchedAt: (options.now ?? (() => new Date()))().toISOString(),
      results,
    });
    return true;
  }
  if (pathname === "/api/compare") {
    if (method !== "POST") {
      methodNotAllowed(response, "POST");
    }
    const parsed = compareRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      throw new InspectionHttpFailure(
        400,
        "The comparison request is not valid.",
      );
    }
    try {
      sendInspectionJson(
        response,
        200,
        await options.session.compare(parsed.data.leftId, parsed.data.rightId),
      );
    } catch (cause) {
      if (cause instanceof InspectionComparisonError) {
        throw new InspectionHttpFailure(
          cause.reason === "no-view" ? 409 : 404,
          cause.message,
        );
      }
      throw new InspectionHttpFailure(500, "The comparison failed.", {
        cause,
      });
    }
    return true;
  }
  if (pathname.startsWith("/api/notes/")) {
    if (method !== "GET") {
      methodNotAllowed(response, "GET");
    }
    let noteId: string;
    try {
      noteId = decodeURIComponent(pathname.slice("/api/notes/".length));
    } catch {
      throw new InspectionHttpFailure(400, "The note ID is not valid.");
    }
    const parsed = noteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      throw new InspectionHttpFailure(400, "The note ID is not valid.");
    }
    let note: Note | undefined;
    try {
      note = await options.reads.get(parsed.data);
    } catch (cause) {
      throw new InspectionHttpFailure(500, "The note could not be read.", {
        cause,
      });
    }
    if (note === undefined) {
      throw new InspectionHttpFailure(404, "No note exists with that ID.");
    }
    sendInspectionJson(response, 200, note);
    return true;
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    throw new InspectionHttpFailure(404, "No such inspection route.");
  }
  if (method !== "GET") {
    methodNotAllowed(response, "GET");
  }
  await serveUi(response, options.uiDirectory, pathname);
  return true;
};

/** Report one failed dashboard request with the sanitized JSON error body. */
export const sendInspectionFailure = (
  response: ServerResponse,
  failure: InspectionHttpFailure,
): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendInspectionJson(response, failure.status, { error: failure.message });
};
