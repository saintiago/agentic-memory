/** Real public read stack and host lifecycle against the test's held loopback provider. */
import { AgenticMemory, openQdrantNoteStore } from "../../../src/index.js";
import { createThreadProjectionRunner } from "../../../inspector/projection-runner.js";
import { startInspectionServer } from "../../../inspector/server.js";
import { InspectionSession } from "../../../inspector/session.js";
import { installShutdownHandlers } from "../../../inspector/shutdown.js";

const space = {
  id: "shutdown-test",
  dimensions: 4,
  distance: "Cosine" as const,
};
const store = await openQdrantNoteStore({
  url: process.argv[2]!,
  collection: "notes",
  space,
  timeoutMs: 30_000,
});
const memory = new AgenticMemory(
  store,
  {
    space,
    async embed() {
      return [1, 0, 0, 0];
    },
  },
  {
    async generate() {
      throw new Error("Generation is forbidden.");
    },
  },
);
const session = new InspectionSession({
  collection: "notes",
  embeddingSpaceId: space.id,
  store,
  runner: createThreadProjectionRunner(),
  artifacts: {
    async load() {
      return undefined;
    },
    async save() {},
  },
  pollIntervalMs: 0,
});
const server = await startInspectionServer({
  reads: memory,
  session,
  uiDirectory: "inspector/ui",
  port: 0,
});
installShutdownHandlers(session, server);
session.start();
process.send?.({ port: server.port });
