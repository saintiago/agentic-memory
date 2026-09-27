/**
 * Replay fixture contract: ordered JSONL source entries and query cases, their validation before
 * any paid work, and the stable hashes a run manifest records.
 *
 * The tools never insert query text as source material, and extraction from an application's logs
 * belongs to that application's adapter, not to this harness.
 *
 * See docs/evaluation.md#input-contract-and-extraction.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  jsonValueSchema,
  type AddInput,
  type JsonValue,
} from "../../src/index.js";

/** Non-whitespace text: the rule source content and query text share. */
const nonWhitespaceText = (description: string) =>
  z
    .string()
    .refine(
      (value) => /\S/.test(value),
      `${description} must contain non-whitespace text.`,
    );

const isJsonObject = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Reuse NoteStore's JSON value rule, then require a JSON object as the documented contract does. */
const metadataSchema: z.ZodType<Record<string, JsonValue>> =
  jsonValueSchema.refine(isJsonObject, "Metadata must be a JSON object.");

/** One ordered source entry. `sourceId` is unique within a fixture, not a runtime note ID. */
export const sourceEntrySchema = z.strictObject({
  sourceId: z.string().min(1, "A source ID must be a nonempty string."),
  content: nonWhitespaceText("Source content"),
  timestamp: z.iso
    .datetime({
      offset: true,
      message:
        "A source timestamp must be an ISO 8601 instant with a timezone.",
    })
    .optional(),
  metadata: metadataSchema.optional(),
});

export type SourceEntry = z.infer<typeof sourceEntrySchema>;

/** One evaluation question with the source evidence fixed before any insertion. */
export const queryCaseSchema = z.strictObject({
  id: z.string().min(1, "A query ID must be a nonempty string."),
  query: nonWhitespaceText("A query"),
  requiredSourceIds: z.array(
    z.string().min(1, "A required source ID must be a nonempty string."),
  ),
  scope: z
    .string()
    .min(1, "A query scope must be a nonempty string.")
    .optional(),
  rationale: nonWhitespaceText("A query rationale"),
});

export type QueryCase = z.infer<typeof queryCaseSchema>;

/** An invalid fixture. The problems name IDs and paths, never source content. */
export class FixtureError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The replay fixture is invalid:\n- ${problems.join("\n- ")}`);
    this.name = "FixtureError";
    this.problems = problems;
  }
}

const issueSummary = (
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): string =>
  issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join(".")}: ${issue.message}`,
    )
    .join("; ");

/**
 * Split JSONL text into one value per nonempty line. A malformed line is reported by position; the
 * parser never quotes the line, so a diagnostic cannot repeat private fixture content.
 */
const parseLines = (
  text: string,
  label: string,
  problems: string[],
): unknown[] => {
  const values: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      continue;
    }
    try {
      values.push(JSON.parse(line));
    } catch {
      problems.push(`${label} line ${index + 1} is not valid JSON.`);
    }
  }
  return values;
};

/** Read ordered source entries, reporting every malformed line and entry at once. */
export const readSourceEntries = (text: string): SourceEntry[] => {
  const problems: string[] = [];
  const entries: SourceEntry[] = [];
  const values = parseLines(text, "sources", problems);
  values.forEach((value, index) => {
    const parsed = sourceEntrySchema.safeParse(value);
    if (!parsed.success) {
      problems.push(
        `sources entry ${index + 1}: ${issueSummary(parsed.error.issues)}`,
      );
      return;
    }
    entries.push(parsed.data);
  });
  if (problems.length > 0) {
    throw new FixtureError(problems);
  }
  return entries;
};

/** Read query cases, reporting every malformed line and entry at once. */
export const readQueryCases = (text: string): QueryCase[] => {
  const problems: string[] = [];
  const cases: QueryCase[] = [];
  const values = parseLines(text, "queries", problems);
  values.forEach((value, index) => {
    const parsed = queryCaseSchema.safeParse(value);
    if (!parsed.success) {
      problems.push(
        `queries entry ${index + 1}: ${issueSummary(parsed.error.issues)}`,
      );
      return;
    }
    cases.push(parsed.data);
  });
  if (problems.length > 0) {
    throw new FixtureError(problems);
  }
  return cases;
};

/**
 * Reject duplicate fixture/query IDs, repeated expectations and query expectations that name no
 * supplied source. This runs before any insertion, so an invalid fixture costs no paid work.
 */
export const validateFixture = (
  sources: readonly SourceEntry[],
  queries: readonly QueryCase[],
): void => {
  const problems: string[] = [];
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) {
      problems.push(`duplicate source ID "${source.sourceId}"`);
    }
    sourceIds.add(source.sourceId);
  }
  const queryIds = new Set<string>();
  for (const query of queries) {
    if (queryIds.has(query.id)) {
      problems.push(`duplicate query ID "${query.id}"`);
    }
    queryIds.add(query.id);
  }
  for (const query of queries) {
    const expected = new Set<string>();
    for (const sourceId of query.requiredSourceIds) {
      if (expected.has(sourceId)) {
        problems.push(
          `query "${query.id}" repeats required source ID "${sourceId}"`,
        );
      }
      expected.add(sourceId);
      if (!sourceIds.has(sourceId)) {
        problems.push(
          `query "${query.id}" references missing source ID "${sourceId}"`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new FixtureError(problems);
  }
};

/** The declared hash of one fixture file, recorded in the run manifest. */
export const fixtureHash = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** The memory input one source entry supplies; `sourceId` stays a fixture concern. */
export const toAddInput = (entry: SourceEntry): AddInput => ({
  content: entry.content,
  ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
  ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
});
