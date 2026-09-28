/**
 * The inspection graph of one saved run: stored notes as nodes, the directed links they store as
 * edges, and the source, construction and final attributes the artifacts recorded for each note.
 * The graph derives no similarity edge and never turns an evolution update into a link.
 *
 * See docs/evaluation.md#graph-inspection.
 */
import type { Attributes, JsonValue, Note } from "../../src/index.js";
import type {
  ConstructionRecord,
  FinalNoteRecord,
  RunManifest,
  SourceRecord,
} from "../replay/artifacts.js";

/** The manifest fields the report states about the run it inspects. */
export interface GraphRunManifest {
  runId: string;
  status: RunManifest["status"];
  revision: string;
  storage: { kind: RunManifest["storage"]["kind"]; representation: string };
  timing: {
    startedAt: string;
    finishedAt: string | null;
    conditions: Record<string, JsonValue>;
  };
}

/** The source evidence one run recorded for a note. */
export interface GraphSourceEvidence {
  sourceId: string;
  content: string;
  timestamp: string | null;
  metadata: Record<string, JsonValue> | null;
  /** How far the supplied entry got, as `sources.jsonl` recorded it. */
  outcome: SourceRecord["outcome"];
}

/** One node: a note `notes.jsonl` exported, or a link target that export did not return. */
export interface GraphNode {
  /** The real stored note UUID. */
  id: string;
  /** The fixture source that allocated the note; null when the run cannot attribute it. */
  sourceId: string | null;
  /** The original source entry, when the run recorded one for this note. */
  source: GraphSourceEvidence | null;
  /** A string `scope` the source metadata declares; null when it declares none. */
  scope: string | null;
  /** Whether `notes.jsonl` exported this note. */
  exported: boolean;
  /** The complete current note; null for a link target public notes did not export. */
  note: Note | null;
  /** Construction attributes captured before evolution; null when the run recorded none. */
  construction: Attributes | null;
  /** Directed stored links in stored order; empty when no note record was exported. */
  links: string[];
  /** Stored notes that link to this node, derived from the exported link lists. */
  incoming: string[];
}

/** One directed stored link between two nodes. */
export interface GraphEdge {
  from: string;
  to: string;
  /** Whether `notes.jsonl` exported the target note. */
  resolved: boolean;
}

/** Everything the offline report shows, so the JSON beside it reproduces the same evidence. */
export interface InspectionGraph {
  run: {
    runId: string;
    status: RunManifest["status"];
    revision: string;
    storage: { kind: RunManifest["storage"]["kind"]; representation: string };
    startedAt: string;
    finishedAt: string | null;
    conditions: Record<string, JsonValue>;
  };
  counts: {
    sources: number;
    exportedNotes: number;
    nodes: number;
    unresolved: number;
    links: number;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The saved records the graph is built from. */
export interface InspectionGraphInput {
  manifest: GraphRunManifest;
  sources: readonly SourceRecord[];
  construction: readonly ConstructionRecord[];
  notes: readonly FinalNoteRecord[];
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** UUID identity is case-insensitive, so artifacts are correlated by their lowercase spelling. */
const identityKey = (noteId: string): string => noteId.toLowerCase();

const scopeLabel = (
  metadata: Record<string, JsonValue> | null,
): string | null => {
  const scope = metadata?.["scope"];
  return typeof scope === "string" && scope.trim() !== "" ? scope : null;
};

/** Build the graph of one run from its saved records, resolving links against exported notes. */
export const buildInspectionGraph = (
  input: InspectionGraphInput,
): InspectionGraph => {
  const sourceByNoteId = new Map<string, SourceRecord>();
  for (const record of input.sources) {
    if (record.noteId === null) {
      continue;
    }
    const key = identityKey(record.noteId);
    if (!sourceByNoteId.has(key)) {
      sourceByNoteId.set(key, record);
    }
  }
  const constructionByNoteId = new Map<string, Attributes>();
  for (const record of input.construction) {
    const key = identityKey(record.noteId);
    if (!constructionByNoteId.has(key)) {
      constructionByNoteId.set(key, record.attributes);
    }
  }
  const evidence = (
    record: SourceRecord | undefined,
  ): GraphSourceEvidence | null =>
    record === undefined
      ? null
      : {
          sourceId: record.sourceId,
          content: record.content,
          timestamp: record.timestamp,
          metadata: record.metadata,
          outcome: record.outcome,
        };

  const nodes = new Map<string, GraphNode>();
  for (const record of input.notes) {
    const key = identityKey(record.note.id);
    if (nodes.has(key)) {
      continue;
    }
    const source = sourceByNoteId.get(key);
    nodes.set(key, {
      id: record.note.id,
      sourceId: record.sourceId ?? source?.sourceId ?? null,
      source: evidence(source),
      scope: scopeLabel(source?.metadata ?? null),
      exported: true,
      note: record.note,
      construction: constructionByNoteId.get(key) ?? null,
      links: [...record.note.links],
      incoming: [],
    });
  }

  // A stored link whose target pagination did not return stays visible instead of disappearing.
  for (const node of [...nodes.values()]) {
    for (const link of node.links) {
      const key = identityKey(link);
      if (nodes.has(key)) {
        continue;
      }
      const source = sourceByNoteId.get(key);
      nodes.set(key, {
        id: link,
        sourceId: source?.sourceId ?? null,
        source: evidence(source),
        scope: scopeLabel(source?.metadata ?? null),
        exported: false,
        note: null,
        construction: constructionByNoteId.get(key) ?? null,
        links: [],
        incoming: [],
      });
    }
  }

  const edges: GraphEdge[] = [];
  for (const node of nodes.values()) {
    for (const link of node.links) {
      const target = nodes.get(identityKey(link));
      if (target === undefined) {
        continue;
      }
      target.incoming.push(node.id);
      edges.push({
        from: node.id,
        to: target.id,
        resolved: target.exported,
      });
    }
  }

  const ordered = [...nodes.values()].sort(
    (left, right) =>
      compareText(left.sourceId ?? left.id, right.sourceId ?? right.id) ||
      compareText(left.id, right.id),
  );
  for (const node of ordered) {
    node.incoming.sort(compareText);
  }
  edges.sort(
    (left, right) =>
      compareText(left.from, right.from) || compareText(left.to, right.to),
  );

  return {
    run: {
      runId: input.manifest.runId,
      status: input.manifest.status,
      revision: input.manifest.revision,
      storage: {
        kind: input.manifest.storage.kind,
        representation: input.manifest.storage.representation,
      },
      startedAt: input.manifest.timing.startedAt,
      finishedAt: input.manifest.timing.finishedAt,
      conditions: input.manifest.timing.conditions,
    },
    counts: {
      sources: input.sources.length,
      exportedNotes: ordered.filter((node) => node.exported).length,
      nodes: ordered.length,
      unresolved: ordered.filter((node) => !node.exported).length,
      links: edges.length,
    },
    nodes: ordered,
    edges,
  };
};
