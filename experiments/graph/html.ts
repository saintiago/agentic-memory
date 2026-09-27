/**
 * Render an inspection graph as one self-contained offline HTML report: no server, no network
 * access and no production UI dependency. The page draws the stored directed links only, states
 * that layout positions carry no meaning, embeds artifact text as escaped JSON and writes it into
 * the DOM with `textContent`, so source HTML is displayed instead of executed.
 *
 * See docs/evaluation.md#graph-inspection.
 */
import type { InspectionGraph } from "./document.js";

/** Escape the characters that could end a text or attribute context. */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Embed JSON without letting artifact text close the surrounding script element. */
const embedJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

const styles = String.raw`
      :root {
        color-scheme: light dark;
        --bg: #ffffff;
        --fg: #1f2328;
        --muted: #59636e;
        --border: #d1d9e0;
        --accent: #0969da;
        --warning: #9a6700;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0d1117;
          --fg: #e6edf3;
          --muted: #9198a1;
          --border: #3d444d;
          --accent: #4493f8;
          --warning: #d29922;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      header { padding: 14px 20px; border-bottom: 1px solid var(--border); }
      h1 { margin: 0 0 6px; font-size: 20px; }
      header p { margin: 4px 0; }
      .summary code, .counts { color: var(--muted); }
      .note { max-width: 80ch; color: var(--muted); }
      main {
        display: grid;
        grid-template-columns: minmax(180px, 240px) minmax(320px, 1fr) minmax(300px, 400px);
        gap: 12px;
        padding: 12px;
        align-items: start;
      }
      #node-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 78vh;
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 8px;
      }
      #node-list button {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: 0;
        border-bottom: 1px solid var(--border);
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      #node-list button:hover, #node-list button.selected {
        background: color-mix(in srgb, var(--accent) 12%, transparent);
      }
      #node-list .node-label { overflow-wrap: anywhere; }
      #node-list .node-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
      #canvas-panel {
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 6px;
      }
      #graph-canvas { display: block; max-width: 100%; height: auto; }
      .edge { fill: none; stroke: var(--muted); stroke-width: 1.2; marker-end: url(#link-arrow); }
      .edge.unresolved { stroke-dasharray: 5 4; }
      .arrow { fill: var(--muted); }
      .node circle { fill: var(--bg); stroke: var(--accent); stroke-width: 2; cursor: pointer; }
      .node.unresolved circle { stroke-dasharray: 3 3; }
      .node.selected circle { fill: var(--accent); }
      .node text { fill: var(--fg); font-size: 12px; text-anchor: middle; }
      .node:focus-visible { outline: 2px solid var(--accent); }
      #details {
        max-height: 78vh;
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px 12px;
      }
      #details h2 { margin: 0 0 4px; font-size: 17px; overflow-wrap: anywhere; }
      #details h3 { margin: 14px 0 6px; font-size: 14px; }
      .muted { color: var(--muted); }
      .warning { color: var(--warning); }
      .field { margin: 6px 0; }
      .field-name {
        display: block;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .field-value, .content {
        margin: 2px 0 0;
        padding: 6px 8px;
        background: color-mix(in srgb, var(--fg) 5%, transparent);
        border-radius: 6px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      table.comparison { border-collapse: collapse; width: 100%; font-size: 12px; }
      table.comparison th, table.comparison td {
        border: 1px solid var(--border);
        padding: 4px 6px;
        text-align: left;
        vertical-align: top;
        overflow-wrap: anywhere;
      }
      .link-list { list-style: none; margin: 4px 0; padding: 0; }
      .link-list li { margin: 2px 0; }
      .link-list button {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        border: 0;
        background: transparent;
        color: var(--accent);
        font: inherit;
        padding: 0;
        cursor: pointer;
        text-align: left;
      }
      .link-list .node-meta { color: var(--muted); font-size: 11px; }
      .link-list button:hover { text-decoration: underline; }
      @media (max-width: 900px) {
        main { grid-template-columns: 1fr; }
        #node-list, #details { max-height: none; }
      }
`;

