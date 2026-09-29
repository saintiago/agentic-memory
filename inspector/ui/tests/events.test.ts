/**
 * The browser notification stream in isolation with a scripted socket and clock:
 * subscribe before the first fetch, resync on connect and reconnect, bounded
 * exponential backoff between attempts and a closed channel after stop. No server
 * or DOM node is involved.
 *
 * See docs/dashboard.md#websocket-updates.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createEventStream, defaultEventsUrl } from "../events.js";
import { FakeSocket, ManualScheduler } from "./support.js";

interface Harness {
  readonly sockets: FakeSocket[];
  readonly scheduler: ManualScheduler;
  resyncs: number;
  readonly states: string[];
  stream: ReturnType<typeof createEventStream>;
}

const start = (
  options: {
    readonly backoffMinMs?: number;
    readonly backoffMaxMs?: number;
  } = {},
): Harness => {
  const sockets: FakeSocket[] = [];
  const scheduler = new ManualScheduler();
  const harness: Harness = {
    sockets,
    scheduler,
    resyncs: 0,
    states: [],
    stream: undefined as unknown as ReturnType<typeof createEventStream>,
  };
  harness.stream = createEventStream({
    handlers: {
      onResync: () => {
        harness.resyncs += 1;
      },
      onStatus: (status) => {
        harness.states.push(status);
      },
    },
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduler,
    ...(options.backoffMinMs === undefined
      ? {}
      : { backoffMinMs: options.backoffMinMs }),
    ...(options.backoffMaxMs === undefined
      ? {}
      : { backoffMaxMs: options.backoffMaxMs }),
  });
  harness.stream.start();
  return harness;
};

describe("dashboard event stream", () => {
  it("subscribes once, resyncs on open and follows graph-changed notifications", () => {
    const harness = start();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.resyncs).toBe(0);

    const socket = harness.sockets[0];
    socket?.open();
    expect(harness.states).toEqual(["connected"]);
    expect(harness.resyncs).toBe(1);

    socket?.message({ type: "graph-changed" });
    socket?.message({ type: "resync" });
    expect(harness.resyncs).toBe(3);

    // Unknown or malformed payloads cannot clear the view or throw.
    socket?.message({ type: "something-else" });
    socket?.raw("not json");
    expect(harness.resyncs).toBe(3);
    expect(harness.sockets).toHaveLength(1);
  });

  it("reconnects with bounded exponential backoff and resyncs after every reconnect", () => {
    const harness = start({ backoffMinMs: 1_000, backoffMaxMs: 4_000 });
    harness.sockets[0]?.open();
    expect(harness.resyncs).toBe(1);

    harness.sockets[0]?.drop();
    expect(harness.states).toEqual(["connected", "reconnecting"]);
    expect(harness.scheduler.nextDelayMs).toBe(1_000);
    harness.scheduler.advance(999);
    expect(harness.sockets).toHaveLength(1);
    harness.scheduler.advance(1);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.resyncs).toBe(1);

    // A reconnect that never opens backs off again: 2s, then the 4s cap.
    harness.sockets[1]?.drop();
    expect(harness.scheduler.nextDelayMs).toBe(2_000);
    harness.scheduler.advance(2_000);
    expect(harness.sockets).toHaveLength(3);
    harness.sockets[2]?.drop();
    expect(harness.scheduler.nextDelayMs).toBe(4_000);
    harness.scheduler.advance(4_000);
    expect(harness.sockets).toHaveLength(4);

    // A successful open resets the backoff and resyncs the reconnected browser.
    harness.sockets[3]?.open();
    expect(harness.resyncs).toBe(2);
    expect(harness.states.at(-1)).toBe("connected");
    harness.sockets[3]?.drop();
    expect(harness.scheduler.nextDelayMs).toBe(1_000);
  });

  it("closes the socket and stops reconnecting after stop", () => {
    const harness = start();
    const socket = harness.sockets[0];
    socket?.open();
    harness.stream.stop();

    expect(socket?.closed).toBe(true);
    socket?.drop();
    expect(harness.scheduler.nextDelayMs).toBeUndefined();
    expect(harness.sockets).toHaveLength(1);
  });

  it("derives the same-origin channel URL from the serving page", () => {
    expect(defaultEventsUrl()).toBe("ws://localhost:3000/api/events");
  });
});
