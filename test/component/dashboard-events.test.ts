import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createGraphEvents, graphEventsPath } from "../../inspector/events.js";

/**
 * Component test of the graph notification channel: the browser handshake, the coalesced and
 * bounded outbound notifications, client control frames and the clean close. The listener owns
 * the loopback authority check, so this module is exercised with a scripted socket.
 *
 * See docs/dashboard.md#websocket-updates.
 */

/** A scripted Duplex socket: writes are recorded and the close callback can be held open. */
class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = [];
  writableLength = 0;
  writableNeedDrain = false;
  destroyed = false;
  ended = false;
  holdWrites = false;
  readonly held: Array<() => void> = [];

  write(chunk: unknown, callback?: () => void): boolean {
    this.written.push(Buffer.from(chunk as Buffer));
    if (callback !== undefined) {
      if (this.holdWrites) {
        this.held.push(callback);
      } else {
        callback();
      }
    }
    return true;
  }

  /** Complete the writes the case held open. */
  flush(): void {
    for (const callback of this.held.splice(0)) {
      callback();
    }
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined) {
      this.written.push(Buffer.from(chunk as Buffer));
    }
    this.ended = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A minimal upgrade request as Node hands it to the `upgrade` event. */
const upgradeRequest = (url = graphEventsPath): IncomingMessage =>
  ({
    method: "GET",
    url,
    headers: {
      host: "127.0.0.1:4748",
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  }) as unknown as IncomingMessage;

/** One client frame, masked as the browser sends it. */
const clientFrame = (opcode: number, payload: Buffer): Buffer => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = (masked[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([
    Buffer.from([0x80 | opcode, 0x80 | masked.length]),
    mask,
    masked,
  ]);
};

/** Decode the server's unmasked frames for assertions. */
const serverFrames = (
  socket: FakeSocket,
): Array<{ readonly opcode: number; readonly payload: Buffer }> => {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  const all = Buffer.concat(socket.written);
  const handshakeEnd = all.indexOf("\r\n\r\n", 0, "utf8");
  let buffer =
    handshakeEnd === -1 ? all : all.subarray(handshakeEnd + "\r\n\r\n".length);
  while (buffer.length >= 2) {
    const opcode = (buffer[0] ?? 0) & 0x0f;
    let length = buffer[1] ?? 0;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) {
        break;
      }
      length = buffer.readUInt16BE(2);
      offset = 4;
    }
    if (buffer.length < offset + length) {
      break;
    }
    frames.push({ opcode, payload: buffer.subarray(offset, offset + length) });
    buffer = buffer.subarray(offset + length);
  }
  return frames;
};

const connect = (
  hub: ReturnType<typeof createGraphEvents>,
  url = graphEventsPath,
): FakeSocket => {
  const socket = new FakeSocket();
  expect(
    hub.handleUpgrade(
      upgradeRequest(url),
      socket as unknown as Duplex,
      Buffer.alloc(0),
    ),
  ).toBe(true);
  return socket;
};