const clientScript = String.raw`
(function () {
  "use strict";
  var graph = JSON.parse(document.getElementById("graph-data").textContent);
  var nodes = graph.nodes;
  var edges = graph.edges;
  var byId = {};
  var byLowerId = {};
  nodes.forEach(function (node) {
    byId[node.id] = node;
    byLowerId[node.id.toLowerCase()] = node;
  });

  function label(node) {
    return node.sourceId === null ? node.id : node.sourceId;
  }

  function shorten(value) {
    return value.length <= 26 ? value : value.slice(0, 25) + "\u2026";
  }

  function element(tag, className, value) {
    var node = document.createElement(tag);
    if (className !== undefined && className !== null) {
      node.className = className;
    }
    if (value !== undefined) {
      node.textContent = value;
    }
    return node;
  }

  function svgElement(name, attributes) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attributes).forEach(function (key) {
      node.setAttribute(key, attributes[key]);
    });
    return node;
  }

  var count = Math.max(nodes.length, 1);
  var radius = Math.max(150, count * 26);
  var margin = 240;
  var size = radius * 2 + margin * 2;
  var center = size / 2;
  var nodeRadius = 11;
  var positions = {};
  nodes.forEach(function (node, index) {
    var angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    positions[node.id] = {
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius,
    };
  });

  var canvas = document.getElementById("graph-canvas");
  canvas.setAttribute("viewBox", "0 0 " + size + " " + size);
  var defs = svgElement("defs", {});
  var marker = svgElement("marker", {
    id: "link-arrow",
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto-start-reverse",
  });
  marker.appendChild(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "arrow" }));
  defs.appendChild(marker);
  canvas.appendChild(defs);

  function hasReverse(edge) {
    return edges.some(function (other) {
      return other.from === edge.to && other.to === edge.from;
    });
  }

  var edgeGroup = svgElement("g", {});
  edges.forEach(function (edge) {
    var start = positions[edge.from];
    var end = positions[edge.to];
    if (start === undefined || end === undefined) {
      return;
    }
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var length = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / length;
    var uy = dy / length;
    var from = {
      x: start.x + ux * (nodeRadius + 3),
      y: start.y + uy * (nodeRadius + 3),
    };
    var to = {
      x: end.x - ux * (nodeRadius + 9),
      y: end.y - uy * (nodeRadius + 9),
    };
    var path;
    if (hasReverse(edge)) {
      var bend = 24;
      var controlX = (from.x + to.x) / 2 - uy * bend;
      var controlY = (from.y + to.y) / 2 + ux * bend;
      path =
        "M " + from.x + " " + from.y +
        " Q " + controlX + " " + controlY +
        " " + to.x + " " + to.y;
    } else {
      path = "M " + from.x + " " + from.y + " L " + to.x + " " + to.y;
    }
    edgeGroup.appendChild(
      svgElement("path", {
        d: path,
        class: edge.resolved ? "edge" : "edge unresolved",
      })
    );
  });
  canvas.appendChild(edgeGroup);

  var shapes = {};
  var nodeGroup = svgElement("g", {});
  nodes.forEach(function (node) {
    var position = positions[node.id];
    var group = svgElement("g", {
      class: node.exported ? "node" : "node unresolved",
      tabindex: "0",
      role: "button",
      "aria-label": label(node) + " " + node.id,
    });
    var title = svgElement("title", {});
    title.textContent = label(node) + "\n" + node.id;
    group.appendChild(title);
    group.appendChild(
      svgElement("circle", { cx: position.x, cy: position.y, r: nodeRadius })
    );
    var caption = svgElement("text", {
      x: position.x,
      y: position.y + nodeRadius + 14,
    });
    caption.textContent = shorten(label(node));
    group.appendChild(caption);
    group.addEventListener("click", function () {
      select(node.id);
    });
    group.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(node.id);
      }
    });
    shapes[node.id] = group;
    nodeGroup.appendChild(group);
  });
  canvas.appendChild(nodeGroup);

  var list = document.getElementById("node-list");
  var details = document.getElementById("details");
  var buttons = {};
  nodes.forEach(function (node) {
    var item = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.appendChild(element("span", "node-label", label(node)));
    button.appendChild(
      element(
        "span",
        "node-meta",
        node.scope === null ? node.id.slice(0, 8) : node.scope
      )
    );
    button.addEventListener("click", function () {
      select(node.id);
    });
    buttons[node.id] = button;
    item.appendChild(button);
    list.appendChild(item);
  });

  function section(title) {
    var wrapper = element("section", "detail-section");
    wrapper.appendChild(element("h3", null, title));
    return wrapper;
  }

  function addField(container, name, value) {
    var row = element("div", "field");
    row.appendChild(element("span", "field-name", name));
    row.appendChild(element("pre", "field-value", value));
    container.appendChild(row);
  }

  function formatList(values) {
    return values.length === 0 ? "none" : values.join(", ");
  }

  function addMetadata(container, name, metadata) {
    if (metadata === null || metadata === undefined) {
      addField(container, name, "none");
      return;
    }
    var keys = Object.keys(metadata);
    if (keys.length === 0) {
      addField(container, name, "none");
      return;
    }
    addField(
      container,
      name,
      keys
        .map(function (key) {
          return key + ": " + JSON.stringify(metadata[key]);
        })
        .join("\n")
    );
  }

  function addLinkList(container, noteIds) {
    if (noteIds.length === 0) {
      container.appendChild(element("p", "muted", "none"));
      return;
    }
    var listElement = element("ul", "link-list");
    noteIds.forEach(function (id) {
      var target = byLowerId[id.toLowerCase()];
      var item = document.createElement("li");
      if (target === undefined) {
        item.textContent = id + " (not exported)";
      } else {
        var button = document.createElement("button");
        button.type = "button";
        button.appendChild(
          element(
            "span",
            null,
            label(target) + (target.exported ? "" : " (not exported)")
          )
        );
        button.appendChild(element("span", "node-meta", target.id));
        button.title = target.id;
        button.addEventListener("click", function () {
          select(target.id);
        });
        item.appendChild(button);
      }
      listElement.appendChild(item);
    });
    container.appendChild(listElement);
  }

  function show(node) {
    details.textContent = "";
    details.appendChild(element("h2", "detail-title", label(node)));
    details.appendChild(element("p", "muted", "Stored note ID: " + node.id));
    if (!node.exported) {
      details.appendChild(
        element(
          "p",
          "warning",
          "notes.jsonl did not export this note; it is shown because another note links to it."
        )
      );
    }

    var provenance = section("Labels and provenance");
    if (node.scope !== null) {
      addField(provenance, "Scope label", node.scope);
    }
    if (node.source !== null) {
      addField(provenance, "Source ID", node.source.sourceId);
      addField(provenance, "Source outcome", node.source.outcome);
      addField(
        provenance,
        "Source timestamp",
        node.source.timestamp === null ? "none" : node.source.timestamp
      );
      addMetadata(provenance, "Source metadata", node.source.metadata);
    }
    if (node.note !== null) {
      addField(provenance, "Note timestamp", node.note.timestamp);
      addMetadata(
        provenance,
        "Note metadata",
        node.note.metadata === undefined ? null : node.note.metadata
      );
    }
    details.appendChild(provenance);

    var original = section("Original content");
    var content =
      node.note !== null
        ? node.note.content
        : node.source !== null
          ? node.source.content
          : null;
    original.appendChild(
      element("pre", "content", content === null ? "unavailable" : content)
    );
    details.appendChild(original);

    var current = section("Current context and attributes");
    if (node.note === null) {
      current.appendChild(
        element(
          "p",
          "muted",
          "The run did not export this note's current attributes."
        )
      );
    } else {
      addField(current, "Context", node.note.context);
      addField(current, "Keywords", formatList(node.note.keywords));
      addField(current, "Tags", formatList(node.note.tags));
    }
    details.appendChild(current);

    var comparison = section("Construction versus final");
    if (node.construction === null) {
      comparison.appendChild(
        element(
          "p",
          "muted",
          "The run recorded no construction snapshot for this note."
        )
      );
    } else if (node.note === null) {
      comparison.appendChild(
        element(
          "p",
          "muted",
          "Construction attributes were recorded, but the current note was not exported."
        )
      );
      addField(comparison, "Context", node.construction.context);
      addField(comparison, "Keywords", formatList(node.construction.keywords));
      addField(comparison, "Tags", formatList(node.construction.tags));
    } else {
      var table = element("table", "comparison");
      var head = document.createElement("tr");
      head.appendChild(element("th", null, "Attribute"));
      head.appendChild(element("th", null, "Construction"));
      head.appendChild(element("th", null, "Final"));
      table.appendChild(head);
      [
        ["Context", node.construction.context, node.note.context],
        [
          "Keywords",
          formatList(node.construction.keywords),
          formatList(node.note.keywords),
        ],
        ["Tags", formatList(node.construction.tags), formatList(node.note.tags)],
      ].forEach(function (row) {
        var line = document.createElement("tr");
        line.appendChild(element("th", null, row[0]));
        line.appendChild(element("td", null, row[1]));
        line.appendChild(element("td", null, row[2]));
        table.appendChild(line);
      });
      comparison.appendChild(table);
    }
    details.appendChild(comparison);

    var links = section("Stored links");
    links.appendChild(
      element("p", "muted", "Outgoing (links this note stores)")
    );
    addLinkList(links, node.links);
    links.appendChild(
      element("p", "muted", "Incoming (notes that store a link to this note)")
    );
    addLinkList(links, node.incoming);
    details.appendChild(links);
  }

  function select(id) {
    Object.keys(shapes).forEach(function (key) {
      shapes[key].classList.toggle("selected", key === id);
    });
    Object.keys(buttons).forEach(function (key) {
      buttons[key].classList.toggle("selected", key === id);
    });
    var node = byId[id];
    if (node !== undefined) {
      show(node);
    }
  }

  details.appendChild(
    element(
      "p",
      "muted",
      "Select a note in the canvas or the list to inspect its original content, current attributes, construction snapshot, labels and provenance."
    )
  );
})();
`;

