/**
 * The client boundary of the local memory service: a typed, validated HTTP client for the
 * documented `/v1` API. It keeps cursors opaque, maps a missing record to `undefined`, validates
 * every served body against the owned schema and reports one typed failure for everything else,
 * so a consumer distinguishes invalid input, missing records, unavailability and transport
 * failure without reading prose.
 *
 * See docs/service.md#api and docs/service.md#configuration-and-local-access.
 */
import type { z } from "zod";

import type {
  QueueObservation,
  QueueReceipt,
} from "../src/ingestion-queue/index.js";
import type { SearchOptions } from "../src/memory/index.js";
import { noteSchema, type Note } from "../src/note-store/index.js";
import {
  inspectionPageSchema,
  notesPageSchema,
  receiptSchema,
  searchResponseSchema,
  serviceErrorSchema,
  serviceStatusSchema,
  type InspectionPage,
  type NotesPage,
  type SearchResponse,
  type ServiceStatus,
} from "./schemas.js";

/** One accepted observation, with whether this submission created the receipt. */
export interface ServiceSubmission {
  readonly receipt: QueueReceipt;
  readonly created: boolean;
}

/** One failed client request: the HTTP status when there was one, the error code and its retryability. */
export class ServiceClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ServiceClientError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

/** The documented operations of the service API. */
export interface MemoryServiceClient {
  submit(observation: QueueObservation): Promise<ServiceSubmission>;
  receipt(id: string): Promise<QueueReceipt | undefined>;
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
  note(id: string): Promise<Note | undefined>;
  /** Inspect one page; the opaque cursor is the token of a previous response, returned unchanged. */
  notes(limit?: number, cursor?: string): Promise<NotesPage>;
  /** Export one page; the opaque cursor is the token of a previous response, unchanged. */
  inspectionRecords(limit?: number, cursor?: string): Promise<InspectionPage>;
  status(): Promise<ServiceStatus>;
}

export interface MemoryServiceClientOptions {
  /** The service base URL, for example `http://127.0.0.1:4748`. */
  readonly url: string;
  /** The whole-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** A host cancellation signal, combined with the timeout. */
  readonly signal?: AbortSignal;
  /** A host fetch implementation; the global fetch by default. */
  readonly fetch?: typeof globalThis.fetch;
}

const defaultTimeoutMs = 120_000;

const baseUrlOf = (url: string): string => {
  const trimmed = url.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("The memory service URL must be a valid absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The memory service URL must use http or https.");
  }
  return trimmed;
};

interface RequestOptions {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  /** The schema of a success body; `undefined` accepts an empty success. */
  readonly schema?: z.ZodType;
  /** Whether a `404` is a normal absence rather than a failure. */
  readonly notFoundAsUndefined?: boolean;
}

/** The status and raw body of one accepted response. */
interface ServiceResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Create one client. The URL is validated immediately; every request validates its response body
 * and reports a transport, protocol or service failure as a `ServiceClientError`.
 */
