/**
 * The browser timer operations the dashboard uses for freshness redraws and bounded sync
 * retries. Tests inject a deterministic scheduler instead of the page's own timers.
 *
 * See docs/dashboard.md#websocket-updates.
 */

export interface TimerScheduler {
  setTimeout(handler: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

/** The default scheduler of the browser. */
export const browserScheduler: TimerScheduler = {
  setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    window.clearTimeout(handle);
  },
};
