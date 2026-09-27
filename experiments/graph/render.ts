/**
 * Render one saved run directory into its offline inspection artifacts: `graph.html` and the
 * `graph.json` that reproduces the evidence the page shows. The run's own artifacts are read only
 * and never rewritten.
 *
 * See docs/evaluation.md#graph-inspection.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildInspectionGraph, type InspectionGraph } from "./document.js";
import { renderGraphHtml } from "./html.js";
import { readRunGraphArtifacts } from "./run-directory.js";

/** One rendered graph and where its two files went. */
export interface RenderedGraph {
  runDirectory: string;
  outputDirectory: string;
  jsonPath: string;
  htmlPath: string;
  graph: InspectionGraph;
}

/** The default output location: a `graph` subdirectory of the run directory it describes. */
export const defaultGraphDirectory = (runDirectory: string): string =>
  path.join(runDirectory, "graph");

/** Build and write the inspection graph of one saved run directory. */
export const renderRunGraph = async (options: {
  runDirectory: string;
  /** Where the two output files go; defaults to `<runDirectory>/graph`. */
  outputDirectory?: string;
}): Promise<RenderedGraph> => {
  const graph = buildInspectionGraph(
    await readRunGraphArtifacts(options.runDirectory),
  );
  const outputDirectory =
    options.outputDirectory ?? defaultGraphDirectory(options.runDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, "graph.json");
  const htmlPath = path.join(outputDirectory, "graph.html");
  await writeFile(jsonPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  await writeFile(htmlPath, renderGraphHtml(graph), "utf8");
  return {
    runDirectory: options.runDirectory,
    outputDirectory,
    jsonPath,
    htmlPath,
    graph,
  };
};