export const createMemoryServiceClient = (
  options: MemoryServiceClientOptions,
): MemoryServiceClient => {
  const base = baseUrlOf(options.url);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "The memory service timeout must be a positive safe integer.",
    );
  }
  const send = options.fetch ?? globalThis.fetch;

  const request = async (
    options_: RequestOptions,
  ): Promise<ServiceResponse | undefined> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const abort =
      options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await send(`${base}${options_.path}`, {
        method: options_.method,
        headers: {
          accept: "application/json",
          ...(options_.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(options_.body === undefined
          ? {}
          : { body: JSON.stringify(options_.body) }),
        signal: abort,
      });
    } catch (cause) {
      throw new ServiceClientError({
        status: 0,
        code: "unreachable",
        message: "The memory service could not be reached.",
        retryable: true,
        cause,
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new ServiceClientError({
        status: response.status,
        code: "unreachable",
        message:
          "The memory service response could not be received completely.",
        retryable: true,
        cause,
      });
    }
    if (response.status === 404 && options_.notFoundAsUndefined === true) {
      return undefined;
    }
    if (!response.ok) {
      let code = "unknown";
      let message = "The memory service answered with an unexpected failure.";
      let retryable = response.status >= 500;
      try {
        const parsed = serviceErrorSchema.safeParse(
          JSON.parse(text) as unknown,
        );
        if (parsed.success) {
          code = parsed.data.error.code;
          message = parsed.data.error.message;
          retryable = parsed.data.error.retryable;
        }
      } catch {
        // A non-JSON failure body keeps the generic sanitized message.
      }
      throw new ServiceClientError({
        status: response.status,
        code,
        message,
        retryable,
      });
    }
    if (options_.schema === undefined) {
      return undefined;
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new ServiceClientError({
        status: response.status,
        code: "invalid-response",
        message: "The memory service answered with a body that is not JSON.",
        retryable: false,
        cause,
      });
    }
    const parsed = options_.schema.safeParse(body);
    if (!parsed.success) {
      throw new ServiceClientError({
        status: response.status,
        code: "invalid-response",
        message:
          "The memory service answered outside its documented response contract.",
        retryable: false,
        cause: parsed.error,
      });
    }
    return { status: response.status, body: parsed.data };
  };

  const query = (
    limit: number | undefined,
    cursor: string | undefined,
  ): string => {
    const parameters = new URLSearchParams();
    if (limit !== undefined) {
      parameters.set("limit", String(limit));
    }
    if (cursor !== undefined) {
      parameters.set("cursor", cursor);
    }
    const suffix = parameters.toString();
    return suffix === "" ? "" : `?${suffix}`;
  };

  return {
    async submit(observation) {
      const response = await request({
        method: "POST",
        path: "/v1/observations",
        body: observation,
        schema: receiptSchema,
      });
      if (response === undefined) {
        throw new ServiceClientError({
          status: 404,
          code: "invalid-response",
          message:
            "The memory service did not answer the submission with a receipt.",
          retryable: false,
        });
      }
      const receipt = receiptSchema.parse(response.body);
      return { receipt, created: response.status === 202 };
    },

    async receipt(id) {
      const response = await request({
        method: "GET",
        path: `/v1/receipts/${encodeURIComponent(id)}`,
        schema: receiptSchema,
        notFoundAsUndefined: true,
      });
      return response === undefined
        ? undefined
        : receiptSchema.parse(response.body);
    },

    async search(text, searchOptions = {}) {
      const response = await request({
        method: "POST",
        path: "/v1/search",
        body: {
          query: text,
          ...(searchOptions.limit === undefined
            ? {}
            : { limit: searchOptions.limit }),
          ...(searchOptions.linkedLimit === undefined
            ? {}
            : { linkedLimit: searchOptions.linkedLimit }),
        },
        schema: searchResponseSchema,
      });
      if (response === undefined) {
        throw new ServiceClientError({
          status: 404,
          code: "invalid-response",
          message: "The memory service did not answer the search request.",
          retryable: false,
        });
      }
      return searchResponseSchema.parse(response.body);
    },

    async note(id) {
      const response = await request({
        method: "GET",
        path: `/v1/notes/${encodeURIComponent(id)}`,
        schema: noteSchema,
        notFoundAsUndefined: true,
      });
      return response === undefined
        ? undefined
        : noteSchema.parse(response.body);
    },

    async notes(limit, cursor) {
      const response = await request({
        method: "GET",
        path: `/v1/notes${query(limit, cursor)}`,
        schema: notesPageSchema,
      });
      if (response === undefined) {
        throw new ServiceClientError({
          status: 404,
          code: "invalid-response",
          message: "The memory service did not answer the page request.",
          retryable: false,
        });
      }
      return notesPageSchema.parse(response.body);
    },

    async inspectionRecords(limit, cursor) {
      const response = await request({
        method: "GET",
        path: `/v1/inspection/records${query(limit, cursor)}`,
        schema: inspectionPageSchema,
      });
      if (response === undefined) {
        throw new ServiceClientError({
          status: 404,
          code: "invalid-response",
          message: "The memory service did not answer the inspection request.",
          retryable: false,
        });
      }
      return inspectionPageSchema.parse(response.body);
    },

    async status() {
      const response = await request({
        method: "GET",
        path: "/v1/status",
        schema: serviceStatusSchema,
      });
      if (response === undefined) {
        throw new ServiceClientError({
          status: 404,
          code: "invalid-response",
          message: "The memory service did not answer the status request.",
          retryable: false,
        });
      }
      return serviceStatusSchema.parse(response.body);
    },
  };
};
