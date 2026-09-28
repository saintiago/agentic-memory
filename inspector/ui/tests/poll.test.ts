/**
 * The poll loop: one request at a time, coalesced triggers, a shorter delay while a refresh runs,
 * failures reported without clearing anything and nothing scheduled after stopping.
 *
 * See docs/dashboard.md#asynchronous-data-updates.
 */
import { describe, expect, it } from "vitest";

import { createPollLoop, type PollScheduler } from "../poll.js";

/** A scheduler whose timers only fire when the test runs them. */
class ManualScheduler implements PollScheduler {
  readonly pending = new Map<
    number,
    { handler: () => void; delayMs: number }
  >();
  #next = 1;

  setTimeout(handler: () => void, delayMs: number): number {
    const handle = this.#next;
    this.#next += 1;
    this.pending.set(handle, { handler, delayMs });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.pending.delete(handle);
  }

  /** Run the earliest scheduled handler and settle its asynchronous work. */
  async runNext(): Promise<void> {
    const entry = this.pending.entries().next();
    if (entry.done === true) {
      throw new Error("No timer is scheduled.");
    }
    const [handle, timer] = entry.value;
    this.pending.delete(handle);
    timer.handler();
    await this.settle();
  }

  async settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve();
    }
  }
}

describe("poll loop", () => {
  it("polls once at start and schedules the next delay afterwards", async () => {
    const scheduler = new ManualScheduler();
    let polls = 0;
    createPollLoop({
      poll: () => {
        polls += 1;
        return Promise.resolve();
      },
      nextDelayMs: () => 2_000,
      scheduler,
    }).start();

    expect(scheduler.pending.size).toBe(1);
    await scheduler.runNext();
    expect(polls).toBe(1);
    expect([...scheduler.pending.values()][0]?.delayMs).toBe(2_000);
  });

  it("never overlaps polls and coalesces triggers made during one", async () => {
    const scheduler = new ManualScheduler();
    let polls = 0;
    let running = 0;
    let maxRunning = 0;
    const releases: Array<() => void> = [];
    const loop = createPollLoop({
      poll: async () => {
        polls += 1;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        running -= 1;
      },
      nextDelayMs: () => 1_000,
      scheduler,
    });
    loop.start();

    const first = scheduler.runNext();
    await Promise.resolve();
    expect(polls).toBe(1);

    // Both triggers during the running poll must coalesce into exactly one more poll.
    loop.triggerNow();
    loop.triggerNow();
    releases[0]?.();
    await first;
    expect(polls).toBe(2);
    expect(maxRunning).toBe(1);

    releases[1]?.();
    await scheduler.settle();
    expect(polls).toBe(2);
    expect(maxRunning).toBe(1);
    expect(scheduler.pending.size).toBe(1);
  });

  it("reports a failure and keeps polling", async () => {
    const scheduler = new ManualScheduler();
    const errors: unknown[] = [];
    let polls = 0;
    createPollLoop({
      poll: () => {
        polls += 1;
        return polls === 1
          ? Promise.reject(new Error("host is down"))
          : Promise.resolve();
      },
      nextDelayMs: () => 500,
      scheduler,
      onError: (cause) => {
        errors.push(cause);
      },
    }).start();

    await scheduler.runNext();
    expect(errors).toHaveLength(1);
    expect(polls).toBe(1);
    expect(scheduler.pending.size).toBe(1);

    await scheduler.runNext();
    expect(polls).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it("stops scheduling and ignores an in-flight poll", async () => {
    const scheduler = new ManualScheduler();
    let release: (() => void) | undefined;
    const errors: unknown[] = [];
    const loop = createPollLoop({
      poll: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      nextDelayMs: () => 1_000,
      scheduler,
      onError: (cause) => {
        errors.push(cause);
      },
    });
    loop.start();
    const running = scheduler.runNext();
    await Promise.resolve();

    loop.stop();
    release?.();
    await running;

    expect(scheduler.pending.size).toBe(0);
    loop.triggerNow();
    expect(scheduler.pending.size).toBe(0);
    expect(errors).toEqual([]);
  });
});
