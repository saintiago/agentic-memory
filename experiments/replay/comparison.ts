/**
 * The documented comparison modes and the retrieval evaluation every mode runs with the same
 * queries, encoder settings and direct limit: original content, constructed attributes, evolved
 * direct matches and evolved linked expansion.
 *
 * See docs/evaluation.md#comparison-modes and docs/evaluation.md#retrieval-and-semantic-measures.
 */
import {
  embeddingText,
  type AgenticMemory,
  type Note,
} from "../../src/index.js";
import type {
  RetrievalRecord,
  RetrievalResultRecord,
  RunCheck,
} from "./artifacts.js";
import type { QueryCase } from "./fixture.js";

/** The representation identity of the runtime collection the replay inserts into. */
export const runtimeRepresentation = "amem-note-v1";

/** One documented comparison mode. Baselines are materialized, never opened as runtime notes. */
export interface ComparisonMode {
  id: "original-content" | "constructed" | "evolved-direct" | "evolved-linked";
  /** The representation identity stored with the collection that holds this mode's vectors. */
  representation: string;
  /** The collection label the replay opens when this mode needs its own baseline collection. */
  collectionLabel: string | null;
  /** Whether this mode reuses the runtime collection instead of materializing a baseline. */
  linksEnabled: boolean;
  summary: string;
}

/** The four documented modes; only the linked mode enables one-hop expansion. */
export const comparisonModes: readonly ComparisonMode[] = [
  {
    id: "original-content",
    representation: "amem-eval-raw-content-v1",
    collectionLabel: "original-content",
    linksEnabled: false,
    summary: "Embed only immutable source content.",
  },
  {
    id: "constructed",
    representation: "amem-eval-constructed-v1",
    collectionLabel: "constructed",
    linksEnabled: false,
    summary: "Embed each note's first constructed attributes before evolution.",
  },
  {
    id: "evolved-direct",
    representation: runtimeRepresentation,
    collectionLabel: null,
    linksEnabled: false,
    summary:
      "Embed the final stored representation with linked expansion disabled.",
  },
  {
    id: "evolved-linked",
    representation: runtimeRepresentation,
    collectionLabel: null,
    linksEnabled: true,
    summary:
      "Use the same final direct matches with bounded one-hop expansion enabled.",
  },
];

/** One mode with the memory instance and collection that answer its queries. */
export interface RetrievalRun {
  mode: ComparisonMode;
  collection: string;
  memory: AgenticMemory;
}

/** The declared character serialization: the canonical embedding text of the returned note. */
const resultCharacters = (note: Note): RetrievalResultRecord["characters"] => {
  const total = embeddingText(note).length;
  return {
    content: note.content.length,
    attributes: total - note.content.length,
    total,
  };
};

const unique = (values: readonly (string | null)[]): Set<string> => {
  const set = new Set<string>();
  for (const value of values) {
    if (value !== null) {
      set.add(value);
    }
  }
  return set;
};

const retrievalRecord = (input: {
  run: RetrievalRun;
  query: QueryCase;
  directLimit: number;
  linkedLimit: number;
  sourceIdByNoteId: ReadonlyMap<string, string>;
  latencyMs: number;
  results: Array<{ note: Note; via: "match" | "link"; score?: number }>;
}): RetrievalRecord => {
  const results: RetrievalResultRecord[] = input.results.map((result) => ({
    noteId: result.note.id,
    sourceId: input.sourceIdByNoteId.get(result.note.id.toLowerCase()) ?? null,
    origin: result.via,
    score: result.via === "match" ? (result.score ?? null) : null,
    // The complete returned snapshot: a baseline result carries the construction or source
    // representation this mode actually ranked, not the runtime note's final attributes.
    note: structuredClone(result.note),
    characters: resultCharacters(result.note),
  }));
  const directSourceIds = unique(
    results
      .filter((result) => result.origin === "match")
      .map((r) => r.sourceId),
  );
  const linkedSourceIds = unique(
    results.filter((result) => result.origin === "link").map((r) => r.sourceId),
  );
  const required = input.query.requiredSourceIds;
  const first = results[0];
  return {
    mode: input.run.mode.id,
    representation: input.run.mode.representation,
    collection: input.run.collection,
    queryId: input.query.id,
    query: input.query.query,
    scope: input.query.scope ?? null,
    rationale: input.query.rationale,
    requiredSourceIds: [...required],
    limits: {
      direct: input.directLimit,
      linked: input.linkedLimit,
    },
    latencyMs: input.latencyMs,
    results,
    recovery: {
      firstResultRequired:
        first !== undefined &&
        first.origin === "match" &&
        first.sourceId !== null &&
        required.includes(first.sourceId),
      directRequired: required.filter((id) => directSourceIds.has(id)),
      linkedOnlyRequired: required.filter(
        (id) => !directSourceIds.has(id) && linkedSourceIds.has(id),
      ),
      missingRequired: required.filter(
        (id) => !directSourceIds.has(id) && !linkedSourceIds.has(id),
      ),
    },
  };
};

