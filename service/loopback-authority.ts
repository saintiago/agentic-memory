/**
 * The loopback authority rules the local service and the bundled dashboard share: the listener
 * owns one `host:port` authority, accepts the loopback spellings of the same machine and refuses
 * a request whose `Host` (or browser `Origin`) names anything else, so a hostname rebound to the
 * loopback address cannot reach the API.
 *
 * See docs/service.md#configuration-and-local-access.
 */
import type { IncomingMessage } from "node:http";

/** The bound authority of one listener and the authorities trusted as the same service. */
export interface BoundAuthority {
  /** The lowercase `host:port` the listener owns. */
  readonly authority: string;
  /** Every authority trusted as this service. */
  readonly trusted: ReadonlySet<string>;
}

/** A request whose Host or Origin does not name the bound loopback service. */
export class UntrustedAuthorityError extends Error {
  /** Which check refused the request, so each boundary keeps its own sanitized message. */
  readonly reason: "host" | "origin";

  constructor(reason: "host" | "origin", message: string) {
    super(message);
    this.name = "UntrustedAuthorityError";
    this.reason = reason;
  }
}

/** Loopback host spellings a local browser may legitimately use to reach the service. */
export const loopbackHosts = ["127.0.0.1", "::1", "localhost"] as const;

/** One lowercase `host:port` authority key; IPv6 hosts stay bracketed as URLs spell them. */
export const authorityKey = (host: string, port: number): string =>
  `${host.includes(":") ? `[${host}]` : host}:${String(port)}`.toLowerCase();

/** The authorities trusted as this service: the bound host and, on loopback, its aliases. */
export const trustedAuthorities = (
  host: string,
  port: number,
): ReadonlySet<string> => {
  const trusted = new Set([authorityKey(host, port)]);
  if ((loopbackHosts as readonly string[]).includes(host)) {
    for (const alias of loopbackHosts) {
      trusted.add(authorityKey(alias, port));
    }
  }
  return trusted;
};

/** The authority rules of one listener bound to `host:port`. */
export const bindAuthority = (host: string, port: number): BoundAuthority => ({
  authority: authorityKey(host, port),
  trusted: trustedAuthorities(host, port),
});

/**
 * Refuse a request that does not name this listener. The Host header must be a trusted loopback
 * authority, and a browser Origin must name one as well, instead of whatever Host the request
 * itself supplied.
 */
export const assertTrustedAuthority = (
  request: IncomingMessage,
  bound: BoundAuthority,
): void => {
  const host = request.headers.host;
  if (host === undefined || !bound.trusted.has(host.toLowerCase())) {
    throw new UntrustedAuthorityError(
      "host",
      "The request host is not the local service.",
    );
  }
  const origin = request.headers.origin;
  if (origin === undefined) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new UntrustedAuthorityError(
      "origin",
      "The request Origin is not trusted.",
    );
  }
  if (
    parsed.protocol !== "http:" ||
    !bound.trusted.has(parsed.host.toLowerCase())
  ) {
    throw new UntrustedAuthorityError(
      "origin",
      "The request Origin is not trusted.",
    );
  }
};
