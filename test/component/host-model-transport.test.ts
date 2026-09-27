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
