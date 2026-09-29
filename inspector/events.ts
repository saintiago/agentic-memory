/**
 * The read-only WebSocket notification channel of the dashboard: `GET /api/events` on the
 * service's own loopback listener. Clients receive a `resync` when they connect and a coalesced
 * `graph-changed` whenever the served graph state changes; HTTP remains the authoritative
 * snapshot source, so the payloads carry no graph data and a slow client is disconnected to
 * resync instead of being allowed to accumulate work.
 *
 * This module implements the small RFC 6455 server subset browsers use here (text frames, pings,
 * pongs and close frames). It stays a host dependency; the reusable library never imports it.
 *
 * See docs/dashboard.md#websocket-updates.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** The route of the graph notification channel. */
export const graphEventsPath = "/api/events";

/** The JSON notification one connected browser receives. */
export interface GraphEventMessage {
  readonly type: "resync" | "graph-changed";
}

export interface GraphEventHubOptions {
  /** The outbound buffer a slow client may accumulate before it is disconnected, in bytes. */
  readonly maxBufferedBytes?: number;
  /** How often idle connections are checked with a ping, in milliseconds; zero disables it. */
  readonly pingIntervalMs?: number;
  /** How long a socket may stay open after `close()` before it is destroyed, in milliseconds. */
  readonly closeGraceMs?: number;
  /** Injected clock for tests. */
  readonly now?: () => number;
}

/** The notification channel of one listener. */
export interface GraphEventHub {
  /** How many browsers are currently subscribed; the shutdown check observes it. */
  readonly connections: number;
  /** Notify subscribed browsers that the served graph state changed; coalesced per connection. */
  notify(): void;
  /** Claim one `GET /api/events` upgrade; returns false when the request names another path. */
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean;
  /** Close every subscription and release the liveness timer. */
  close(): Promise<void>;
}

const defaultMaxBufferedBytes = 65_536;
const defaultPingIntervalMs = 30_000;
const defaultCloseGraceMs = 1_000;

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const opcodeText = 0x1;
const opcodeClose = 0x8;
const opcodePing = 0x9;
const opcodePong = 0xa;

const closeGoingAway = 1001;

/** One server frame: FIN and the opcode, with a payload length no client here ever exceeds. */
const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
};

const encodeTextFrame = (text: string): Buffer =>
  encodeFrame(opcodeText, Buffer.from(text, "utf8"));

/** The fixed frame payloads of this channel; one message never needs a second frame. */
const resyncFrame = encodeTextFrame(JSON.stringify({ type: "resync" }));
const changedFrame = encodeTextFrame(JSON.stringify({ type: "graph-changed" }));

/** One decoded inbound frame; control frames carry at most 125 bytes by contract. */
interface DecodedFrame {
  readonly final: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/**
 * Decode one complete client frame, or return `undefined` while more bytes are needed. A client
 * frame that violates the framing rules (unmasked, oversized, fragmented control) is refused.
 */
const decodeFrame = (
  buffer: Buffer,
): { readonly frame: DecodedFrame; readonly size: number } | undefined => {
  if (buffer.length < 2) {
    return undefined;
  }
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const final = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) {
      return undefined;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return undefined;
    }
    const declared = buffer.readBigUInt64BE(offset);
    if (declared > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProtocolError("The frame length is not supported.");
    }
    length = Number(declared);
    offset += 8;
  }
  if (!masked) {
    throw new ProtocolError("Client frames must be masked.");
  }
  if (opcode >= 0x8 && (length > 125 || !final)) {
    throw new ProtocolError("Control frames must be short and unfragmented.");
  }
  if (buffer.length < offset + 4 + length) {
    return undefined;
  }
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return { frame: { final, opcode, payload }, size: offset + length };
};

/** A framing error that closes the connection instead of being answered. */
class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** One subscribed browser. */
interface Connection {
  readonly socket: Duplex;
  /** Whether a notification write is still in flight; further notifications coalesce. */
  writing: boolean;
  /** Whether a notification arrived while one was in flight. */
  pending: boolean;
  /** The last time any inbound frame was decoded. */
  seenAt: number;
  /** Bytes of inbound frames that are not decoded yet. */
  buffered: Buffer;
  closed: boolean;
}

