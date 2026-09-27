/**
 * Read the saved artifacts an inspection graph is built from: the manifest, the source-to-note
 * mapping, the construction snapshots and the notes public pagination returned. The graph never
 * opens a live collection or the prototype, and it never rewrites a run artifact.
 *
 * See docs/evaluation.md#run-artifacts and docs/evaluation.md#graph-inspection.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  attributesSchema,
  jsonValueSchema,
  noteSchema,
} from "../../src/index.js";
import type {
  ConstructionRecord,
  FinalNoteRecord,
  SourceRecord,
} from "../replay/artifacts.js";
import type { GraphRunManifest } from "./document.js";

/** The saved artifacts the graph reads; the rest of the run directory stays untouched. */
export const graphArtifactFiles = [
  "manifest.json",
  "sources.jsonl",
  "construction.jsonl",
  "notes.jsonl",
] as const;

/** One run directory's loaded graph evidence. */
export interface RunGraphArtifacts {
  directory: string;
  manifest: GraphRunManifest;
  sources: SourceRecord[];
  construction: ConstructionRecord[];
  notes: FinalNoteRecord[];
}

/** A run directory does not hold the saved artifacts an inspection graph needs. */
export class GraphArtifactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphArtifactsError";
  }
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const manifestSchema = z.object({
  runId: z.string(),
  status: z.enum(["running", "completed", "stopped", "failed"]),
  revision: z.string(),
  storage: z.object({
    kind: z.enum(["qdrant", "in-memory"]),
    representation: z.string(),
  }),
  timing: z.object({
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    conditions: z.record(z.string(), jsonValueSchema),
  }),
});

const sourceRecordSchema = z.object({
  sourceId: z.string(),
  content: z.string(),
  timestamp: z.string().nullable(),
  metadata: z.record(z.string(), jsonValueSchema).nullable(),
  noteId: z.string().nullable(),
  outcome: z.enum(["inserted", "failed", "stopped", "excluded", "unattempted"]),
});

const constructionRecordSchema = z.object({
  sourceId: z.string(),
  noteId: z.string(),
  attributes: attributesSchema,
});

const finalNoteRecordSchema = z.object({
  sourceId: z.string().nullable(),
  note: noteSchema,
});

const parseJson = <Output>(
  label: string,
  text: string,
  schema: z.ZodType<Output>,
): Output => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new GraphArtifactsError(
      `${label} is not valid JSON: ${describe(cause)}`,
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue) =>
          `${issue.path.join(".") === "" ? "<root>" : issue.path.join(".")}: ${issue.message}`,
      )
      .join("; ");
    throw new GraphArtifactsError(
      `${label} does not match the saved artifact shape: ${issues}`,
    );
  }
  return result.data;
};

const parseJsonl = <Output>(
  file: string,
  text: string,
  schema: z.ZodType<Output>,
): Output[] =>
  text
    .split("\n")
    .flatMap((line, index) =>
      line.trim() === ""
        ? []
        : [parseJson(`${file} line ${String(index + 1)}`, line, schema)],
    );

const readArtifact = async (
  directory: string,
  file: (typeof graphArtifactFiles)[number],
): Promise<string> => {
  try {
    return await readFile(path.join(directory, file), "utf8");
  } catch (cause) {
    throw new GraphArtifactsError(
      `Cannot read ${file} from the run directory ${directory}: ${describe(cause)}`,
    );
  }
};

/** Load one run directory's manifest, source mapping, construction snapshots and exported notes. */
export const readRunGraphArtifacts = async (
  directory: string,
): Promise<RunGraphArtifacts> => {
  const manifest = parseJson(
    "manifest.json",
    await readArtifact(directory, "manifest.json"),
    manifestSchema,
  );
  const sources = parseJsonl(
    "sources.jsonl",
    await readArtifact(directory, "sources.jsonl"),
    sourceRecordSchema,
  );
  const construction = parseJsonl(
    "construction.jsonl",
    await readArtifact(directory, "construction.jsonl"),
    constructionRecordSchema,
  );
  const notes = parseJsonl(
    "notes.jsonl",
    await readArtifact(directory, "notes.jsonl"),
    finalNoteRecordSchema,
  );
  return { directory, manifest, sources, construction, notes };
};
