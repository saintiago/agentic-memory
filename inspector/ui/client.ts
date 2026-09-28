/**
 * The browser client of the local inspection API. It reads the served payloads, validates them
 * against the documented contracts and turns every failure into an explicit error instead of an
 * empty graph or an empty search result.
 *
 * See docs/dashboard.md#browser-api.
 */
import { z } from "zod";

import { noteSchema, type Note } from "../../src/note-store/index.js";
import { searchOutcomeSchema } from "../payloads.js";
import type { SearchOutcome, SearchRequest } from "./results.js";

/** A request the host refused, with its status and sanitized explanation. */
export class HostRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HostRequestError";
    this.status = status;
  }
}

/** One comparison of two stored vectors from the latest completed view. */
export const comparisonSchema = z.object({
  similarity: z.number(),
  capturedAt: z.iso.datetime({ offset: true }),
});

export type Comparison = z.infer<typeof comparisonSchema>;

/** The read, refresh and comparison operations of the inspection host. */
export interface InspectorClient {
  /** The raw `GET /api/graph` body; the worker parses and validates it off the main thread. */
  graphText(): Promise<string>;
  /** The current complete note, or `undefined` when the host reports 404. */
  note(nodeId: string): Promise<Note | undefined>;
  /** One real memory search through the host, in returned order. */
  search(request: SearchRequest): Promise<SearchOutcome>;
  /** Request one paginated inspection refresh. */
  refresh(): Promise<void>;
  /** Request a fresh fit on the next complete export. */
  rebuildProjection(): Promise<void>;
  /** Stored-vector cosine similarity of two displayed memories. */
  compare(leftId: string, rightId: string): Promise<Comparison>;
}

const errorBodySchema = z.object({ error: z.string() });

/** Read the sanitized failure text of one refused request. */
const failureMessage = async (
  response: Response,
  fallback: string,
): Promise<string> => {
  try {
    const parsed = errorBodySchema.safeParse(
      JSON.parse(await response.text()) as unknown,
    );
    return parsed.success ? parsed.data.error : fallback;
  } catch {
    return fallback;
  }
};

/** Create the client of the inspection host served from the same origin. */
export const createInspectorClient = (
  options: {
    readonly baseUrl?: string;
    readonly fetch?: typeof fetch;
  } = {},
): InspectorClient => {
  const baseUrl = options.baseUrl ?? "";
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const send = async (
    path: string,
    init: RequestInit,
    fallback: string,
  ): Promise<Response> => {
    const response = await request(`${baseUrl}${path}`, init);
    if (!response.ok) {
      throw new HostRequestError(
        response.status,
        await failureMessage(response, fallback),
      );
    }
    return response;
  };

  return {
    graphText: async (): Promise<string> => {
      const response = await send(
        "/api/graph",
        { method: "GET" },
        "The inspection host could not serve the graph.",
      );
      return response.text();
    },
    note: async (nodeId: string): Promise<Note | undefined> => {
      const response = await request(
        `${baseUrl}/api/notes/${encodeURIComponent(nodeId)}`,
        { method: "GET" },
      );
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new HostRequestError(
          response.status,
          await failureMessage(response, "The note could not be read."),
        );
      }
      const parsed = noteSchema.safeParse(
        JSON.parse(await response.text()) as unknown,
      );
      if (!parsed.success) {
        throw new HostRequestError(
          response.status,
          "The host returned a note that does not match the note contract.",
        );
      }
      return parsed.data;
    },
    search: async (searchRequest: SearchRequest): Promise<SearchOutcome> => {
      const response = await send(
        "/api/search",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(searchRequest),
        },
        "The search failed.",
      );
      const parsed = searchOutcomeSchema.safeParse(
        JSON.parse(await response.text()) as unknown,
      );
      if (!parsed.success) {
        throw new HostRequestError(
          response.status,
          "The host returned a search response that does not match the search contract.",
        );
      }
      return parsed.data;
    },
    refresh: async (): Promise<void> => {
      await send(
        "/api/refresh",
        { method: "POST" },
        "The refresh could not be requested.",
      );
    },
    rebuildProjection: async (): Promise<void> => {
      await send(
        "/api/projection/rebuild",
        { method: "POST" },
        "The projection rebuild could not be requested.",
      );
    },
    compare: async (leftId: string, rightId: string): Promise<Comparison> => {
      const response = await send(
        "/api/compare",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leftId, rightId }),
        },
        "The comparison failed.",
      );
      const parsed = comparisonSchema.safeParse(
        JSON.parse(await response.text()) as unknown,
      );
      if (!parsed.success) {
        throw new HostRequestError(
          response.status,
          "The host returned a comparison that does not match the comparison contract.",
        );
      }
      return parsed.data;
    },
  };
};
