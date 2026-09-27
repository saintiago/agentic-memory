import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildInspectionGraph,
  type InspectionGraph,
} from "../../experiments/graph/document.js";
import { renderGraphHtml } from "../../experiments/graph/html.js";
import { renderRunGraph } from "../../experiments/graph/render.js";
import {
  GraphArtifactsError,
  readRunGraphArtifacts,
} from "../../experiments/graph/run-directory.js";
import { createInMemoryEnvironment } from "../../experiments/replay/environment.js";
import { readEvolutionEnvelope } from "../../experiments/replay/envelope.js";
import {
  fixtureHash,
  type QueryCase,
  type SourceEntry,
} from "../../experiments/replay/fixture.js";
import {
  runReplay,
  type ReplayResult,
} from "../../experiments/replay/runner.js";
import {
  modelDescription,
  ScriptedModel,
  TokenEmbedder,
} from "./support/harness.js";

/**
 * The offline inspection graph built from saved run artifacts: nodes are the exported notes, edges
 * are the directed links they store, and the report keeps source, construction and final evidence.
 * The store is the in-memory replacement and the model is scripted, so the cases are offline.
 *
 * See docs/evaluation.md#graph-inspection and docs/testing.md#test-discipline.
 */

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "amem-graph-"));
  directories.push(directory);
  return directory;
};

