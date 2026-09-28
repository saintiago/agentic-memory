/**
 * Entry point of the local memory inspection host: read the explicit host settings, open the
 * public read stack, start the loopback HTTP server, begin the paginated export and projection
 * lifecycle and stop everything on SIGINT or SIGTERM.
 *
 * Run it with `npm run inspector` from the repository root; see inspector/README.md and
 * docs/dashboard.md#local-inspection-host.
 */
import { createProjectionArtifactStore } from "./artifacts.js";
import { openInspectionMemory } from "./composition.js";
import { createThreadProjectionRunner } from "./projection-runner.js";
import { startInspectionServer } from "./server.js";
import { InspectionSession } from "./session.js";
import { readInspectionSettings } from "./settings.js";

const start = async (): Promise<void> => {
  // Every setting is read and validated before an encoder download, a collection request or any
  // other provider work.
  const settings = readInspectionSettings(process.env);
  const { embedder, store, memory } = await openInspectionMemory(settings);
  const session = new InspectionSession({
    collection: settings.qdrant.collection,
    embeddingSpaceId: embedder.space.id,
    store,
    runner: createThreadProjectionRunner(),
    artifacts: createProjectionArtifactStore(settings.artifactsDirectory),
    pollIntervalMs: settings.pollIntervalMs,
  });
  try {
    const server = await startInspectionServer({
      reads: memory,
      session,
      uiDirectory: settings.uiDirectory,
      port: settings.port,
    });
    session.start();
    console.log(
      `Memory inspection host for collection "${settings.qdrant.collection}" listening on ` +
        `http://127.0.0.1:${String(server.port)}/`,
    );
    console.log(
      `Projection artifacts stay under "${settings.artifactsDirectory}"; the UI is served from ` +
        `"${settings.uiDirectory}".`,
    );
    console.log(
      `Query embeddings use embedding space ${embedder.space.id} ` +
        `(${String(embedder.space.dimensions)} dimensions); queries are embedded locally and no ` +
        `language model is invoked.`,
    );
    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (closing) {
        return;
      }
      closing = true;
      console.log(`Stopping the memory inspection host (${signal}).`);
      await server.close();
      await session.stop();
    };
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } catch (cause) {
    await session.stop();
    throw cause;
  }
};

await start().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`The memory inspection host could not start: ${message}`);
  process.exitCode = 1;
});
