#!/usr/bin/env node
/**
 * Build the browser bundle of the Sigma inspection dashboard: one entry module and the parsing
 * worker, with the pinned browser dependencies (Sigma v3, Graphology, Zod) bundled from the locked
 * installation. The output is a build artifact of `inspector/ui` and is never edited by hand;
 * `npm run inspector` and `npm run validate` both build it.
 *
 * See docs/dashboard.md#tools-and-ownership.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(repositoryRoot, "inspector/ui/build");

// Remove stale bundles so the served directory only contains this build.
await rm(outputDirectory, { recursive: true, force: true });
const result = await build({
  entryPoints: {
    app: path.join(repositoryRoot, "inspector/ui/main.ts"),
    "view-worker": path.join(repositoryRoot, "inspector/ui/view-worker.ts"),
  },
  outdir: outputDirectory,
  chunkNames: "chunk-[hash]",
  assetNames: "asset-[hash]",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: true,
  logLevel: "warning",
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs)
  .map(
    ([file, output]) =>
      `${path.relative(repositoryRoot, file)} (${String(output.bytes)} bytes)`,
  )
  .sort();
console.log(
  `Built the inspection dashboard bundle:\n  ${outputs.join("\n  ")}`,
);
