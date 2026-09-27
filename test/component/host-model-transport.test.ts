import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHostModelTransport,
  HostModelTransportError,
} from "../../examples/host-model-transport.js";
import type { HostModelTransportOptions } from "../../examples/host-model-transport.js";
import {
  ModelResponseError,
  readConstructionResponse,
} from "../../src/index.js";

/** docs/language-model.md#transport-behavior and #verification */

type FetchInput = Parameters<typeof globalThis.fetch>[0];

type FetchStub = (input: FetchInput, init?: RequestInit) => Promise<Response>;

interface RecordedCall {
  readonly input: FetchInput;
  readonly init: RequestInit | undefined;
}

/** Record the outgoing request while a controlled fixture answers it. */
const controlledFetch = (
  handler: FetchStub,
): { calls: RecordedCall[]; fetch: typeof globalThis.fetch } => {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetch: (input, init) => {
      calls.push({ input, init });
      return handler(input, init);
    },
  };
};

const settings = (
  overrides: Partial<HostModelTransportOptions> = {},
): HostModelTransportOptions => ({
  endpoint: "https://model.example/chat/completions",
  model: "example-model",
  apiKey: "host-secret-key",
  timeoutMs: 1_000,
  maxOutputTokens: 512,
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const completion = (content: string, finishReason = "stop") =>
  jsonResponse({
    choices: [{ finish_reason: finishReason, message: { content } }],
  });

const failure = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof Error) {
      return cause;
    }
    throw cause;
  }
  throw new Error("Expected the transport to reject.");
};

/** Capture a synchronous failure so its diagnostics can be inspected. */
const thrown = (act: () => unknown): Error => {
  try {
    act();
  } catch (cause) {
    if (cause instanceof Error) {
      return cause;
    }
    throw cause;
  }
  throw new Error("Expected the call to throw.");
};

/** Everything a host could log for a failure: message, stack, cause chain and own properties. */
const diagnostics = (error: unknown): string =>
  inspect(error, { depth: 5, getters: true });

afterEach(() => vi.restoreAllMocks());