describe("graph event channel", () => {
  it("answers the handshake and resyncs every new connection", () => {
    const hub = createGraphEvents({ pingIntervalMs: 0 });
    const socket = connect(hub);
    const handshake = socket.written[0]?.toString("utf8") ?? "";
    const accept = createHash("sha1")
      .update(`dGhlIHNhbXBsZSBub25jZQ==${websocketGuid}`)
      .digest("base64");
    expect(handshake).toContain("HTTP/1.1 101 Switching Protocols");
    expect(handshake).toContain(`Sec-WebSocket-Accept: ${accept}`);
    expect(hub.connections).toBe(1);

    const frames = serverFrames(socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.opcode).toBe(0x1);
    expect(JSON.parse(frames[0]?.payload.toString("utf8") ?? "")).toEqual({
      type: "resync",
    });
  });

  it("coalesces notifications while a write is in flight", () => {
    const hub = createGraphEvents({ pingIntervalMs: 0 });
    const socket = new FakeSocket();
    socket.holdWrites = true;
    expect(
      hub.handleUpgrade(
        upgradeRequest(),
        socket as unknown as Duplex,
        Buffer.alloc(0),
      ),
    ).toBe(true);

    hub.notify();
    hub.notify();
    hub.notify();
    // The resync write is still in flight, so all three notifications coalesce behind it.
    expect(serverFrames(socket)).toHaveLength(1);

    socket.flush();
    const frames = serverFrames(socket);
    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[0]?.payload.toString("utf8") ?? "")).toEqual({
      type: "resync",
    });
    expect(JSON.parse(frames[1]?.payload.toString("utf8") ?? "")).toEqual({
      type: "graph-changed",
    });
    socket.flush();
    expect(serverFrames(socket)).toHaveLength(2);
  });

  it("disconnects a client whose send buffer is already beyond the bound", () => {
    const hub = createGraphEvents({
      pingIntervalMs: 0,
      maxBufferedBytes: 1_024,
    });
    const socket = connect(hub);
    socket.writableLength = 2_048;

    hub.notify();

    expect(socket.destroyed).toBe(true);
    expect(hub.connections).toBe(0);
    // The notification was never queued behind the slow client.
    expect(serverFrames(socket)).toHaveLength(1);
  });

  it("answers a client close frame and drops the subscription", () => {
    const hub = createGraphEvents({ pingIntervalMs: 0 });
    const socket = connect(hub);
    socket.emit("data", clientFrame(0x8, Buffer.from([0x03, 0xe8])));

    const frames = serverFrames(socket);
    expect(frames.at(-1)?.opcode).toBe(0x8);
    expect(hub.connections).toBe(0);
    // The close frame is answered and the socket ends instead of being reset.
    expect(socket.ended).toBe(true);
  });

  it("ignores data frames and answer pings without notifying anyone", () => {
    const hub = createGraphEvents({ pingIntervalMs: 0 });
    const socket = connect(hub);
    socket.emit("data", clientFrame(0x1, Buffer.from("hello")));
    expect(serverFrames(socket)).toHaveLength(1);

    socket.emit("data", clientFrame(0x9, Buffer.from("ping")));
    const frames = serverFrames(socket);
    expect(frames).toHaveLength(2);
    expect(frames[1]?.opcode).toBe(0xa);
    expect(frames[1]?.payload.toString("utf8")).toBe("ping");
    expect(hub.connections).toBe(1);
  });

  it("claims only its own path and refuses a handshake without a key", () => {
    const hub = createGraphEvents({ pingIntervalMs: 0 });
    const other = new FakeSocket();
    expect(
      hub.handleUpgrade(
        upgradeRequest("/api/graph"),
        other as unknown as Duplex,
        Buffer.alloc(0),
      ),
    ).toBe(false);
    expect(other.written).toHaveLength(0);

    const socket = new FakeSocket();
    const malformed = {
      method: "GET",
      url: graphEventsPath,
      headers: { host: "127.0.0.1:4748", upgrade: "websocket" },
    } as unknown as IncomingMessage;
    expect(
      hub.handleUpgrade(
        malformed,
        socket as unknown as Duplex,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(socket.written[0]?.toString("utf8")).toContain("400 Bad Request");
    expect(hub.connections).toBe(0);
  });

  it("closes every subscription when the channel closes", async () => {
    const hub = createGraphEvents({ pingIntervalMs: 0 });
    const socket = connect(hub);
    await hub.close();

    expect(hub.connections).toBe(0);
    expect(socket.ended).toBe(true);
    const frames = serverFrames(socket);
    expect(frames.at(-1)?.opcode).toBe(0x8);
  });

  it("checks liveness with pings and drops a connection that stopped answering", () => {
    vi.useFakeTimers();
    try {
      const hub = createGraphEvents({ pingIntervalMs: 1_000 });
      const socket = connect(hub);

      vi.advanceTimersByTime(1_000);
      expect(serverFrames(socket).at(-1)?.opcode).toBe(0x9);

      // Any inbound frame counts as liveness; a browser answers the ping automatically.
      socket.emit("data", clientFrame(0xa, Buffer.alloc(0)));
      vi.advanceTimersByTime(1_000);
      expect(hub.connections).toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(hub.connections).toBe(1);

      // Silent past the stale window, the connection is dropped and the browser resyncs later.
      vi.advanceTimersByTime(1_000);
      expect(hub.connections).toBe(0);
      expect(socket.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
