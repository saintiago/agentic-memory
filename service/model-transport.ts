/**
 * The local memory service's model transport: an OpenAI-compatible chat-completions client that
 * implements the public LanguageModel contract. The supervising host supplies the endpoint, model,
 * output budget, timeout and credentials; the library never constructs a provider, and
 * [examples/host-model-transport.ts](../examples/host-model-transport.ts) re-exports this
 * implementation for host composition examples. Copy, adapt or replace it per deployment.
 *
 * The transport sends the assembled request unchanged and returns parsed JSON. It rejects timeout,
 * cancellation, provider errors, length-truncated output and invalid JSON instead of transforming
 * a failure into an empty success. Structurally invalid JSON is still returned to the caller,
 * whose response schema decides whether the proposed memory update is valid.
 *
 * See docs/language-model.md#transport-behavior.
 */
import { z } from "zod";

import {
  ModelRequestError,
  type LanguageModel,
  type ModelFailureCategory,
  type ModelRequest,
} from "../src/index.js";

/**
 * Whether the platform can send this credential unchanged in the `authorization` header.
 * Reject normalization as well as invalid values: diagnostics must redact the same credential
 * that was transmitted, and fetch's header-value failures can themselves expose unusable keys.
 */
const isBearerHeaderValue = (apiKey: string): boolean => {
  try {
    const authorization = `Bearer ${apiKey}`;
    const headers = new Headers({ authorization });
    return headers.get("authorization") === authorization;
  } catch {
    return false;
  }
};

const optionsSchema = z.strictObject({
  /**
   * Full chat-completions URL, for example https://api.deepseek.com/chat/completions. Credentials
   * belong in `apiKey`; an embedded userinfo credential is rejected without being echoed because
   * fetch cannot send such a URL.
   */
  endpoint: z.url().refine((endpoint) => {
    const url = new URL(endpoint);
    return url.username === "" && url.password === "";
  }, "An endpoint must not embed credentials; supply them as the API key."),
  /** Provider model ID; the host records the exact value it invoked. */
  model: z.string().min(1),
  /**
   * Provider credential; omitted for an unauthenticated local gateway. A value the platform cannot
   * send unchanged as an `authorization` header is rejected without being echoed.
   */
  apiKey: z
    .string()
    .min(1, "An API key must be nonempty.")
    .refine(
      isBearerHeaderValue,
      "An API key must be a valid HTTP header value that requires no normalization.",
    )
    .optional(),
  /** Finite request timeout in milliseconds. */
  timeoutMs: z.number().int().positive(),
  /** Provider output-token budget for a single request. */
  maxOutputTokens: z.number().int().positive(),
  /** Host cancellation signal, combined with the transport timeout. */
  signal: z
    .custom<AbortSignal>((value) => value instanceof AbortSignal)
    .optional(),
  /**
   * Fetch implementation. A host injects one to record raw exchanges for evaluation; the default
   * is the global fetch and never carries a provider dependency into the library.
   */
  fetch: z
    .custom<typeof globalThis.fetch>(
      (value) => typeof value === "function",
      "A fetch implementation must be a function.",
    )
    .optional(),
});

/** Host settings for the example transport. */
export type HostModelTransportOptions = z.infer<typeof optionsSchema>;

/**
 * A transport failure carrying the memory stage, the machine-readable failure category and a safe
 * diagnostic. Provider and fetch failures are untrusted text that may echo request headers, so
 * every diagnostic is redacted and no raw provider or fetch cause is attached.
 */
export class HostModelTransportError extends ModelRequestError {
  constructor(
    stage: ModelRequest["stage"],
    category: ModelFailureCategory,
    reason: string,
  ) {
    super(stage, category, reason);
    this.name = "HostModelTransportError";
  }
}

/**
 * The category of an answered non-success response: a rejected credential, a missing provider
 * resource, or a temporary provider outage the host may retry later.
 */
const statusCategory = (status: number): ModelFailureCategory =>
  status === 401 || status === 403
    ? "authentication"
    : status === 404
      ? "resource"
      : "unavailable";

/** Provider diagnostics stay short and never include the configured credential. */
const MAX_DIAGNOSTIC_LENGTH = 300;

/**
 * Remove every credential form an untrusted provider or fetch diagnostic can echo: the value
 * itself, the authorization header the transport sent, and JSON-escaped copies (including JSON
 * nested in provider message content). Redaction runs before shortening, so truncation cannot
 * leave part of a credential behind.
 */
