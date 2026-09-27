/**
 * Raw provider exchange recording for live runs: a fetch wrapper that keeps the request body, the
 * response body and the provider-reported usage, finish reason and request ID for each HTTP call.
 * The instrumented model reads the exchanges of its own call; the transport stays unchanged.
 *
 * See docs/language-model.md#transport-behavior and docs/evaluation.md#run-artifacts.
 */
import type { TokenUsage } from "../replay/artifacts.js";
import type { ExchangeLog, ModelExchange } from "../replay/recorder.js";

/** An exchange log the recording fetch appends to and the model instrumentation reads. */
export class RecordedExchanges implements ExchangeLog {
  readonly entries: ModelExchange[] = [];

  push(exchange: ModelExchange): void {
    this.entries.push(exchange);
  }

  index(): number {
    return this.entries.length;
  }

  since(index: number): ModelExchange[] {
    return this.entries.slice(index);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberAt = (value: unknown, key: string): number | null => {
  if (!isObject(value)) {
    return null;
  }
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
};

interface ProviderDetails {
  usage: TokenUsage | null;
  finishReason: string | null;
  requestId: string | null;
}

/**
 * Read an OpenAI-compatible chat-completions body. A provider that reports usage differently keeps
 * unknown values unknown instead of inventing token counts.
 */
export const readProviderDetails = (body: string): ProviderDetails => {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { usage: null, finishReason: null, requestId: null };
  }
  if (!isObject(payload)) {
    return { usage: null, finishReason: null, requestId: null };
  }
  const usage = isObject(payload["usage"]) ? payload["usage"] : null;
  const details = isObject(usage?.["prompt_tokens_details"])
    ? usage["prompt_tokens_details"]
    : null;
  const choices = Array.isArray(payload["choices"]) ? payload["choices"] : [];
  const first = choices[0];
  const finishReason = isObject(first)
    ? typeof first["finish_reason"] === "string"
      ? first["finish_reason"]
      : null
    : null;
  return {
    usage:
      usage === null
        ? null
        : {
            inputTokens: numberAt(usage, "prompt_tokens"),
            cachedInputTokens: numberAt(details, "cached_tokens"),
            outputTokens: numberAt(usage, "completion_tokens"),
          },
    finishReason,
    requestId: typeof payload["id"] === "string" ? payload["id"] : null,
  };
};

/**
 * Wrap a fetch implementation so every exchange is recorded before the transport reads it. The
 * original response is returned with its body unread, so the host transport behaves identically.
 */
export const createRecordingFetch = (options: {
  exchanges: { push(exchange: ModelExchange): void };
  fetch?: typeof globalThis.fetch;
  /** Keep request and response bodies; usage is read either way. Defaults to true. */
  keepBodies?: boolean;
}): typeof globalThis.fetch => {
  const send = options.fetch ?? globalThis.fetch;
  const keepBodies = options.keepBodies ?? true;
  return async (input, init) => {
    const requestBody =
      keepBodies && typeof init?.body === "string" ? init.body : "";
    const response = await send(input, init);
    let responseBody = "";
    try {
      responseBody = await response.clone().text();
    } catch {
      // An unreadable body stays empty, so the usage of this exchange remains unknown.
    }
    const details = readProviderDetails(responseBody);
    options.exchanges.push({
      requestBody,
      // Usage, finish reason and request ID are parsed first; the raw body is retained only when
      // the host opted in, so the default run keeps no private provider text in memory.
      responseBody: keepBodies ? responseBody : "",
      status: response.status,
      usage: details.usage,
      finishReason: details.finishReason,
      requestId: details.requestId,
    });
    return response;
  };
};
