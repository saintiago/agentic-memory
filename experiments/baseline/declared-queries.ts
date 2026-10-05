/**
 * The declared baseline queries: each question fixed, with its expected note evidence and whether
 * the wording is the recorded audit text or a labeled replacement, before any query runs. The
 * audit's exact known-topic wording is unavailable, so replacements are labeled instead of being
 * presented as exact repeats.
 *
 * See docs/evaluation.md#retrieval-and-semantic-measures and
 * docs/evaluation.md#quality-change-acceptance.
 */
import { z } from "zod";

import { sha256Text } from "./io.js";

/** One declared baseline query with its expected evidence fixed in advance. */
export const baselineQuerySchema = z.strictObject({
  id: z.string().min(1, "A query ID must be a nonempty string."),
  query: z
    .string()
    .refine(
      (value) => /\S/.test(value),
      "A query must contain non-whitespace text.",
    ),
  expectedNoteIds: z.array(z.uuid("An expected note ID must be a UUID.")),
  scope: z.string().min(1).optional(),
  rationale: z.string().min(1, "A query rationale must be nonempty."),
  /** `exact` only when the text is the recorded query; a paraphrase is a labeled replacement. */
  wording: z.enum(["exact", "replacement"]),
  /** The audit subject or question this declaration comes from. */
  evidence: z.string().min(1, "A query must name its evidence source."),
});

export type BaselineQuery = z.infer<typeof baselineQuerySchema>;

/** Parse declared queries from JSONL text, failing by position without quoting query text. */
export const readDeclaredQueries = (text: string): BaselineQuery[] => {
  const queries: BaselineQuery[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new DeclaredQueryError(
        `Declared queries line ${String(index + 1)} is not valid JSON.`,
      );
    }
    const query = baselineQuerySchema.safeParse(parsed);
    if (!query.success) {
      throw new DeclaredQueryError(
        `Declared queries line ${String(index + 1)} is invalid: ${query.error.issues
          .map((issue) =>
            issue.path.length === 0
              ? issue.message
              : `${issue.path.map(String).join(".")}: ${issue.message}`,
          )
          .join("; ")}`,
      );
    }
    queries.push(query.data);
  }
  const ids = new Set<string>();
  for (const query of queries) {
    if (ids.has(query.id)) {
      throw new DeclaredQueryError(
        `Declared queries repeat the ID "${query.id}".`,
      );
    }
    ids.add(query.id);
  }
  return queries;
};

/** An unreadable declared-query file. */
export class DeclaredQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeclaredQueryError";
  }
}

/** Hash the exact declared-query text, so the manifest ties the queries to the run. */
export const declaredQueriesHash = (text: string): string => sha256Text(text);
