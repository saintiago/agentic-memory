import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FixtureError,
  fixtureHash,
  readQueryCases,
  readSourceEntries,
  toAddInput,
  validateFixture,
} from "../../experiments/replay/fixture.js";

/**
 * The fixture contract: ordered JSONL entries, their documented fields and the validation that runs
 * before any insertion. See docs/evaluation.md#input-contract-and-extraction.
 */

const sourceLine = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    sourceId: "source-1",
    content: "A synthetic source statement.",
    timestamp: "2026-09-01T10:00:00Z",
    metadata: { domain: "synthetic" },
    ...overrides,
  });

const queryLine = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "query-1",
    query: "a synthetic question",
    requiredSourceIds: ["source-1"],
    rationale: "The only source that states the fact.",
    ...overrides,
  });

describe("fixture reading", () => {
  it("reads ordered entries and ignores blank lines and a trailing newline", () => {
    const text = `${sourceLine()}\n\n${sourceLine({ sourceId: "source-2" })}\n`;
    const entries = readSourceEntries(text);
    expect(entries.map((entry) => entry.sourceId)).toEqual([
      "source-1",
      "source-2",
    ]);
    expect(entries[0]?.metadata).toEqual({ domain: "synthetic" });
  });

  it("reports a malformed line by position without quoting it", () => {
    const text = `${sourceLine()}\nthis is not JSON\n`;
    let error: FixtureError | undefined;
    try {
      readSourceEntries(text);
    } catch (cause) {
      error = cause as FixtureError;
    }
    expect(error).toBeInstanceOf(FixtureError);
    expect(error?.problems).toEqual(["sources line 2 is not valid JSON."]);
    expect(error?.message).not.toContain("this is not JSON");
  });

  it("rejects entries that do not match the documented shape", () => {
    expect(() =>
      readSourceEntries(sourceLine({ content: "   " })),
    ).toThrowError(/content must contain non-whitespace text/);
    expect(() => readSourceEntries(sourceLine({ unknown: true }))).toThrowError(
      /Unrecognized key/,
    );
    expect(() =>
      readSourceEntries(sourceLine({ timestamp: "2026-09-01" })),
    ).toThrowError(/timestamp must be an ISO 8601 instant with a timezone/);
    expect(() =>
      readQueryCases(queryLine({ requiredSourceIds: "source-1" })),
    ).toThrowError(/expected array/);
  });

  it("converts a source entry into the memory input without the fixture ID", () => {
    const [entry] = readSourceEntries(sourceLine());
    expect(entry).toBeDefined();
    expect(toAddInput(entry!)).toEqual({
      content: "A synthetic source statement.",
      timestamp: "2026-09-01T10:00:00Z",
      metadata: { domain: "synthetic" },
    });
  });

  it("hashes the exact fixture text it was given", () => {
    expect(fixtureHash("a")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fixtureHash("a")).toBe(fixtureHash("a"));
    expect(fixtureHash("a")).not.toBe(fixtureHash("b"));
  });
});

describe("fixture validation", () => {
  const sources = readSourceEntries(
    `${sourceLine()}\n${sourceLine({ sourceId: "source-2" })}`,
  );
  const queries = readQueryCases(
    `${queryLine()}\n${queryLine({ id: "query-2", requiredSourceIds: ["source-2"] })}`,
  );

  it("accepts a fixture whose expectations all name supplied sources", () => {
    expect(() => validateFixture(sources, queries)).not.toThrow();
  });

  it("rejects duplicate source and query IDs", () => {
    const duplicatedSources = [...sources, sources[0]!];
    expect(() => validateFixture(duplicatedSources, queries)).toThrowError(
      /duplicate source ID "source-1"/,
    );
    const duplicatedQueries = [...queries, queries[0]!];
    expect(() => validateFixture(sources, duplicatedQueries)).toThrowError(
      /duplicate query ID "query-1"/,
    );
  });

  it("rejects expectations that name a missing or repeated source", () => {
    expect(() =>
      validateFixture(sources, [
        readQueryCases(
          queryLine({ requiredSourceIds: ["source-1", "source-9"] }),
        )[0]!,
      ]),
    ).toThrowError(/references missing source ID "source-9"/);
    expect(() =>
      validateFixture(sources, [
        readQueryCases(
          queryLine({ requiredSourceIds: ["source-1", "source-1"] }),
        )[0]!,
      ]),
    ).toThrowError(/repeats required source ID "source-1"/);
  });

  it("accepts a query without expectations and reports it as such", () => {
    const [query] = readQueryCases(queryLine({ requiredSourceIds: [] }));
    expect(query?.requiredSourceIds).toEqual([]);
    expect(() => validateFixture(sources, [query!])).not.toThrow();
  });
});

describe("committed demonstration fixtures", () => {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

  it("parse, validate and keep their expected source IDs", async () => {
    const sourceText = await readFile(
      `${repositoryRoot}/experiments/fixtures/synthetic-sources.jsonl`,
      "utf8",
    );
    const queryText = await readFile(
      `${repositoryRoot}/experiments/fixtures/synthetic-queries.jsonl`,
      "utf8",
    );
    const sources = readSourceEntries(sourceText);
    const queries = readQueryCases(queryText);
    expect(() => validateFixture(sources, queries)).not.toThrow();
    expect(sources).toHaveLength(10);
    expect(queries).toHaveLength(8);
    // Two unrelated domains, four multi-source expectations in total.
    expect(
      queries.filter((query) => query.requiredSourceIds.length > 1),
    ).toHaveLength(4);
    expect(queries.some((query) => query.scope === undefined)).toBe(true);
    // The same policy subject carries conflicting regional scopes, and a finding is followed by the
    // attributed response to it, so the specified evaluation scenarios have source material.
    const scopes = new Set(
      sources.map((source) => source.metadata?.["scope"]).filter(Boolean),
    );
    expect(scopes).toContain("Europe");
    expect(scopes).toContain("North America");
    const kinds = sources.map((source) => source.metadata?.["kind"]);
    expect(kinds).toContain("finding");
    expect(kinds).toContain("response");
    expect(queries.map((query) => query.id)).toContain(
      "approval-finding-response",
    );
  });
});
