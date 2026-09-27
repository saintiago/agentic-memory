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

/**
 * The consumer imports the installed package by name and exercises the public contract of the
 * assembled library: exports and schemas, then add, search, get and page through host-supplied
 * implementations of the provider contracts.
 */
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

/** A minimal in-consumer NoteStore: current records, ranked matches and a paged traversal. */
class ConsumerStore {
  records = new Map();

  async put(records) {
    for (const record of records) {
      this.records.set(record.note.id, structuredClone(record));
    }
  }

  async get(ids) {
    return ids.flatMap((id) => {
      const record = this.records.get(id);
      return record === undefined ? [] : [structuredClone(record.note)];
    });
  }

  async nearest(vector, limit) {
    // The most recently stored note ranks first, so its link provides the linked addition.
    return [...this.records.values()]
      .reverse()
      .slice(0, limit)
      .map((record, index) => ({
        note: structuredClone(record.note),
        score: 1 - index * 0.1,
      }));
  }

  async page(limit, cursor) {
    const start = typeof cursor === "number" ? cursor : 0;
    const notes = [...this.records.values()]
      .slice(start, start + limit)
      .map((record) => structuredClone(record.note));
    const next = start + limit;
    return next < this.records.size ? { notes, cursor: next } : { notes };
  }
}

class ConsumerEmbedder {
  space = { id: "packed-consumer-space", dimensions: 2, distance: "Cosine" };

  async embed() {
    return [1, 0];
  }
}

let firstId;
class ConsumerModel {
  calls = 0;

  async generate(request) {
    this.calls += 1;
    if (request.stage === "construct") {
      return {
        context: "Records source material supplied by the packed consumer.",
        keywords: ["source"],
        tags: ["packed"],
      };
    }
    if (request.stage === "evolve") {
      return { links: [firstId], newTags: ["packed", "linked"], updates: [] };
    }
    throw new Error("unexpected stage " + request.stage);
  }
}

const store = new ConsumerStore();
const model = new ConsumerModel();
const agent = new memory.AgenticMemory(store, new ConsumerEmbedder(), model);
const first = await agent.add({ content: "The first packed source." });
firstId = first.id;
const second = await agent.add({ content: "The second packed source." });
assert.equal(model.calls, 3, "two constructions and one evolution reached the host model");

// Search keeps the ranked direct match and appends the distinct note reached through its link.
const linked = await agent.search("a query", { limit: 1, linkedLimit: 5 });
assert.deepEqual(
  linked.map((result) => [result.via, result.note.id]),
  [["match", second.id], ["link", first.id]],
);
assert.equal(linked[0].score, 1);
assert.equal("score" in linked[1], false);

// A zero linked limit disables expansion, and retrieval never calls the model again.
const direct = await agent.search("a query", { limit: 2, linkedLimit: 0 });
assert.deepEqual(direct.map((result) => result.via), ["match", "match"]);
assert.equal(model.calls, 3);

// Inspection returns current notes and reaches the end of a paged traversal.
assert.deepEqual(await agent.get(first.id), first);
assert.equal(await agent.get("b3c1d2e3-4f50-4610-8899-0a1b2c3d4e5f"), undefined);
const firstPage = await agent.page(1);
assert.equal(firstPage.notes.length, 1);
assert.equal(typeof firstPage.cursor, "number");
const lastPage = await agent.page(1, firstPage.cursor);
assert.equal(lastPage.notes.length, 1);
assert.equal(lastPage.cursor, undefined);

// Invalid input fails as a typed memory error before any provider call.
await assert.rejects(
  () => agent.get("not-a-uuid"),
  (error) =>
    error instanceof memory.MemoryError &&
    error.operation === "get" &&
    error.stage === "input" &&
    error.persistence === "unchanged",
);

console.log(
  "packed consumer imported " +
    Object.keys(memory).length +
    " runtime exports and exercised add, search, get and page",
);
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
