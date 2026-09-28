/**
 * Process-scoped ownership of one queue's ingestion worker. The lock is an exclusive binding of an
 * OS-namespaced abstract socket, which the kernel releases when the owning process exits, including
 * after a crash. There is no lease, heartbeat or stale-lock takeover.
 *
 * See docs/ingestion-queue.md#writer-lifecycle-and-retries.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import path from "node:path";

import { QueueWorkerLockedError } from "./errors.js";

/** The abstract-socket name one journal path owns for the lifetime of its worker. */
const lockName = (journalPath: string): string =>
  `\0amem-ingestion-queue:${createHash("sha256")
    .update(path.resolve(journalPath))
    .digest("hex")}`;

/** One worker's exclusive ownership of a queue; released on the owning process's exit. */
export class WorkerLock {
  readonly #server: Server;

  private constructor(server: Server) {
    this.#server = server;
  }

  static acquire(journalPath: string): Promise<WorkerLock> {
    const server = createServer();
    return new Promise<WorkerLock>((resolve, reject) => {
      const onError = (cause: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        reject(
          cause.code === "EADDRINUSE"
            ? new QueueWorkerLockedError(journalPath)
            : cause,
        );
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve(new WorkerLock(server));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(lockName(journalPath));
    });
  }

  release(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#server.close((cause) => {
        if (cause === undefined) {
          resolve();
          return;
        }
        reject(cause);
      });
    });
  }
}
