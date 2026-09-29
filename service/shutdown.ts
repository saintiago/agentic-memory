/** Signal handling of the standalone service process, which owns every provider resource. */
import type { MemoryServiceRuntime } from "./lifecycle.js";

/**
 * Stop the service on SIGINT or SIGTERM within the host's shutdown grace period. A forced exit
 * relies on the durable journal: accepted work stays durable and no interrupted write is ever
 * marked stored, so the next start recovers it.
 */
export const installServiceShutdownHandlers = (
  runtime: MemoryServiceRuntime,
  graceMs: number,
): void => {
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    console.log(`Stopping the memory service (${signal}).`);
    const forced = setTimeout(() => {
      console.error(
        `The memory service did not stop within ${String(graceMs)} ms; the durable journal ` +
          "holds accepted work for recovery.",
      );
      process.exit(1);
    }, graceMs);
    forced.unref();
    try {
      await runtime.stop();
    } catch (cause) {
      console.error("The memory service could not close cleanly:", cause);
      process.exit(1);
    }
    clearTimeout(forced);
    // The encoder and provider SDKs expose no disposal API; exiting this dedicated process
    // releases them after the journal is closed.
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
};
