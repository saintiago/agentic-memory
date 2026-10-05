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

/**
 * The exclusive operations of one queue. Only `worker` means the ingestion worker runs; every
 * other purpose still excludes a second owner and is reported as itself to ownership probes.
 */
export type WorkerLockPurpose =
  "worker" | "migration" | "upgrade" | "correction";

/** One worker's exclusive ownership of a queue; released on the owning process's exit. */
export class WorkerLock {
  readonly #server: Server;

  private constructor(server: Server) {
    this.#server = server;
  }

  static acquire(
    journalPath: string,
    purpose: WorkerLockPurpose = "worker",
  ): Promise<WorkerLock> {
    // Probes never acquire ownership. Report its purpose so migration does not look like a
    // running worker. A disconnected probe cannot disrupt ownership.
    const server = createServer((socket: Socket) => {
      socket.on("error", () => socket.destroy());
      socket.end(purpose);
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
   * Whether a worker (rather than an import) owns the journal, so any handle can report shared
   * availability. The probe connects to the ownership binding instead of taking it, so it can
   * never create, steal or disturb ownership.
   */
  static isWorkerRunning(journalPath: string): Promise<boolean> {
    return WorkerLock.ownerPurpose(journalPath).then(
      (purpose) => purpose === "worker",
    );
  }

  /**
   * The purpose the current owner of the queue reported, or `undefined` when no owner holds it.
   * The probe connects to the ownership binding instead of taking it, so it can never create,
   * steal or disturb ownership.
   */
  static ownerPurpose(journalPath: string): Promise<string | undefined> {
    const socket = connect({ path: lockName(journalPath) });
    return new Promise<string | undefined>((resolve, reject) => {
      let purpose = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        purpose += chunk;
      });
      socket.once("end", () => {
        socket.destroy();
        resolve(purpose);
      });
      socket.once("error", (cause: NodeJS.ErrnoException) => {
        socket.destroy();
        // A refused connection means no owner listens; a reset means the owner released the
        // binding while this probe was connecting. Neither may surface as a probe failure.
        if (cause.code === "ECONNREFUSED" || cause.code === "ECONNRESET") {
          resolve(undefined);
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
