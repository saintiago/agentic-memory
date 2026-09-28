/**
 * The local HTTP surface of the inspection host: the same-origin JSON API the Sigma UI polls and
 * the static UI directory it is served from. The server binds loopback only and exposes no write
 * or generation route.
 *
 * See docs/dashboard.md#browser-api.
 */
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { z } from "zod";

import {
  MemoryError,
  noteIdSchema,
  type Note,
  type SearchOptions,
  type SearchResult,
} from "../src/index.js";
import {
  InspectionComparisonError,
  type InspectionSession,
} from "./session.js";

/** The public read operations the host composes; it never writes or generates. */
export interface InspectionReads {
  get(id: string): Promise<Note | undefined>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export interface InspectionServerOptions {
  readonly reads: InspectionReads;
  readonly session: InspectionSession;
  /** The static UI directory, which must exist before the host is exposed. */
  readonly uiDirectory: string;
  readonly port: number;
  readonly now?: () => Date;
}

/** A running inspection server. */
export interface InspectionServer {
  readonly port: number;
  close(): Promise<void>;
}

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

/** The request body limit of the local API. */
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

/** A request the host refuses with a specific status and a sanitized explanation. */
class HttpFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpFailure";
    this.status = status;
  }
}

const sendJson = (
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

const methodNotAllowed = (response: ServerResponse, allowed: string): void => {
  response.setHeader("allow", allowed);
  throw new HttpFailure(405, `The route accepts ${allowed} requests.`);
};

/** Read one JSON request body, bounded and validated only as JSON. */
const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > bodyLimit) {
    throw new HttpFailure(413, "The request body is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > bodyLimit) {
      throw new HttpFailure(413, "The request body is too large.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    throw new HttpFailure(400, "A JSON request body is required.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpFailure(400, "The request body is not valid JSON.");
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
    throw new HttpFailure(400, "The request path is not valid.");
  }
  if (decoded.includes("\0")) {
    throw new HttpFailure(400, "The request path is not valid.");
  }
  const root = path.resolve(uiDirectory);
  const file = path.resolve(root, decoded.replace(/^\/+/, "") || "index.html");
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new HttpFailure(404, "Not found.");
  }
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpFailure(404, "Not found.");
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

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: InspectionServerOptions,
): Promise<void> => {
  const method = request.method ?? "GET";
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

  if (pathname === "/api/graph") {
    if (method !== "GET") {
      return methodNotAllowed(response, "GET");
    }
    return sendJson(response, 200, options.session.snapshot());
  }
  if (pathname === "/api/refresh") {
    if (method !== "POST") {
      return methodNotAllowed(response, "POST");
    }
    options.session.refresh();
    return sendJson(response, 202, options.session.snapshot());
  }
  if (pathname === "/api/projection/rebuild") {
    if (method !== "POST") {
      return methodNotAllowed(response, "POST");
    }
    options.session.rebuild();
    return sendJson(response, 202, options.session.snapshot());
  }
  if (pathname === "/api/search") {
    if (method !== "POST") {
      return methodNotAllowed(response, "POST");
    }
    const parsed = searchRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      throw new HttpFailure(400, "The search request is not valid.");
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
      if (cause instanceof MemoryError && cause.stage === "input") {
        throw new HttpFailure(400, "The search request is not valid.", {
          cause,
        });
      }
      throw new HttpFailure(500, "The search failed.", { cause });
    }
    return sendJson(response, 200, {
      searchedAt: (options.now ?? (() => new Date()))().toISOString(),
      results,
    });
  }
  if (pathname === "/api/compare") {
    if (method !== "POST") {
      return methodNotAllowed(response, "POST");
    }
    const parsed = compareRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      throw new HttpFailure(400, "The comparison request is not valid.");
    }
    try {
      return sendJson(
        response,
        200,
        await options.session.compare(parsed.data.leftId, parsed.data.rightId),
      );
    } catch (cause) {
      if (cause instanceof InspectionComparisonError) {
        throw new HttpFailure(
          cause.reason === "no-view" ? 409 : 404,
          cause.message,
        );
      }
      throw new HttpFailure(500, "The comparison failed.", { cause });
    }
  }
  if (pathname.startsWith("/api/notes/")) {
    if (method !== "GET") {
      return methodNotAllowed(response, "GET");
    }
    let noteId: string;
    try {
      noteId = decodeURIComponent(pathname.slice("/api/notes/".length));
    } catch {
      throw new HttpFailure(400, "The note ID is not valid.");
    }
    const parsed = noteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      throw new HttpFailure(400, "The note ID is not valid.");
    }
    let note: Note | undefined;
    try {
      note = await options.reads.get(parsed.data);
    } catch (cause) {
      throw new HttpFailure(500, "The note could not be read.", { cause });
    }
    if (note === undefined) {
      throw new HttpFailure(404, "No note exists with that ID.");
    }
    return sendJson(response, 200, note);
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    throw new HttpFailure(404, "No such inspection route.");
  }
  if (method !== "GET") {
    return methodNotAllowed(response, "GET");
  }
  return serveUi(response, options.uiDirectory, pathname);
};

/** Start the loopback inspection server; every response is JSON except the static UI files. */
export const startInspectionServer = async (
  options: InspectionServerOptions,
): Promise<InspectionServer> => {
  const uiDirectory = path.resolve(options.uiDirectory);
  const stats = await stat(uiDirectory).catch(() => undefined);
  if (stats === undefined || !stats.isDirectory()) {
    throw new Error(
      `The inspection UI directory "${uiDirectory}" does not exist or is not a directory.`,
    );
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, options).catch((cause: unknown) => {
      const failure =
        cause instanceof HttpFailure
          ? cause
          : new HttpFailure(
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
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, failure.status, { error: failure.message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : options.port;
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
        server.closeIdleConnections();
      });
    },
  };
};
