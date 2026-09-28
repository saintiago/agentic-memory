/** Shutdown of the standalone host process, which owns all provider resources. */
import type { InspectionServer } from "./server.js";
import type { InspectionSession } from "./session.js";

export const installShutdownHandlers = (
  session: InspectionSession,
  server: InspectionServer,
): void => {
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`Stopping the memory inspection host (${signal}).`);
    try {
      // Cancel jobs and disconnect HTTP clients together; neither waits for provider reads.
      await Promise.all([session.stop(), server.close()]);
    } catch (cause) {
      console.error(
        "The memory inspection host could not close cleanly:",
        cause,
      );
      process.exit(1);
    }
    // NoteStore and Embedder have no public disposal/cancellation API. Terminating this dedicated
    // process releases their sockets, SDK timeout timers and native encoder resources, including
    // a stalled export, detail read or search. Merely setting exitCode would leave those alive.
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
};
