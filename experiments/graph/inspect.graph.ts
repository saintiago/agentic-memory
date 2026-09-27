/**
 * The offline graph inspection entry point: render one saved run directory, the deterministic
 * demonstration's or a live run's, into `graph.html` and `graph.json`.
 *
 * Run with `npm run graph:inspect` after exporting `AMEM_GRAPH_RUN_DIR`; `AMEM_GRAPH_OUT_DIR`
 * overrides the default `<run directory>/graph` output directory. A missing run directory or
 * required artifact fails instead of reporting a pass. See experiments/README.md.
 */
import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { renderRunGraph } from "./render.js";

const requiredSetting = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is required: set it to a saved run directory before running npm run graph:inspect.`,
    );
  }
  return value;
};

describe("graph inspection", () => {
  it("renders the offline graph of the requested run directory", async () => {
    const runDirectory = requiredSetting("AMEM_GRAPH_RUN_DIR");
    const outputDirectory = process.env["AMEM_GRAPH_OUT_DIR"];
    const rendered = await renderRunGraph(
      outputDirectory === undefined || outputDirectory.trim() === ""
        ? { runDirectory }
        : { runDirectory, outputDirectory },
    );
    const html = await stat(rendered.htmlPath);
    const json = await stat(rendered.jsonPath);
    expect(html.size).toBeGreaterThan(0);
    expect(json.size).toBeGreaterThan(0);
    console.log(`Graph HTML: ${rendered.htmlPath}`);
    console.log(`Graph JSON: ${rendered.jsonPath}`);
    console.log(
      `Nodes: ${String(rendered.graph.counts.nodes)}, links: ${String(
        rendered.graph.counts.links,
      )}`,
    );
  }, 300_000);
});
