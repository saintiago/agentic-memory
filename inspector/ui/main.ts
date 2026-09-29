/**
 * Browser entry point of the Sigma memory dashboard: it composes the host client, the graph view
 * differ, the Graphology model, the same-origin event subscription and the Sigma renderer into one
 * dashboard, keeps the served view in sync with the host's notifications and exposes the read-only
 * diagnostics the responsiveness check records.
 *
 * See docs/dashboard.md and inspector/README.md.
 */
import { createInspectorClient } from "./client.js";
import { createDashboard, type Dashboard } from "./dashboard.js";
import { createEventStream } from "./events.js";
import { createSigmaRenderer } from "./renderer.js";
import { createViewDiffer } from "./view-diff.js";

/** The read-only hook the responsive scale check reads from the page. */
export interface InspectorPageHook {
  diagnostics(): ReturnType<Dashboard["diagnostics"]>;
  display(nodeIds: readonly string[]): ReturnType<Dashboard["display"]>;
  cameraState(): ReturnType<Dashboard["cameraState"]>;
  viewportPosition(nodeId: string): ReturnType<Dashboard["viewportPosition"]>;
  pollNow(): void;
}

const root = document.getElementById("app");
if (root === null) {
  throw new Error("The inspection page needs an #app root element.");
}

const dashboard = createDashboard({
  root,
  client: createInspectorClient(),
  differ: createViewDiffer(),
  createRenderer: createSigmaRenderer,
  events: (handlers) => createEventStream({ handlers }),
});

const hook: InspectorPageHook = {
  diagnostics: () => dashboard.diagnostics(),
  display: (nodeIds) => dashboard.display(nodeIds),
  cameraState: () => dashboard.cameraState(),
  viewportPosition: (nodeId) => dashboard.viewportPosition(nodeId),
  pollNow: () => {
    dashboard.pollNow();
  },
};

(window as unknown as { __amemInspector: InspectorPageHook }).__amemInspector =
  hook;

// A hidden tab may miss several polls; catch up as soon as it is visible again.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    dashboard.pollNow();
  }
});

window.addEventListener("pagehide", () => {
  dashboard.dispose();
});