describe("host model transport example", () => {
  it("sends the assembled prompt unchanged with the host settings", async () => {
    const { calls, fetch } = controlledFetch(async () =>
      completion('{"context":"c","keywords":["k"],"tags":["t"]}'),
    );
    const transport = createHostModelTransport(settings({ fetch }));
    const prompt = 'Instructions.\n\nEnvelope with {"content":"source"}.';

    const result = await transport.generate({ stage: "construct", prompt });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://model.example/chat/completions");
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer host-secret-key" }),
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "example-model",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 512,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ context: "c", keywords: ["k"], tags: ["t"] });
  });

  it("omits the authorization header when the host supplied no credential", async () => {
    const { calls, fetch } = controlledFetch(async () =>
      completion('{"context":"c","keywords":[],"tags":[]}'),
    );
    const transport = createHostModelTransport(
      settings({ fetch, apiKey: undefined }),
    );

    await transport.generate({ stage: "construct", prompt: "p" });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("uses the host's global fetch when no replacement is injected", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(completion('{"context":"c","keywords":[],"tags":[]}'));
    const transport = createHostModelTransport(settings({ apiKey: undefined }));

    await expect(
      transport.generate({ stage: "construct", prompt: "p" }),
    ).resolves.toEqual({ context: "c", keywords: [], tags: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports a provider error with the stage and without credentials", async () => {
    const { calls, fetch } = controlledFetch(async () =>
      jsonResponse({ error: { message: "Invalid API key" } }, 401),
    );
    const transport = createHostModelTransport(settings({ fetch }));

    const error = await failure(
      transport.generate({ stage: "evolve", prompt: "p" }),
    );

    expect(error).toBeInstanceOf(HostModelTransportError);
    expect((error as HostModelTransportError).stage).toBe("evolve");
    expect(error.message).toContain("HTTP 401");
    expect(error.message).toContain("Invalid API key");
    expect(String(error)).not.toContain("host-secret-key");
    expect(calls).toHaveLength(1);
  });

  it("redacts a credential echoed by a JSON provider error", async () => {
    const apiKey = "sk-review-synthetic-secret";
    const { fetch } = controlledFetch(async () =>
      jsonResponse(
        {
          error: {
            message: `Invalid key ${apiKey} for authorization: Bearer ${apiKey}`,
          },
        },
        401,
      ),
    );
    const transport = createHostModelTransport(settings({ fetch, apiKey }));

    const error = await failure(
      transport.generate({ stage: "construct", prompt: "p" }),
    );

    expect(error.message).toContain("HTTP 401");
    expect(error.message).toContain("[redacted]");
    expect(diagnostics(error)).not.toContain(apiKey);
  });

  it("redacts a credential echoed by a plain-text gateway error", async () => {
    const apiKey = "sk-review-synthetic-secret";
    const { fetch } = controlledFetch(
      async () =>
        new Response(`upstream rejected authorization: Bearer ${apiKey}`, {
          status: 502,
        }),
    );
    const transport = createHostModelTransport(settings({ fetch, apiKey }));

    const error = await failure(
      transport.generate({ stage: "evolve", prompt: "p" }),
    );

    expect(error.message).toContain("HTTP 502");
    expect(diagnostics(error)).not.toContain(apiKey);
  });

  it("redacts a credential before shortening a long diagnostic", async () => {
    const apiKey = "sk-review-synthetic-secret";
    const { fetch } = controlledFetch(
      async () =>
        new Response(`${"x".repeat(280)} Bearer ${apiKey} after`, {
          status: 502,
        }),
    );
    const transport = createHostModelTransport(settings({ fetch, apiKey }));

    const error = await failure(
      transport.generate({ stage: "construct", prompt: "p" }),
    );

    // The credential straddles the 300-character cutoff, so shortening first would leave a
    // credential prefix in the diagnostic.
    expect(error.message).toContain("HTTP 502");
    expect(error.message).not.toContain(apiKey.slice(0, 12));
    expect(diagnostics(error)).not.toContain(apiKey);
  });

  it("redacts a credential that a JSON body escapes instead of quoting", async () => {
    const apiKey = 'ho"st-review-secret';
    const { fetch } = controlledFetch(
      async () =>
        new Response(JSON.stringify({ detail: `Bearer ${apiKey}` }), {
          status: 500,
        }),
    );
    const transport = createHostModelTransport(settings({ fetch, apiKey }));

    const error = await failure(
      transport.generate({ stage: "construct", prompt: "p" }),
    );

    expect(error.message).toContain("HTTP 500");
    expect(diagnostics(error)).not.toContain(apiKey);
    expect(diagnostics(error)).not.toContain("st-review-secret");
  });

  it("redacts a credential echoed by a fetch failure and attaches no raw cause", async () => {
    const apiKey = "sk-review-synthetic-secret";
    const { fetch } = controlledFetch(async () => {
      const cause = new Error(
        `socket closed while sending authorization: Bearer ${apiKey}`,
      );
      cause.stack = `${cause.stack ?? ""}\n    at send (${apiKey})`;
      throw cause;
    });
    const transport = createHostModelTransport(settings({ fetch, apiKey }));

    const error = await failure(
      transport.generate({ stage: "construct", prompt: "p" }),
    );

    expect(error.message).toContain("could not reach the provider");
    expect(diagnostics(error)).not.toContain(apiKey);
  });

  it("rejects an API key that cannot be sent as a header value without echoing it", () => {
    // Node's fetch raises a TypeError naming the authorization header value for such a key, so the
    // transport rejects it before any request instead of copying that failure.
    const apiKey = "review-synthetic\nsecret";

    const error = thrown(() => createHostModelTransport(settings({ apiKey })));

    expect(error.message).toMatch(/valid HTTP header value/);
    expect(diagnostics(error)).not.toContain("review-synthetic");
  });

  it.each([" ", "\t", "\r", "\n", "\r\n", " \t\r\n"])(
    "rejects an API key with trailing %j that header normalization would change",
    (suffix) => {
      const secret = "sk-review-normalized-secret";
      const apiKey = `${secret}${suffix}`;
      // Use the platform's actual request normalization, not an imitation in the fetch stub.
      const request = new Request(settings().endpoint, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
      const { calls, fetch } = controlledFetch(async () =>
        jsonResponse({ error: { message: `Bearer ${secret}` } }, 401),
      );

      const error = thrown(() =>
        createHostModelTransport(settings({ apiKey, fetch })),
      );

      expect(error.message).toMatch(/valid HTTP header value/);
      expect(diagnostics(error)).not.toContain(secret);
      expect(error.cause).toBeUndefined();
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    "JSON error",
    "plain-text error",
    "fetch exception",
    "finish reason",
  ])("redacts the transmitted credential in a %s", async (path) => {
    const apiKey = "sk-transmitted-secret";
    const { fetch } = controlledFetch(async (input, init) => {
      const authorization = new Request(input, init).headers.get(
        "authorization",
      );
      expect(authorization).toBe(`Bearer ${apiKey}`);
      const echo = `Rejected authorization: ${authorization}`;
      switch (path) {
        case "JSON error":
          return jsonResponse({ error: { message: echo } }, 401);
        case "plain-text error":
          return new Response(echo, { status: 502 });
        case "fetch exception":
          throw new Error(echo);
        default:
          return completion("{}", echo);
      }
    });
    const transport = createHostModelTransport(settings({ apiKey, fetch }));

    const error = await failure(
      transport.generate({ stage: "evolve", prompt: "p" }),
    );

    expect(error).toBeInstanceOf(HostModelTransportError);
    expect((error as HostModelTransportError).stage).toBe("evolve");
    expect(error.message).toContain("[redacted]");
    expect(diagnostics(error)).not.toContain(apiKey);
    expect(error.cause).toBeUndefined();
  });

  it("rejects an endpoint that embeds credentials without echoing them", () => {
    const endpoint =
      "https://synthetic-user:synthetic-review-secret@model.example/chat/completions";

    const error = thrown(() =>
      createHostModelTransport(settings({ endpoint })),
    );

    expect(error.message).toMatch(/must not embed credentials/);
    expect(diagnostics(error)).not.toContain("synthetic-review-secret");
  });

  it("rejects a provider body that is not JSON", async () => {
    const { fetch } = controlledFetch(
      async () => new Response("<html>Bad gateway</html>", { status: 200 }),
    );
    const transport = createHostModelTransport(settings({ fetch }));

    await expect(
      transport.generate({ stage: "construct", prompt: "p" }),
    ).rejects.toThrow(/provider response body is not JSON/);
  });

  it("rejects length-truncated output instead of returning it", async () => {
    const { fetch } = controlledFetch(async () =>
      completion('{"context":"cut off', "length"),
    );
    const transport = createHostModelTransport(settings({ fetch }));

    await expect(
      transport.generate({ stage: "construct", prompt: "p" }),
    ).rejects.toThrow(/finish reason "length"/);
  });

  it("rejects model output with no message content", async () => {
    const { fetch } = controlledFetch(async () =>
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: null } }],
      }),
    );
    const transport = createHostModelTransport(settings({ fetch }));

    await expect(
      transport.generate({ stage: "construct", prompt: "p" }),
    ).rejects.toThrow(/no message content/);
  });

  it("rejects a timeout without retrying", async () => {
    const { calls, fetch } = controlledFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException(
                "The operation was aborted due to timeout",
                "TimeoutError",
              ),
            );
          });
        }),
    );
    const transport = createHostModelTransport(
      settings({ fetch, timeoutMs: 25 }),
    );

    await expect(
      transport.generate({ stage: "construct", prompt: "p" }),
    ).rejects.toThrow(/did not answer within 25 ms/);
    expect(calls).toHaveLength(1);
  });

  it("rejects a host cancellation without retrying", async () => {
    const controller = new AbortController();
    const { calls, fetch } = controlledFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
    );
    const transport = createHostModelTransport(
      settings({ fetch, signal: controller.signal }),
    );

    const pending = transport.generate({ stage: "construct", prompt: "p" });
    controller.abort();

    await expect(pending).rejects.toThrow(/was cancelled/);
    expect(calls).toHaveLength(1);
  });

  it("removes one outer Markdown JSON fence", async () => {
    const { fetch } = controlledFetch(async () =>
      completion('```json\n{"context":"c","keywords":[],"tags":[]}\n```'),
    );
    const transport = createHostModelTransport(settings({ fetch }));

    await expect(
      transport.generate({ stage: "construct", prompt: "p" }),
    ).resolves.toEqual({ context: "c", keywords: [], tags: [] });
  });

  it("rejects malformed JSON and never scrapes a valid-looking fragment", async () => {
    const malformed = controlledFetch(async () =>
      completion("Here is the JSON:"),
    );
    const surrounded = controlledFetch(async () =>
      completion('Here is the JSON:\n```json\n{"context":"c"}\n```'),
    );

    await expect(
      createHostModelTransport(settings({ fetch: malformed.fetch })).generate({
        stage: "construct",
        prompt: "p",
      }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      createHostModelTransport(settings({ fetch: surrounded.fetch })).generate({
        stage: "construct",
        prompt: "p",
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("returns structurally invalid JSON for the memory response schema to reject", async () => {
    const wrongShape = { context: 42, keywords: ["k"], tags: ["t"] };
    const { fetch } = controlledFetch(async () =>
      completion(JSON.stringify(wrongShape)),
    );
    const transport = createHostModelTransport(settings({ fetch }));

    const response = await transport.generate({
      stage: "construct",
      prompt: "p",
    });

    expect(response).toEqual(wrongShape);
    expect(() => readConstructionResponse(response)).toThrow(
      ModelResponseError,
    );
  });

  it("validates required host settings", () => {
    expect(() =>
      createHostModelTransport(settings({ timeoutMs: 0 })),
    ).toThrow();
    expect(() =>
      createHostModelTransport(settings({ endpoint: "not-a-url" })),
    ).toThrow();
  });
});