class Hub implements GraphEventHub {
  readonly #maxBufferedBytes: number;
  readonly #pingIntervalMs: number;
  readonly #closeGraceMs: number;
  readonly #now: () => number;
  readonly #connections = new Set<Connection>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: GraphEventHubOptions) {
    this.#maxBufferedBytes =
      options.maxBufferedBytes ?? defaultMaxBufferedBytes;
    this.#pingIntervalMs = options.pingIntervalMs ?? defaultPingIntervalMs;
    this.#closeGraceMs = options.closeGraceMs ?? defaultCloseGraceMs;
    this.#now = options.now ?? (() => Date.now());
    if (this.#pingIntervalMs > 0) {
      this.#timer = setInterval(() => {
        this.#sweep();
      }, this.#pingIntervalMs);
      // A forgotten hub timer must never keep a host process alive.
      if (typeof this.#timer.unref === "function") {
        this.#timer.unref();
      }
    }
  }

  get connections(): number {
    return this.#connections.size;
  }

  notify(): void {
    if (this.#closed) {
      return;
    }
    for (const connection of this.#connections) {
      this.#send(connection, changedFrame);
    }
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      return false;
    }
    if (pathname !== graphEventsPath) {
      return false;
    }
    const key = request.headers["sec-websocket-key"];
    const version = request.headers["sec-websocket-version"];
    const upgrade = request.headers.upgrade;
    if (
      request.method !== "GET" ||
      upgrade?.toLowerCase() !== "websocket" ||
      typeof key !== "string" ||
      version !== "13"
    ) {
      this.#refuse(socket, 400, "The event route needs a WebSocket handshake.");
      return true;
    }
    if (this.#closed) {
      this.#refuse(socket, 503, "The event channel is closed.");
      return true;
    }
    const accept = createHash("sha1")
      .update(`${key}${websocketGuid}`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const connection: Connection = {
      socket,
      writing: false,
      pending: false,
      seenAt: this.#now(),
      buffered: Buffer.alloc(0),
      closed: false,
    };
    this.#connections.add(connection);
    socket.on("error", () => {
      this.#drop(connection);
    });
    socket.on("close", () => {
      this.#drop(connection);
    });
    socket.on("data", (chunk: Buffer) => {
      this.#receive(connection, chunk);
    });
    // A connection resyncs the browser: the served view may have changed while nobody listened.
    this.#send(connection, resyncFrame);
    if (head.length > 0) {
      this.#receive(connection, head);
    }
    return true;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const ends = [...this.#connections].map((connection) =>
      this.#finish(connection, encodeClosePayload(closeGoingAway)),
    );
    await Promise.all(ends);
  }

  /** Refuse a handshake with one raw HTTP response, then tear the socket down. */
  #refuse(socket: Duplex, status: number, message: string): void {
    const body = JSON.stringify({ error: message });
    socket.write(
      `HTTP/1.1 ${String(status)} ${status === 400 ? "Bad Request" : "Service Unavailable"}\r\n` +
        "content-type: application/json; charset=utf-8\r\n" +
        "connection: close\r\n" +
        `content-length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
    );
    socket.end();
  }

  /** Coalesce one notification per connection and drop a client that cannot keep up. */
  #send(connection: Connection, frame: Buffer): void {
    if (connection.closed) {
      return;
    }
    if (connection.writing) {
      connection.pending = true;
      return;
    }
    const socket = connection.socket;
    if (!this.#hasOutboundRoom(connection)) {
      return;
    }
    connection.writing = true;
    socket.write(frame, () => {
      connection.writing = false;
      if (connection.closed) {
        return;
      }
      if (connection.pending) {
        connection.pending = false;
        this.#send(connection, changedFrame);
      }
    });
  }

  #receive(connection: Connection, chunk: Buffer): void {
    if (connection.closed) {
      return;
    }
    connection.seenAt = this.#now();
    connection.buffered = Buffer.concat([connection.buffered, chunk]);
    for (;;) {
      let decoded: { readonly frame: DecodedFrame; readonly size: number };
      try {
        const next = decodeFrame(connection.buffered);
        if (next === undefined) {
          break;
        }
        decoded = next;
      } catch {
        this.#closeWith(connection, 1002);
        return;
      }
      connection.buffered = connection.buffered.subarray(decoded.size);
      const { opcode, payload } = decoded.frame;
      if (opcode === opcodeClose) {
        this.#closeWith(connection, undefined, payload);
        return;
      }
      if (opcode === opcodePing) {
        this.#writeControl(connection, encodeFrame(opcodePong, payload));
      }
      // Text, binary and continuation frames are ignored: this channel only notifies.
    }
    if (connection.buffered.length > this.#maxBufferedBytes) {
      // Client frames are ignored, so an unbounded buffer would be pure waste.
      this.#closeWith(connection, 1009);
    }
  }

  /**
   * Whether the socket may accept one more frame. Notifications and control frames share the same
   * bound: the browser reconnects with bounded backoff and resyncs, so a client that stops
   * reading is disconnected instead of growing the shared service's buffer.
   */
  #hasOutboundRoom(connection: Connection): boolean {
    const socket = connection.socket;
    if (
      socket.writableLength > this.#maxBufferedBytes ||
      socket.writableNeedDrain
    ) {
      this.#drop(connection);
      return false;
    }
    return true;
  }

  /** Send one control frame under the same outbound bound as notifications. */
  #writeControl(connection: Connection, frame: Buffer): void {
    if (!connection.closed && this.#hasOutboundRoom(connection)) {
      connection.socket.write(frame);
    }
  }

  /** Ping every connection on the sweep and drop one that stopped answering. */
  #sweep(): void {
    const now = this.#now();
    for (const connection of [...this.#connections]) {
      if (now - connection.seenAt > this.#pingIntervalMs * 2) {
        this.#drop(connection);
        continue;
      }
      this.#writeControl(connection, encodeFrame(opcodePing, Buffer.alloc(0)));
    }
  }

  /** Answer a close frame or refuse a connection, then finish the socket. */
  #closeWith(
    connection: Connection,
    code: number | undefined,
    reason?: Buffer,
  ): void {
    const payload =
      code === undefined
        ? (reason ?? Buffer.alloc(0))
        : encodeClosePayload(code, reason);
    void this.#finish(connection, payload);
  }

  /** Send the supplied close payload and resolve once the socket ended or was destroyed. */
  #finish(connection: Connection, payload: Buffer): Promise<void> {
    if (connection.closed) {
      return Promise.resolve();
    }
    const socket = connection.socket;
    connection.closed = true;
    this.#connections.delete(connection);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, this.#closeGraceMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      // The close frame is flushed with the FIN; a peer that never answers is destroyed in time.
      socket.end(encodeFrame(opcodeClose, payload));
    });
  }

  #drop(connection: Connection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    this.#connections.delete(connection);
    connection.socket.destroy();
  }
}

const encodeClosePayload = (code: number, reason?: Buffer): Buffer => {
  const text = reason?.subarray(0, 123) ?? Buffer.alloc(0);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
};

/** Create the graph notification channel of one loopback listener. */
export const createGraphEvents = (
  options: GraphEventHubOptions,
): GraphEventHub => new Hub(options);