afterAll(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Three sources in two domains, one with a declared scope label. */
const graphSources: SourceEntry[] = [
  {
    sourceId: "alpha-policy",
    content: "The alpha policy requires written operator approval.",
    timestamp: "2026-09-01T10:00:00Z",
    metadata: { domain: "alpha", kind: "policy", scope: "Europe" },
  },
  {
    sourceId: "alpha-exception",
    content: "The alpha policy exception excludes audit records.",
    timestamp: "2026-09-02T10:00:00Z",
    metadata: { domain: "alpha", kind: "exception", scope: "Europe" },
  },
  {
    sourceId: "beta-routine",
    content: "The beta routine ran without written operator approval.",
    timestamp: "2026-09-03T10:00:00Z",
    metadata: { domain: "beta", kind: "observation" },
  },
];

const graphQueries: QueryCase[] = [
  {
    id: "alpha-policy",
    query: "alpha policy written approval",
    requiredSourceIds: ["alpha-policy"],
    scope: "alpha",
    rationale: "One policy source in the alpha domain.",
  },
];

/** The constructions and evolutions the three insertions issue: one real stored link, then none. */
const graphModel = (): ScriptedModel =>
  new ScriptedModel()
    .queue("construct", () => ({
      context: "Records the alpha policy approval requirement.",
      keywords: ["alpha", "policy"],
      tags: ["policy"],
    }))
    .queue("construct", () => ({
      context: "Records the alpha policy exception.",
      keywords: ["alpha", "exception"],
      tags: ["policy"],
    }))
    .queue("evolve", (request) => {
      const { incoming, neighbors } = readEvolutionEnvelope(request.prompt);
      const related = neighbors
        .filter(
          (neighbor) =>
            neighbor.content.includes("alpha") &&
            incoming.content.includes("alpha"),
        )
        .map((neighbor) => neighbor.id);
      return {
        links: related,
        newTags: [...incoming.tags, "linked"],
        updates: [],
      };
    })
    .queue("construct", () => ({
      context: "Records the beta routine observation.",
      keywords: ["beta", "routine"],
      tags: ["routine"],
    }))
    .queue("evolve", () => ({ links: [], newTags: [], updates: [] }));

const runGraphReplay = async (runId: string): Promise<ReplayResult> => {
  const model = graphModel();
  return runReplay({
    runId,
    revision: "graph-test-revision",
    runsDirectory: await temporaryDirectory(),
    sources: graphSources,
    queries: graphQueries,
    sourceHash: fixtureHash("graph-sources"),
    queryHash: fixtureHash("graph-queries"),
    environment: createInMemoryEnvironment({
      embedder: new TokenEmbedder(),
      model,
      exchangeLog: model.exchanges,
      encoderSettings: { kind: "test-token-embedder", dimensions: 4 },
      modelDescription,
    }),
    recordRawExchanges: true,
  });
};

/** Normalize a value the way JSON persistence does, so parsed files compare with built objects. */
const asJson = <Value>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

describe("inspection graph", () => {
  it("builds nodes and the stored directed links of a completed run", async () => {
    const result = await runGraphReplay("graph-run");
    expect(result.status).toBe("completed");
    const artifacts = await readRunGraphArtifacts(result.directory);
    const graph = buildInspectionGraph(artifacts);

    expect(graph.run.runId).toBe("graph-run");
    expect(graph.run.status).toBe("completed");
    expect(graph.run.revision).toBe("graph-test-revision");
    expect(graph.run.storage).toEqual({
      kind: "in-memory",
      representation: "amem-note-v1",
    });
    expect(graph.counts.sources).toBe(graphSources.length);
    expect(graph.counts.exportedNotes).toBe(artifacts.notes.length);
    expect(graph.counts.nodes).toBe(artifacts.notes.length);
    expect(graph.counts.unresolved).toBe(0);

    const policy = graph.nodes.find((node) => node.sourceId === "alpha-policy");
    const exception = graph.nodes.find(
      (node) => node.sourceId === "alpha-exception",
    );
    const routine = graph.nodes.find(
      (node) => node.sourceId === "beta-routine",
    );
    if (
      policy === undefined ||
      exception === undefined ||
      routine === undefined
    ) {
      throw new Error("expected the three fixture notes in the graph");
    }
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(
      artifacts.notes.map((record) => record.note.id).sort(),
    );

    // The only edge is the link the run stored. The neighbor evolution and the reverse direction
    // are not edges, and no note is linked by similarity.
    expect(graph.edges).toEqual([
      { from: exception.id, to: policy.id, resolved: true },
    ]);
    expect(exception.links).toEqual([policy.id]);
    expect(exception.incoming).toEqual([]);
    expect(policy.links).toEqual([]);
    expect(policy.incoming).toEqual([exception.id]);
    expect(routine.links).toEqual([]);

    const policySource = graphSources.find(
      (source) => source.sourceId === "alpha-policy",
    );
    expect(policy.source?.content).toBe(policySource?.content);
    expect(policy.source?.outcome).toBe("inserted");
    expect(policy.scope).toBe("Europe");
    expect(exception.scope).toBe("Europe");
    expect(routine.scope).toBeNull();
    expect(policy.construction).toEqual(
      artifacts.construction.find(
        (record) => record.sourceId === "alpha-policy",
      )?.attributes,
    );
    expect(policy.note).toEqual(
      artifacts.notes.find((record) => record.sourceId === "alpha-policy")
        ?.note,
    );

    // Construction versus final: the exception's stored tags evolved after construction.
    expect(exception.construction?.tags).toEqual(["policy"]);
    expect(exception.note?.tags).toEqual(["policy", "linked"]);
  });

  it("keeps a link target that public notes did not export, marked unresolved", async () => {
    const result = await runGraphReplay("graph-unresolved");
    const artifacts = await readRunGraphArtifacts(result.directory);
    const graph = buildInspectionGraph({
      manifest: artifacts.manifest,
      sources: artifacts.sources,
      construction: artifacts.construction,
      notes: artifacts.notes.filter(
        (record) => record.sourceId !== "alpha-policy",
      ),
    });

    expect(graph.counts.exportedNotes).toBe(2);
    expect(graph.counts.nodes).toBe(3);
    expect(graph.counts.unresolved).toBe(1);
    const missing = graph.nodes.find((node) => !node.exported);
    const exception = graph.nodes.find(
      (node) => node.sourceId === "alpha-exception",
    );
    expect(missing?.sourceId).toBe("alpha-policy");
    expect(missing?.note).toBeNull();
    expect(missing?.source?.content).toBe(
      "The alpha policy requires written operator approval.",
    );
    expect(exception?.links).toEqual([missing?.id]);
    expect(graph.edges).toEqual([
      { from: exception?.id, to: missing?.id, resolved: false },
    ]);
  });

  it("embeds artifact text inertly and recovers the same evidence from the saved JSON", async () => {
    const result = await runGraphReplay("graph-escaping");
    const artifacts = await readRunGraphArtifacts(result.directory);
    const dangerous =
      "</script><script>alert('x')</script><img src=x onerror=alert(1)>";
    const graph = buildInspectionGraph({
      manifest: artifacts.manifest,
      sources: artifacts.sources.map((record) =>
        record.sourceId === "alpha-policy"
          ? { ...record, content: dangerous }
          : record,
      ),
      construction: artifacts.construction,
      notes: artifacts.notes.map((record) =>
        record.sourceId === "alpha-policy"
          ? {
              ...record,
              note: {
                ...record.note,
                content: dangerous,
                context: dangerous,
                tags: [dangerous],
              },
            }
          : record,
      ),
    });

    const html = renderGraphHtml(graph);
    expect(html).not.toContain("</script><script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("\\u003c/script\\u003e");

    const match =
      /<script type="application\/json" id="graph-data">([\s\S]*?)<\/script>/.exec(
        html,
      );
    expect(match).not.toBeNull();
    const recovered = JSON.parse(match?.[1] ?? "") as InspectionGraph;
    expect(recovered).toEqual(asJson(graph));
    const recoveredPolicy = recovered.nodes.find(
      (node) => node.sourceId === "alpha-policy",
    );
    expect(recoveredPolicy?.note?.content).toBe(dangerous);
    expect(recoveredPolicy?.note?.context).toBe(dangerous);
    expect(recoveredPolicy?.source?.content).toBe(dangerous);
  });

  it("writes graph.html and graph.json without rewriting the run artifacts", async () => {
    const result = await runGraphReplay("graph-output");
    const reportPath = path.join(result.directory, "report.json");
    const reportBefore = await readFile(reportPath, "utf8");

    const rendered = await renderRunGraph({ runDirectory: result.directory });
    expect(rendered.outputDirectory).toBe(path.join(result.directory, "graph"));
    expect(rendered.htmlPath).toBe(
      path.join(result.directory, "graph", "graph.html"),
    );
    expect((await stat(rendered.htmlPath)).size).toBeGreaterThan(0);
    expect((await stat(rendered.jsonPath)).size).toBeGreaterThan(0);
    expect(await readFile(reportPath, "utf8")).toBe(reportBefore);

    const saved = JSON.parse(
      await readFile(rendered.jsonPath, "utf8"),
    ) as InspectionGraph;
    expect(saved).toEqual(asJson(rendered.graph));
    const html = await readFile(rendered.htmlPath, "utf8");
    for (const node of rendered.graph.nodes) {
      expect(html).toContain(node.id);
    }

    const elsewhere = await temporaryDirectory();
    const custom = await renderRunGraph({
      runDirectory: result.directory,
      outputDirectory: elsewhere,
    });
    expect(custom.outputDirectory).toBe(elsewhere);
    expect((await stat(custom.htmlPath)).size).toBeGreaterThan(0);
    expect(custom.graph).toEqual(rendered.graph);
  });

  it("reports a missing or malformed artifact instead of rendering partial evidence", async () => {
    const empty = await temporaryDirectory();
    await expect(readRunGraphArtifacts(empty)).rejects.toThrow(
      GraphArtifactsError,
    );
    await expect(readRunGraphArtifacts(empty)).rejects.toThrow(
      /manifest\.json/,
    );

    const result = await runGraphReplay("graph-incomplete");
    const manifestText = await readFile(
      path.join(result.directory, "manifest.json"),
      "utf8",
    );
    const incomplete = await temporaryDirectory();
    await writeFile(
      path.join(incomplete, "manifest.json"),
      manifestText,
      "utf8",
    );
    await expect(readRunGraphArtifacts(incomplete)).rejects.toThrow(
      /sources\.jsonl/,
    );

    const malformed = await temporaryDirectory();
    await writeFile(
      path.join(malformed, "manifest.json"),
      manifestText,
      "utf8",
    );
    await writeFile(path.join(malformed, "sources.jsonl"), "{\n", "utf8");
    await expect(readRunGraphArtifacts(malformed)).rejects.toThrow(
      /sources\.jsonl line 1/,
    );
  });
});
