/**
 * The service-backed inspection source: the host's only data path. It uses the documented service
 * client for note details, search and paginated stored vectors, keeps cursors opaque and reports
 * service failures as ordinary read failures, so the host never falls back to a direct database
 * client or a second encoder.
 *
 * See docs/dashboard.md#local-inspection-host and docs/service.md#api.
 */
import {
  createMemoryServiceClient,
  ServiceClientError,
} from "../service/client.js";
import type { Note, SearchOptions, SearchResult } from "../src/index.js";
import {
  InspectionInputError,
  type InspectionPage,
  type InspectionSource,
} from "./source.js";

export interface ServiceInspectionSourceOptions {
  /** The memory service base URL, for example `http://127.0.0.1:4748`. */
  readonly url: string;
  /** The whole-request timeout of every service call. */
  readonly timeoutMs?: number;
  /** Host cancellation for every service call. */
  readonly signal?: AbortSignal;
  /** A host fetch implementation; the global fetch by default. */
  readonly fetch?: typeof globalThis.fetch;
}

/** A request the service itself refuses as invalid is the browser caller's error. */
const translate = (cause: unknown): unknown =>
  cause instanceof ServiceClientError && cause.status === 400
    ? new InspectionInputError(cause)
    : cause;

/** Open the service-backed inspection source. */
export const openServiceInspectionSource = (
  options: ServiceInspectionSourceOptions,
): InspectionSource => {
  const client = createMemoryServiceClient(options);
  return {
    async identity() {
      try {
        const status = await client.status();
        return {
          collection: status.collection,
          embeddingSpaceId: status.embeddingSpace.id,
        };
      } catch (cause) {
        throw translate(cause);
      }
    },

    async pageEmbedded(
      limit: number,
      cursor?: string,
    ): Promise<InspectionPage> {
      try {
        const page = await client.inspectionRecords(limit, cursor);
        return {
          records: page.records,
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      } catch (cause) {
        throw translate(cause);
      }
    },

    async get(id: string): Promise<Note | undefined> {
      try {
        return await client.note(id);
      } catch (cause) {
        throw translate(cause);
      }
    },

    async search(
      query: string,
      searchOptions?: SearchOptions,
    ): Promise<SearchResult[]> {
      try {
        const outcome = await client.search(query, searchOptions);
        return outcome.results;
      } catch (cause) {
        throw translate(cause);
      }
    },
  };
};
