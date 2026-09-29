#!/usr/bin/env node
/**
 * Build the served Sigma inspection dashboard: the entry page, its stylesheet, the browser bundle
 * of one entry module and the parsing worker, with the pinned browser dependencies (Sigma v3,
 * Graphology, Zod) bundled from the locked installation. The output directory is a build artifact
 * of `inspector/ui` and is never edited by hand; `npm run service`, `npm run inspector` and
 * `npm run validate` all build it.
 *
 * See docs/dashboard.md#tools-and-ownership.
 */
import { build } from "esbuild";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceDirectory = path.join(repositoryRoot, "inspector/ui");
const outputDirectory = path.join(sourceDirectory, "build");
/** The bundle reference the source entry page carries; the served copy points next to itself. */
const sourceEntryReference = "./build/app.js";

// Remove stale files so the served directory only contains this build.
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

// The served directory is complete: the service serves its `AMEM_SERVICE_UI_DIR` at `/`, so the
// entry page and its stylesheet live next to the bundle instead of in the source directory.
const sourceHtml = await readFile(
  path.join(sourceDirectory, "index.html"),
  "utf8",
);
if (!sourceHtml.includes(sourceEntryReference)) {
  throw new Error(
    `inspector/ui/index.html must reference "${sourceEntryReference}".`,
  );
}
await writeFile(
  path.join(outputDirectory, "index.html"),
  sourceHtml.replace(sourceEntryReference, "./app.js"),
);
await copyFile(
  path.join(sourceDirectory, "styles.css"),
  path.join(outputDirectory, "styles.css"),
);

const outputs = Object.entries(result.metafile.outputs)
  .map(
    ([file, output]) =>
      `${path.relative(repositoryRoot, file)} (${String(output.bytes)} bytes)`,
  )
  .sort()
  .concat("inspector/ui/build/index.html", "inspector/ui/build/styles.css");
console.log(
  `Built the served inspection dashboard:\n  ${outputs.join("\n  ")}`,
);
