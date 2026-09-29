/** Real host lifecycle against the test's held loopback memory service. */
import { createThreadProjectionRunner } from "../../../inspector/projection-runner.js";
import { openServiceInspectionSource } from "../../../inspector/service-source.js";
import { startInspectionServer } from "../../../inspector/server.js";
import { InspectionSession } from "../../../inspector/session.js";
import { installShutdownHandlers } from "../../../inspector/shutdown.js";

const source = openServiceInspectionSource({
  url: process.argv[2]!,
  timeoutMs: 30_000,
});
const session = new InspectionSession({
  source,
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
  reads: source,
  session,
  uiDirectory: "inspector/ui",
  port: 0,
});
installShutdownHandlers(session, server);
session.start();
process.send?.({ port: server.port });
