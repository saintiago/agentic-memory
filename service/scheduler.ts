/**
 * Bounded, fair admission of inference work. The service shares one encoder between ingestion and
 * search; this scheduler serializes model access, admits waiting operations in first-come order so
 * ingestion cannot indefinitely starve search, and refuses work beyond a bounded wait queue
 * instead of accumulating unbounded in-memory tasks.
 *
 * See docs/service.md#async-work-and-resource-sharing.
 */

/** The bounded wait queue is full, so the caller should retry later. */
export class InferenceOverloadedError extends Error {
  /** How long the caller should wait before retrying, in milliseconds. */
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("The inference queue is full.");
    this.name = "InferenceOverloadedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface FairSchedulerOptions {
  /** How many operations may run at once; the encoder is serialized, so one by default. */
  readonly limit?: number;
  /** How many operations may wait for a slot before the service reports overload. */
  readonly queueLimit?: number;
  /** The retry delay reported to an overloaded caller. */
  readonly retryAfterMs?: number;
}

interface Waiter {
  readonly run: () => void;
}

const defaultLimit = 1;
const defaultQueueLimit = 32;
const defaultRetryAfterMs = 1_000;

/**
 * One fair admission queue. Running tasks are counted separately from waiting tasks, so the bound
 * applies to the work the service holds in memory, not to the operations already executing.
 */
export class FairScheduler {
  readonly #limit: number;
  readonly #queueLimit: number;
  readonly #retryAfterMs: number;
  #running = 0;
  #waiting: Waiter[] = [];

  constructor(options: FairSchedulerOptions = {}) {
    this.#limit = options.limit ?? defaultLimit;
    this.#queueLimit = options.queueLimit ?? defaultQueueLimit;
    this.#retryAfterMs = options.retryAfterMs ?? defaultRetryAfterMs;
    if (
      !Number.isSafeInteger(this.#limit) ||
      this.#limit <= 0 ||
      !Number.isSafeInteger(this.#queueLimit) ||
      this.#queueLimit < 0
    ) {
      throw new Error("The scheduler bounds must be safe integers.");
    }
  }

  /** How many operations currently execute. */
  get running(): number {
    return this.#running;
  }

  /** How many admitted operations wait for a slot. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /**
   * Run one operation when a slot is free, in arrival order. An operation beyond the wait-queue
   * bound is rejected immediately instead of being held.
   */
  run<Value>(task: () => Promise<Value>): Promise<Value> {
    if (this.#running < this.#limit) {
      return this.#start(task);
    }
    if (this.#waiting.length >= this.#queueLimit) {
      return Promise.reject(new InferenceOverloadedError(this.#retryAfterMs));
    }
    return new Promise<Value>((resolve, reject) => {
      this.#waiting.push({
        run: () => {
          void this.#start(task).then(resolve, reject);
        },
      });
    });
  }

  /** Start one operation and hand the freed slot to the oldest waiter when it settles. */
  #start<Value>(task: () => Promise<Value>): Promise<Value> {
    this.#running += 1;
    return Promise.resolve()
      .then(task)
      .finally(() => {
        this.#running -= 1;
        const next = this.#waiting.shift();
        next?.run();
      });
  }
}
