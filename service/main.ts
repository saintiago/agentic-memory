/**
 * Entry point of the local memory service: read the explicit host settings, open the durable
 * queue and take worker ownership, start the loopback `/v1` API independently of provider
 * initialization and stop everything on SIGINT or SIGTERM.
 *
 * Run it with `npm run service` from the repository root; see service/README.md and
 * docs/service.md.
 */
import { startMemoryService } from "./lifecycle.js";
import { readServiceSettings } from "./settings.js";
import { installServiceShutdownHandlers } from "./shutdown.js";

const start = async (): Promise<void> => {
  // Every setting is validated before the journal, the listener or a provider is touched.
  const settings = readServiceSettings(process.env);
  const runtime = await startMemoryService({ settings });
  // Install signal handling before announcing readiness, so a supervisor that stops the service
  // as soon as it sees the listening line still gets the graceful path.
  installServiceShutdownHandlers(runtime, settings.shutdownGraceMs);
  console.log(
    `Memory service for collection "${settings.qdrant.collection}" listening on ` +
      `http://127.0.0.1:${String(runtime.port)}/ with its queue at ` +
      `"${settings.dataDirectory}".`,
  );
  console.log(
    "Submissions are durable as soon as the API answers; retrieval and ingestion report " +
      "their availability through GET /v1/status.",
  );
};

await start().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`The memory service could not start: ${message}`);
  process.exit(1);
});
