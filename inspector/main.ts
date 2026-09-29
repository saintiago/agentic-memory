/**
 * Entry point of the local memory inspection host: read the explicit host settings, open the
 * service-backed read surface, start the loopback HTTP server, begin the paginated export and
 * projection lifecycle and stop everything on SIGINT or SIGTERM.
 *
 * Run it with `npm run inspector` from the repository root; see inspector/README.md and
 * docs/dashboard.md#local-inspection-host.
 */
import { createProjectionArtifactStore } from "./artifacts.js";
import { openInspectionSource } from "./composition.js";
import { createThreadProjectionRunner } from "./projection-runner.js";
import { startInspectionServer } from "./server.js";
import { installShutdownHandlers } from "./shutdown.js";
import { InspectionSession } from "./session.js";
import { readInspectionSettings } from "./settings.js";

const start = async (): Promise<void> => {
  // Every setting is read and validated before the service is contacted or a local file is read.
  const settings = readInspectionSettings(process.env);
  const source = openInspectionSource(settings);
  const session = new InspectionSession({
    source,
    runner: createThreadProjectionRunner(),
    artifacts: createProjectionArtifactStore(settings.artifactsDirectory),
    pollIntervalMs: settings.pollIntervalMs,
  });
  try {
    const server = await startInspectionServer({
      reads: source,
      session,
      uiDirectory: settings.uiDirectory,
      port: settings.port,
    });
    session.start();
    console.log(
      `Memory inspection host for the service at "${settings.service.url}" listening on ` +
        `http://127.0.0.1:${String(server.port)}/`,
    );
    console.log(
      `Projection artifacts stay under "${settings.artifactsDirectory}"; the UI is served from ` +
        `"${settings.uiDirectory}".`,
    );
    console.log(
      "Note details, search and stored vectors come from the memory service; the host " +
        "loads no encoder and opens no database.",
    );
    installShutdownHandlers(session, server);
  } catch (cause) {
    await session.stop();
    throw cause;
  }
};

await start().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`The memory inspection host could not start: ${message}`);
  // The host owns no provider resources; exiting releases any outstanding client requests.
  process.exit(1);
});
