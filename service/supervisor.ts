/**
 * Supervision of the durable queue worker inside the service process. The queue owns drain order,
 * retry and recovery; this loop only notices that the worker stopped (for example after a journal
 * failure released ownership) and starts it again with a bounded retry delay, so accepted work
 * resumes without a new agent handoff.
 *
 * See docs/service.md#availability-restart-and-shutdown.
 */

/** The queue operations the supervisor needs; its state stays owned by the queue. */
export interface SupervisedWorker {
  start(): Promise<void>;
  status(): Promise<{ readonly worker: "running" | "stopped" }>;
}

export interface WorkerSupervisorOptions {
  readonly worker: SupervisedWorker;
  /** How often a running worker is checked; a stopped worker is restarted promptly. */
  readonly intervalMs?: number;
  /** How long to wait after a failed restart attempt before trying again. */
  readonly retryMs?: number;
  readonly onFailure?: (cause: unknown) => void;
}

const defaultIntervalMs = 5_000;
const defaultRetryMs = 5_000;

/** One process's restart loop for the ingestion worker. */
export class WorkerSupervisor {
  readonly #worker: SupervisedWorker;
  readonly #intervalMs: number;
  readonly #retryMs: number;
  readonly #onFailure: (cause: unknown) => void;
  #timer: NodeJS.Timeout | undefined;
  #current: Promise<void> | undefined;
  #stopped = false;

  constructor(options: WorkerSupervisorOptions) {
    this.#worker = options.worker;
    this.#intervalMs = options.intervalMs ?? defaultIntervalMs;
    this.#retryMs = options.retryMs ?? defaultRetryMs;
    this.#onFailure =
      options.onFailure ??
      ((cause: unknown) => {
        console.error("[service] the ingestion worker restart failed:", cause);
      });
  }

  /** Begin checking the worker immediately. */
  start(): void {
    this.#schedule(0);
  }

  /** Stop the loop and let an in-flight check settle. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#current;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped || this.#timer !== undefined) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#current = this.#check().finally(() => {
        this.#current = undefined;
      });
    }, delayMs);
    this.#timer.unref();
  }

  /** One check: restart a stopped worker and schedule the next check. */
  async #check(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    let delayMs = this.#intervalMs;
    try {
      const status = await this.#worker.status();
      if (status.worker === "stopped") {
        await this.#worker.start();
      }
    } catch (cause) {
      this.#onFailure(cause);
      delayMs = this.#retryMs;
    }
    this.#schedule(delayMs);
  }
}
