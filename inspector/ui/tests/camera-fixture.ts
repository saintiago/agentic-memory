/** Real Sigma fixture bundled only by the browser regression; no production diagnostic hooks. */
import { GraphModel } from "../graph-model.js";
import { createSigmaRenderer, type DashboardRenderer } from "../renderer.js";
import { SearchResults } from "../results.js";

let renderer: DashboardRenderer | undefined;
let model: GraphModel;
const id = "abcdef01-0000-4000-8000-000000000001";

const fixture = {
  reset(): void {
    renderer?.dispose();
    const container = document.getElementById("stage");
    if (container === null) throw new Error("Missing stage");
    model = new GraphModel({ results: new SearchResults() });
    model.graph.addNode(id, { x: -10, y: -10, label: "A" });
    model.graph.addNode("b", { x: 10, y: 10, label: "B" });
    renderer = createSigmaRenderer({
      container,
      graph: model.graph,
      style: model,
      onSelect: () => undefined,
    });
    renderer.includeBounds({ x: [-10, 10], y: [-10, 10] });
    renderer.fitAll();
  },
  grow(): void {
    model.graph.addNode("outlier", { x: 100, y: 0, label: "Outlier" });
    renderer?.includeBounds({ x: [-10, 100], y: [-10, 10] });
  },
  position(): { x: number; y: number } | undefined {
    return renderer?.viewportPosition(id);
  },
  focus(): void {
    renderer?.focus(id.toUpperCase());
  },
  fitResults(): void {
    renderer?.fitNodes([id.toUpperCase(), "outlier"]);
  },
  positionUpper(): { x: number; y: number } | undefined {
    return renderer?.viewportPosition(id.toUpperCase());
  },
  fit(): void {
    renderer?.fitAll();
  },
  outlier(): { x: number; y: number } | undefined {
    return renderer?.viewportPosition("outlier");
  },
};
(globalThis as unknown as { cameraFixture: typeof fixture }).cameraFixture =
  fixture;
