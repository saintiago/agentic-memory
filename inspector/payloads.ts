/**
 * The served browser payload contracts of the local inspection host: the graph snapshot of
 * `GET /api/graph` and the search response of `POST /api/search`. Each shape is defined once, so
 * the host sends what it validates and the browser validates what it receives. The module stays
 * free of Node and provider imports because the browser bundle includes it.
 *
 * See docs/dashboard.md#browser-api.
 */
import { z } from "zod";

import { noteIdSchema, noteSchema } from "../src/note-store/index.js";

/** One displayed memory: stable identity, short label, projected position and update evidence. */
export const graphNodeSchema = z.object({
  id: noteIdSchema,
  label: z.string(),
  x: z.number(),
  y: z.number(),
  /** The persisted update time, omitted while the historical update time is unknown. */
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;

/** One stored outgoing link between two displayed notes; direction is the stored direction. */
export const graphEdgeSchema = z.object({
  source: noteIdSchema,
  target: noteIdSchema,
});

export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/** The plotted extent of the projected coordinates. */
export const graphBoundsSchema = z.object({
  x: z.tuple([z.number(), z.number()]),
  y: z.tuple([z.number(), z.number()]),
});

export type GraphBounds = z.infer<typeof graphBoundsSchema>;

/** One completed graph view. */
export const graphViewSchema = z.object({
  /** Export completion time, not an atomic snapshot time of the collection. */
  capturedAt: z.iso.datetime({ offset: true }),
  embeddingSpaceId: z.string(),
  projectionId: z.string(),
  layout: z.enum(["umap", "non-semantic"]),
  bounds: graphBoundsSchema,
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
});

export type GraphView = z.infer<typeof graphViewSchema>;

/** The `GET /api/graph` response: a completed view, a pending first view, or a failure. */
export const graphSnapshotSchema = z.object({
  status: z.enum(["loading", "ready", "error"]),
  refreshing: z.boolean(),
  /** A sanitized refresh failure kept next to the last successful view until one succeeds. */
  error: z.string().optional(),
  view: graphViewSchema.optional(),
});

export type GraphSnapshot = z.infer<typeof graphSnapshotSchema>;

/**
 * The `POST /api/search` response: the request time and the public `SearchResult[]` shape
 * unchanged. Only direct matches carry a retrieval score.
 */
export const searchOutcomeSchema = z.object({
  searchedAt: z.iso.datetime({ offset: true }),
  results: z.array(
    z.union([
      z.object({
        note: noteSchema,
        via: z.literal("match"),
        score: z.number(),
      }),
      z.object({ note: noteSchema, via: z.literal("link") }),
    ]),
  ),
});

export type SearchOutcome = z.infer<typeof searchOutcomeSchema>;
