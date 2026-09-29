/**
 * The browser side of the same-origin `/api/events` notification channel: subscribe before the
 * first fetch, resync on every connection, and reconnect with bounded exponential backoff while
 * the last completed view stays displayed. The channel only signals change; `GET /api/graph`
 * remains the authoritative snapshot.
 *
 * See docs/dashboard.md#websocket-updates.
 */
import { browserScheduler, type TimerScheduler } from "./timer.js";

/** The notification the service sends on connect: fetch the latest graph state. */
export interface GraphEventHandlers {
  /** A notification arrived, or a connection opened: fetch the latest served graph. */
  onResync(): void;
  /** The connection state for the reconnecting indication; omitted when the caller ignores it. */
  onStatus?(status: "connected" | "reconnecting"): void;
}

/** A running subscription. */
export interface GraphEventStream {
  start(): void;
  stop(): void;
}

/** The WebSocket operations the stream needs; the browser socket satisfies the default. */
export interface EventSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface GraphEventStreamOptions {
  readonly handlers: GraphEventHandlers;
  /** The channel URL; the same-origin `/api/events` by default. */
  readonly url?: string;
  /** A socket factory, injectable for deterministic tests. */
  readonly connect?: (url: string) => EventSocket;
  readonly scheduler?: TimerScheduler;
  /** The first reconnect delay; the default is 1 second. */
  readonly backoffMinMs?: number;
  /** The longest reconnect delay; the default is 30 seconds. */
  readonly backoffMaxMs?: number;
}

/** The same-origin channel URL of the serving host. */
export const defaultEventsUrl = (): string =>
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/events`;

/** The browser socket behind the small injectable surface. */
const openSocket = (url: string): EventSocket => {
  const socket = new WebSocket(url);
  const adapter: EventSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: () => {
      socket.close();
    },
  };
  socket.onopen = () => {
    adapter.onopen?.();
  };
  socket.onmessage = (event: MessageEvent) => {
    adapter.onmessage?.({ data: event.data as unknown });
  };
  socket.onclose = () => {
    adapter.onclose?.();
  };
  socket.onerror = () => {
    adapter.onerror?.();
  };
  return adapter;
};

/**
 * Create the reconnecting notification stream. A closed socket is retried with bounded
 * exponential backoff (`1s` to `30s` by default) until the stream is stopped; every connection
 * resyncs, so a missed notification is recovered by the next fetch.
 */
export const createEventStream = (
  options: GraphEventStreamOptions,
): GraphEventStream => {
  const scheduler = options.scheduler ?? browserScheduler;
  const connect = options.connect ?? openSocket;
  const backoffMinMs = options.backoffMinMs ?? 1_000;
  const backoffMaxMs = options.backoffMaxMs ?? 30_000;
  let stopped = false;
  let attempt = 0;
  let timer: number | undefined;
  let current: EventSocket | undefined;

  const scheduleReconnect = (): void => {
    options.handlers.onStatus?.("reconnecting");
    const delay = Math.min(backoffMaxMs, backoffMinMs * 2 ** attempt);
    attempt += 1;
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      open();
    }, delay);
  };

  const open = (): void => {
    if (stopped) {
      return;
    }
    const socket = connect(options.url ?? defaultEventsUrl());
    current = socket;
    socket.onopen = () => {
      if (stopped || current !== socket) {
        return;
      }
      attempt = 0;
      options.handlers.onStatus?.("connected");
      options.handlers.onResync();
    };
    socket.onmessage = (event) => {
      if (stopped || current !== socket) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data)) as unknown;
      } catch {
        return;
      }
      const type = (parsed as { type?: unknown }).type;
      if (type === "resync" || type === "graph-changed") {
        options.handlers.onResync();
      }
    };
    socket.onclose = () => {
      if (stopped || current !== socket) {
        return;
      }
      current = undefined;
      scheduleReconnect();
    };
    // The close event that follows an error drives the reconnect; nothing is done here.
    socket.onerror = () => undefined;
  };

  return {
    start: (): void => {
      stopped = false;
      attempt = 0;
      open();
    },
    stop: (): void => {
      stopped = true;
      if (timer !== undefined) {
        scheduler.clearTimeout(timer);
        timer = undefined;
      }
      const socket = current;
      current = undefined;
      socket?.close();
    },
  };
};
