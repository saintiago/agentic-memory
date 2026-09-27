#!/usr/bin/env node
/**
 * Validate the packed build from a temporary consumer directory: pack the built package, install
 * the tarball into a fresh consumer and import the public exports from the installed copy. The
 * consumer must not resolve anything through this repository.
 *
 * See docs/development.md#toolchain-and-validation-commands.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

/** The consumer imports the installed package by name and exercises its public contract. */
const consumerCheck = `
import assert from "node:assert/strict";
import * as memory from "agentic-memory";

const note = {
  id: "b3c1d2e3-4f50-4610-8899-0a1b2c3d4e5f",
  content: "A host supplies source material.",
  timestamp: "2026-09-27T15:44:27Z",
  context: "Describes the host supplying source material.",
  keywords: ["source material"],
  tags: ["note"],
  links: [],
};

for (const name of ["jsonValueSchema", "noteSchema", "embeddedNoteSchema", "matchSchema", "pageSchema"]) {
  assert.equal(typeof memory[name]?.safeParse, "function", name + " is exported as a schema");
}
assert.equal(memory.noteSchema.safeParse(note).success, true, "noteSchema accepts a valid note");
assert.equal(memory.noteSchema.safeParse({ ...note, id: "note-1" }).success, false);

for (const name of ["AgenticMemory", "MemoryError", "embeddingText"]) {
  assert.equal(typeof memory[name], "function", name + " is exported from the package root");
}
assert.equal(
  memory.embeddingText({ content: "Source text.", context: "Records the source.", keywords: ["source"], tags: [] }),
  "Source text.\\nKeywords: source\\nTags: \\nContext: Records the source.",
);

console.log("packed consumer imported " + Object.keys(memory).length + " runtime exports");
`;

/** Entry points the manifest promises the packed package contains. */
async function manifestEntryPoints() {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const targets = new Set([
    manifest.main,
    manifest.types,
    manifest.exports["."].types,
    manifest.exports["."].default,
  ]);
  return [...targets].map((target) => target.replace(/^\.\//, ""));
}

const workspace = await mkdtemp(path.join(tmpdir(), "agentic-memory-pack-"));

try {
  const { stdout: packOutput } = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", workspace],
    { cwd: repositoryRoot },
  );
  const [packed] = JSON.parse(packOutput);
  const packedFiles = new Set(packed.files.map((file) => file.path));
  const missingEntryPoints = (await manifestEntryPoints()).filter(
    (file) => !packedFiles.has(file),
  );
  if (missingEntryPoints.length > 0) {
    throw new Error(
      `The packed package misses manifest entry points: ${missingEntryPoints.join(", ")}`,
    );
  }

  const consumerDirectory = path.join(workspace, "consumer");
  await mkdir(consumerDirectory);
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "packed-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  await run(
    "npm",
    [
      "install",
      path.join(workspace, packed.filename),
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ],
    { cwd: consumerDirectory },
  );
  await writeFile(path.join(consumerDirectory, "check.mjs"), consumerCheck);
  const { stdout } = await run(process.execPath, ["check.mjs"], {
    cwd: consumerDirectory,
  });
  process.stdout.write(
    `${stdout.trimEnd()}\nPackaged build verified from a temporary consumer.\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