export const redactCredential = (
  text: string,
  apiKey: string | undefined,
): string => {
  if (apiKey === undefined || apiKey === "") {
    return text;
  }
  const forms: string[] = [];
  for (let form = apiKey; form.length <= text.length;) {
    forms.push(form);
    const escaped = JSON.stringify(form).slice(1, -1);
    if (escaped === form) break;
    form = escaped;
  }
  // Longest first: replacing a shorter form must not leave part of its escaped copy behind.
  for (const form of forms.reverse()) {
    text = text
      .replaceAll(`Bearer ${form}`, "[redacted]")
      .replaceAll(form, "[redacted]");
  }
  return text;
};

const summarize = (text: string): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_DIAGNOSTIC_LENGTH
    ? `${collapsed.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : collapsed;
};

/** Shorten untrusted provider or fetch text after removing the configured credential from it. */
const diagnostic = (text: string, apiKey: string | undefined): string =>
  summarize(redactCredential(text, apiKey));

const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });

const providerFailureDetail = (
  bodyText: string,
  apiKey: string | undefined,
): string => {
  const trimmed = bodyText.trim();
  if (trimmed === "") {
    return "";
  }
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(trimmed));
    if (parsed.success) {
      return `: ${diagnostic(parsed.data.error.message, apiKey)}`;
    }
  } catch {
    // A non-JSON body is summarized as it was received.
  }
  return `: ${diagnostic(trimmed, apiKey)}`;
};

const completionSchema = z.object({
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable(),
      message: z.object({ content: z.string().nullable() }),
    }),
  ),
});

/**
 * Remove one optional outer Markdown JSON fence. Only a fence wrapping the whole output is
 * removed; an otherwise invalid answer is never searched for a JSON-looking fragment.
 */
const unfence = (output: string): string => {
  const trimmed = output.trim();
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
};

const parseModelOutput = (
  stage: ModelRequest["stage"],
  output: string,
): unknown => {
  try {
    return JSON.parse(unfence(output));
  } catch {
    throw new HostModelTransportError(
      stage,
      "output",
      "the model returned output that is not valid JSON",
    );
  }
};

const describeFetchFailure = (
  cause: unknown,
  timeoutMs: number,
  apiKey: string | undefined,
): string => {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") {
      return `the provider did not answer within ${timeoutMs} ms`;
    }
    if (cause.name === "AbortError") {
      return "the request was cancelled";
    }
    return `the request could not reach the provider (${diagnostic(
      cause.message,
      apiKey,
    )})`;
  }
  return "the request could not reach the provider";
};

/**
 * Create the example LanguageModel implementation. Every operational setting is required and
 * supplied by the host; there are no implicit retries.
 */
export const createHostModelTransport = (
  options: HostModelTransportOptions,
): LanguageModel => {
  const { endpoint, model, apiKey, timeoutMs, maxOutputTokens, signal, fetch } =
    optionsSchema.parse(options);
  const send = fetch ?? globalThis.fetch;

  return {
    async generate(request: ModelRequest): Promise<unknown> {
      // The timeout starts when the request is sent, not when the host builds the transport.
      const timeout = AbortSignal.timeout(timeoutMs);
      const abort =
        signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (apiKey !== undefined) {
        headers.authorization = `Bearer ${apiKey}`;
      }

      let response: Response;
      try {
        response = await send(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: request.prompt }],
            max_tokens: maxOutputTokens,
          }),
          signal: abort,
        });
      } catch (cause) {
        throw new HostModelTransportError(
          request.stage,
          "unavailable",
          describeFetchFailure(cause, timeoutMs, apiKey),
        );
      }

      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch {
        throw new HostModelTransportError(
          request.stage,
          "unavailable",
          "the provider response body could not be read",
        );
      }

      if (!response.ok) {
        throw new HostModelTransportError(
          request.stage,
          statusCategory(response.status),
          `the provider answered HTTP ${response.status}${providerFailureDetail(
            bodyText,
            apiKey,
          )}`,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        throw new HostModelTransportError(
          request.stage,
          "output",
          "the provider response body is not JSON",
        );
      }

      const completion = completionSchema.safeParse(payload);
      if (!completion.success) {
        throw new HostModelTransportError(
          request.stage,
          "output",
          "the provider response is not a chat completion",
        );
      }

      const choice = completion.data.choices[0];
      if (choice === undefined) {
        throw new HostModelTransportError(
          request.stage,
          "output",
          "the provider response contains no completion choice",
        );
      }
      if (choice.finish_reason !== "stop") {
        throw new HostModelTransportError(
          request.stage,
          "output",
          `the provider stopped before finishing (finish reason ${JSON.stringify(
            choice.finish_reason === null
              ? null
              : diagnostic(choice.finish_reason, apiKey),
          )})`,
        );
      }
      if (choice.message.content === null) {
        throw new HostModelTransportError(
          request.stage,
          "output",
          "the provider response contains no message content",
        );
      }
      return parseModelOutput(request.stage, choice.message.content);
    },
  };
};