/**
 * Compare one record's direct match results with the ranked matches of the linked record for the
 * same query and collection. The library appends linked additions after the direct matches, so the
 * match prefix must be identical when linked expansion is enabled.
 */
const directPrefixMatches = (
  linked: RetrievalRecord,
  direct: RetrievalRecord,
): boolean => {
  const linkedMatches = linked.results.filter(
    (result) => result.origin === "match",
  );
  if (linkedMatches.length !== direct.results.length) {
    return false;
  }
  return linkedMatches.every((result, index) => {
    const other = direct.results[index];
    return (
      other !== undefined &&
      result.noteId === other.noteId &&
      result.score === other.score
    );
  });
};

/**
 * Check that every query the linked mode answered returns the same direct matches as the same
 * collection with linked expansion disabled.
 */
export const checkDirectPrefix = (
  records: readonly RetrievalRecord[],
): RunCheck | null => {
  const byQuery = new Map<
    string,
    { direct?: RetrievalRecord; linked?: RetrievalRecord }
  >();
  for (const record of records) {
    const key = `${record.collection}\u0000${record.queryId}`;
    const entry = byQuery.get(key) ?? {};
    if (record.limits.linked === 0) {
      entry.direct = record;
    } else {
      entry.linked = record;
    }
    byQuery.set(key, entry);
  }
  const pairs = [...byQuery.values()].filter(
    (entry) => entry.direct !== undefined && entry.linked !== undefined,
  );
  if (pairs.length === 0) {
    return null;
  }
  const mismatches = pairs.filter(
    (entry) => !directPrefixMatches(entry.linked!, entry.direct!),
  );
  return {
    name: "linked direct-prefix stability",
    ok: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `${String(pairs.length)} linked queries returned the same direct matches as the direct mode.`
        : `${String(mismatches.length)} linked queries changed their direct matches or scores.`,
  };
};

/**
 * Run every query of every mode against its collection, recording the complete ordered results,
 * origin classification, declared character counts, recovery flags and latency. Retrieval makes no
 * model call; the runner verifies that separately.
 */
export const evaluateRetrieval = async (input: {
  runs: readonly RetrievalRun[];
  queries: readonly QueryCase[];
  directLimit: number;
  linkedLimit: number;
  sourceIdByNoteId: ReadonlyMap<string, string>;
}): Promise<{ records: RetrievalRecord[]; checks: RunCheck[] }> => {
  const records: RetrievalRecord[] = [];
  for (const run of input.runs) {
    for (const query of input.queries) {
      const started = performance.now();
      const results = await run.memory.search(query.query, {
        limit: input.directLimit,
        linkedLimit: run.mode.linksEnabled ? input.linkedLimit : 0,
      });
      const latencyMs = performance.now() - started;
      records.push(
        retrievalRecord({
          run,
          query,
          directLimit: input.directLimit,
          linkedLimit: run.mode.linksEnabled ? input.linkedLimit : 0,
          sourceIdByNoteId: input.sourceIdByNoteId,
          latencyMs,
          results: results.map((result) =>
            result.via === "match"
              ? { note: result.note, via: "match", score: result.score }
              : { note: result.note, via: "link" },
          ),
        }),
      );
    }
  }
  const prefix = checkDirectPrefix(records);
  return { records, checks: prefix === null ? [] : [prefix] };
};
