/**
 * The graph poll loop: one request at a time, no overlapping polls, a shorter delay while the host
 * reports a running refresh, and no state change after the loop stopped. The loop itself owns no
 * view, so a failed poll leaves whatever the dashboard last displayed.
 *
 * See docs/dashboard.md#asynchronous-data-updates.
 */

/** The timer operations the loop needs, injectable for deterministic tests. */
export interface PollScheduler {
  setTimeout(handler: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export interface PollLoopOptions {
  /** One poll; failures are reported through `onError` and never clear displayed state. */
  readonly poll: () => Promise<void>;
  /** The delay before the next poll, evaluated after every completed poll. */
  readonly nextDelayMs: () => number;
  readonly scheduler: PollScheduler;
  readonly onError?: (cause: unknown) => void;
}

export interface PollLoop {
  start(): void;
  /** Poll immediately, coalescing with a poll that is already running. */
  triggerNow(): void;
  stop(): void;
}

/** The default scheduler of the browser. */
export const browserScheduler: PollScheduler = {
  setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    window.clearTimeout(handle);
  },
};

export const createPollLoop = (options: PollLoopOptions): PollLoop => {
  let timer: number | undefined;
  let running = false;
  let again = false;
  let stopped = false;

  const schedule = (delayMs: number): void => {
    if (stopped || timer !== undefined) {
      return;
    }
    timer = options.scheduler.setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
  };

  const run = async (): Promise<void> => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      await options.poll();
    } catch (cause) {
      if (!stopped) {
        options.onError?.(cause);
      }
    } finally {
      running = false;
    }
    if (stopped) {
      return;
    }
    if (again) {
      again = false;
      void run();
      return;
    }
    schedule(options.nextDelayMs());
  };

  return {
    start: (): void => {
      if (stopped) {
        return;
      }
      schedule(0);
    },
    triggerNow: (): void => {
      if (stopped) {
        return;
      }
      if (running) {
        again = true;
        return;
      }
      if (timer !== undefined) {
        options.scheduler.clearTimeout(timer);
        timer = undefined;
      }
      schedule(0);
    },
    stop: (): void => {
      stopped = true;
      again = false;
      if (timer !== undefined) {
        options.scheduler.clearTimeout(timer);
        timer = undefined;
      }
    },
  };
};
