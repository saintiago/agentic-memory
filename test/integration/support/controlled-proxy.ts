/**
 * An HTTP proxy in front of a real Qdrant that records each request and can drop the caller's
 * connection after Qdrant has already applied a write. It models an acknowledgment lost in
 * transport, which cannot be induced reliably through a healthy local server.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { request as httpsRequest } from "node:https";

export interface ProxyRequest {
  readonly method: string;
  /** Request target including the query string, as sent by the client. */
  readonly path: string;
  /** Request path without the query string, so predicates can match routes. */
  readonly pathname: string;
  readonly body: unknown;
}

export type InterruptPredicate = (request: ProxyRequest) => boolean;

export interface ControlledProxy {
  readonly url: string;
  readonly requests: ProxyRequest[];
  close(): Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
};

const parseBody = (body: Buffer): unknown => {
  if (body.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return body.toString("utf8");
  }
};

/** Serve `target` under `basePath`; `interrupt` decides which recorded requests lose their reply. */
export const startControlledProxy = async (
  target: string,
  interrupt: InterruptPredicate,
  basePath = "",
): Promise<ControlledProxy> => {
  const destination = new URL(target);
  const requests: ProxyRequest[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const target = request.url ?? "/";
      const forwarded: ProxyRequest = {
        method: request.method ?? "GET",
        path: target,
        pathname: target.split("?")[0] ?? "/",
        body: parseBody(body),
      };
      requests.push(forwarded);
      if (!forwarded.path.startsWith(`${basePath}/`)) {
        response.writeHead(404).end();
        return;
      }
      const headers: Record<string, string | string[] | undefined> = {
        ...request.headers,
        host: destination.host,
        "content-length": String(body.length),
      };
      delete headers["transfer-encoding"];
      const upstreamRequest =
        destination.protocol === "https:" ? httpsRequest : httpRequest;
      const upstream = upstreamRequest(
        new URL(
          `${destination.origin}${destination.pathname.replace(/\/$/, "")}${forwarded.path.slice(basePath.length)}`,
        ),
        {
          method: forwarded.method,
          headers,
        },
        (upstreamResponse) => {
          if (interrupt(forwarded)) {
            upstreamResponse.resume();
            upstreamResponse.once("end", () => response.socket?.destroy());
            return;
          }
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          );
          upstreamResponse.pipe(response);
        },
      );
      upstream.once("error", () => response.socket?.destroy());
      upstream.end(body);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}${basePath}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
