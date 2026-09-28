/**
 * The display view the browser polls: displayed notes at their projected positions, the directed
 * links between displayed endpoints, freshness evidence and the identity of the projection the
 * coordinates belong to. The host serves display data, never stored vectors or provider settings.
 * The served shapes themselves live in [payloads](payloads.ts).
 *
 * See docs/dashboard.md#browser-api.
 */
import type { Note } from "../src/note-store/index.js";
import type { ProjectionArtifact } from "./projection.js";
import type { GraphView } from "./payloads.js";

export * from "./payloads.js";

/** The label length of one node; the full note stays available through the detail route. */
export const shortLabelLength = 64;

/** Collapse a note's source text to a short single-line label. */
export const shortLabel = (content: string): string => {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length <= shortLabelLength
    ? collapsed
    : `${collapsed.slice(0, shortLabelLength - 1)}\u2026`;
};

/**
 * A degenerate extent would leave the browser without a normalization box, so a single point (or
 * a perfectly aligned corpus) keeps a small non-empty extent around its position. An empty export
 * has no position to plot and keeps the same unit extent around the origin.
 */
const extent = (values: readonly number[]): [number, number] => {
  if (values.length === 0) {
    return [-0.5, 0.5];
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return minimum === maximum
    ? [minimum - 0.5, maximum + 0.5]
    : [minimum, maximum];
};

/**
 * Build the display view from one completed export and its projection. Every exported note has a
 * coordinate; a link becomes an edge only when its target is displayed, and an unresolved target
 * stays visible in the note's own detail instead of being invented as a positioned node.
 */
export const buildGraphView = (options: {
  readonly capturedAt: string;
  readonly embeddingSpaceId: string;
  readonly projection: ProjectionArtifact;
  readonly notes: readonly Note[];
}): GraphView => {
  const coordinates = new Map(
    options.projection.coordinates.map((point) => [
      point.id.toLowerCase(),
      point,
    ]),
  );
  const displayed = new Map(
    options.notes.map((note) => [note.id.toLowerCase(), note.id]),
  );
  const nodes = options.notes.map((note) => {
    const point = coordinates.get(note.id.toLowerCase());
    if (point === undefined) {
      throw new Error(
        `The projection has no coordinate for the exported note ${note.id}.`,
      );
    }
    return {
      id: note.id,
      label: shortLabel(note.content),
      x: point.x,
      y: point.y,
      ...(note.updatedAt === undefined ? {} : { updatedAt: note.updatedAt }),
    };
  });
  const edges = options.notes.flatMap((note) =>
    note.links.flatMap((link) => {
      const target = displayed.get(link.toLowerCase());
      return target === undefined ? [] : [{ source: note.id, target }];
    }),
  );
  return {
    capturedAt: options.capturedAt,
    embeddingSpaceId: options.embeddingSpaceId,
    projectionId: options.projection.projectionId,
    layout: options.projection.layout,
    bounds: {
      x: extent(nodes.map((node) => node.x)),
      y: extent(nodes.map((node) => node.y)),
    },
    nodes,
    edges,
  };
};