/**
 * Render the self-contained report. Only the run summary is interpolated into the document; every
 * artifact value travels inside the escaped JSON payload and reaches the DOM as text.
 */
export const renderGraphHtml = (graph: InspectionGraph): string => {
  const finished =
    graph.run.finishedAt === null
      ? ""
      : ` · finished <code>${escapeHtml(graph.run.finishedAt)}</code>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Memory graph inspection - ${escapeHtml(graph.run.runId)}</title>
    <style>
${styles}
    </style>
  </head>
  <body>
    <header>
      <h1>Memory graph inspection</h1>
      <p class="summary">
        Run <code>${escapeHtml(graph.run.runId)}</code> (${escapeHtml(graph.run.status)}) · revision
        <code>${escapeHtml(graph.run.revision)}</code> · storage
        <code>${escapeHtml(graph.run.storage.kind)}/${escapeHtml(graph.run.storage.representation)}</code>
        · started <code>${escapeHtml(graph.run.startedAt)}</code>${finished}
      </p>
      <p class="counts">
        ${String(graph.counts.nodes)} nodes · ${String(graph.counts.links)} directed stored links ·
        ${String(graph.counts.unresolved)} unexported link targets ·
        ${String(graph.counts.sources)} supplied sources
      </p>
      <p class="note">
        Nodes are stored notes and edges are the directed links the notes store; no similarity edge
        is drawn and an evolution update is not a link. Layout positions carry no meaning. This graph
        is an inspection tool, not a quality score.
      </p>
      <noscript>
        <p class="note">
          This offline report needs JavaScript for its interactive layout; the same evidence is in
          graph.json.
        </p>
      </noscript>
    </header>
    <main>
      <nav id="node-list" aria-label="Notes"></nav>
      <section id="canvas-panel">
        <svg id="graph-canvas" role="img" aria-label="Stored notes and their directed links"></svg>
      </section>
      <section id="details" aria-live="polite"></section>
    </main>
    <script type="application/json" id="graph-data">${embedJson(graph)}</script>
    <script>
${clientScript}
    </script>
  </body>
</html>
`;
};
