/**
 * The failure vocabulary of the `/v1` API. One service failure carries the HTTP status, the
 * machine-readable error code and whether the caller may retry the identical request, so the HTTP
 * layer and the client agree without reading prose.
 *
 * See docs/service.md#api.
 */

/** The documented error codes of the service boundary. */
export const serviceErrorCodes = [
  "invalid-request",
  "not-found",
  "conflict",
  "payload-too-large",
  "overloaded",
  "unavailable",
  "internal",
] as const;

export type ServiceErrorCode = (typeof serviceErrorCodes)[number];

/** One failed service request, ready for the HTTP error mapping. */
export class ServiceFailure extends Error {
  readonly status: number;
  readonly code: ServiceErrorCode;
  readonly retryable: boolean;
  /** Present on `429` responses so the caller learns when a retry may succeed. */
  readonly retryAfterSeconds: number | undefined;

  constructor(options: {
    status: number;
    code: ServiceErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ServiceFailure";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** A request the service refuses because its input or transport does not satisfy the contract. */
export const invalidRequest = (
  message: string,
  cause?: unknown,
): ServiceFailure =>
  new ServiceFailure({
    status: 400,
    code: "invalid-request",
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });

/** A well-formed request for a record that does not exist. */
export const notFound = (message: string): ServiceFailure =>
  new ServiceFailure({
    status: 404,
    code: "not-found",
    message,
    retryable: false,
  });

/** A source key that already holds different input. */
export const conflict = (message: string): ServiceFailure =>
  new ServiceFailure({
    status: 409,
    code: "conflict",
    message,
    retryable: false,
  });

/** A request body above the configured limit. */
export const payloadTooLarge = (message: string): ServiceFailure =>
  new ServiceFailure({
    status: 413,
    code: "payload-too-large",
    message,
    retryable: false,
  });

/** Temporary overload: the bounded work queue is full and the caller should retry later. */
export const overloaded = (retryAfterSeconds: number): ServiceFailure =>
  new ServiceFailure({
    status: 429,
    code: "overloaded",
    message: "The memory service is temporarily overloaded; retry later.",
    retryable: true,
    retryAfterSeconds,
  });

/** A capability that is not available right now, with a safe diagnostic. */
export const unavailable = (message: string, cause?: unknown): ServiceFailure =>
  new ServiceFailure({
    status: 503,
    code: "unavailable",
    message,
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });

/** An unexpected failure whose detail stays in the service's own diagnostics. */
export const internal = (cause?: unknown): ServiceFailure =>
  new ServiceFailure({
    status: 500,
    code: "internal",
    message: "The memory service could not serve the request.",
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
