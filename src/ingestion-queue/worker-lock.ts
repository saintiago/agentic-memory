/**
 * Process-scoped ownership of one queue's ingestion worker. The lock is an exclusive binding of an
 * OS-namespaced abstract socket named after the journal file's canonical path, so every handle that
 * names that file — directly or through a filesystem alias — competes for the same lock. The kernel
 * releases the binding when the owning process exits, including after a crash. There is no lease,
 * heartbeat or stale-lock takeover.
 *
 * See docs/ingestion-queue.md#writer-lifecycle-and-retries.
 */
import { createHash } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";

import { QueueWorkerLockedError } from "./errors.js";
import { canonicalJournalPath } from "./journal-path.js";

/** The abstract-socket name one journal file owns for the lifetime of its worker. */
const lockName = (journalPath: string): string =>
  `\0amem-ingestion-queue:${createHash("sha256")
    .update(canonicalJournalPath(journalPath))
    .digest("hex")}`;

/** One worker's exclusive ownership of a queue; released on the owning process's exit. */
export class WorkerLock {
  readonly #server: Server;

  private constructor(server: Server) {
    this.#server = server;
  }

  static acquire(journalPath: string): Promise<WorkerLock> {
    // Ownership probes connect to the lock, so the owner accepts and releases each probe without
    // treating it as work.
    const server = createServer((socket: Socket) => {
      socket.destroy();
    });
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

  /**
   * Whether any process currently owns this journal's worker, so any handle can report shared
   * availability. The probe connects to the ownership binding instead of taking it, so it can
   * never create, steal or disturb ownership.
   */
  static isHeld(journalPath: string): Promise<boolean> {
    const socket = connect({ path: lockName(journalPath) });
    return new Promise<boolean>((resolve, reject) => {
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", (cause: NodeJS.ErrnoException) => {
        socket.destroy();
        if (cause.code === "ECONNREFUSED") {
          resolve(false);
          return;
        }
        reject(cause);
      });
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
