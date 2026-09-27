/**
 * Controlled embedder, model and exchange log for the replay-harness tests: no network, no external
 * service and no paid call. The values are small and explicit so a case can predict the ordering it
 * asserts.
 *
 * See docs/testing.md#test-discipline.
 */
import type {
  Embedder,
  LanguageModel,
  ModelRequest,
} from "../../../src/index.js";
import type {
  ExchangeLog,
  ModelExchange,
} from "../../../experiments/replay/recorder.js";
import type { TokenUsage } from "../../../experiments/replay/artifacts.js";
import type {
  QueryCase,
  SourceEntry,
} from "../../../experiments/replay/fixture.js";

/** Which of the four controlled dimensions a token raises. */
const tokenDimensions: Record<string, number> = {
  alpha: 0,
  beta: 1,
  gamma: 2,
  approval: 3,
  approved: 3,
};

/** A four-dimensional embedder whose vector counts the controlled tokens of the text. */
export class TokenEmbedder implements Embedder {
  readonly space = {
    id: "amem-eval-test-space",
    dimensions: 4,
    distance: "Cosine",
  } as const;
  readonly texts: string[] = [];

  async embed(text: string): Promise<number[]> {
    this.texts.push(text);
    const vector = [0, 0, 0, 0];
    for (const token of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      const dimension = tokenDimensions[token];
      if (dimension !== undefined) {
        vector[dimension] = (vector[dimension] ?? 0) + 1;
      }
    }
    const norm = Math.hypot(...vector);
    if (norm === 0) {
      return [0.5, 0.5, 0.5, 0.5];
    }
    return vector.map((value) => value / norm);
  }
}

/** An exchange log the scripted model fills, standing in for the live recording fetch. */
export class TestExchangeLog implements ExchangeLog {
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

interface ScriptedStep {
  stage: ModelRequest["stage"];
  produce: (request: ModelRequest) => unknown;
  usage: TokenUsage | null;
}

/** A model that answers queued steps in order and reports the declared usage per answer. */
export class ScriptedModel implements LanguageModel {
  readonly requests: ModelRequest[] = [];
  readonly exchanges = new TestExchangeLog();
  readonly #steps: ScriptedStep[] = [];

  queue(
    stage: ModelRequest["stage"],
    produce: (request: ModelRequest) => unknown,
    usage: TokenUsage | null = null,
  ): this {
    this.#steps.push({ stage, produce, usage });
    return this;
  }

  async generate(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    const step = this.#steps.shift();
    if (step === undefined || step.stage !== request.stage) {
      throw new Error(`Unexpected ${request.stage} request.`);
    }
    const response = await step.produce(request);
    this.exchanges.push({
      requestBody: JSON.stringify({ prompt: request.prompt }),
      responseBody: JSON.stringify(response ?? null),
      status: 200,
      usage: step.usage,
      finishReason: "stop",
      requestId: `request-${String(this.requests.length)}`,
    });
    return response;
  }
}

/** The fixture the harness cases replay. */
export const testSources: SourceEntry[] = [
  {
    sourceId: "alpha-requirement",
    content: "The alpha procedure requires operator approval.",
    timestamp: "2026-09-01T10:00:00Z",
    metadata: { domain: "alpha", kind: "requirement" },
  },
  {
    sourceId: "alpha-record",
    content: "An operator granted the alpha procedure approval.",
    timestamp: "2026-09-02T10:00:00Z",
    metadata: { domain: "alpha", kind: "record" },
  },
  {
    sourceId: "beta-observation",
    content: "The beta routine ran without operator approval.",
    timestamp: "2026-09-03T10:00:00Z",
  },
];

/** Two questions: one multi-source, one single-source in another domain. */
export const testQueries: QueryCase[] = [
  {
    id: "alpha-approval",
    query: "alpha procedure approval",
    requiredSourceIds: ["alpha-requirement", "alpha-record"],
    scope: "alpha",
    rationale: "The requirement and its record must both be recovered.",
  },
  {
    id: "beta-observation",
    query: "beta routine approval",
    requiredSourceIds: ["beta-observation"],
    rationale: "A single-source question in an unrelated domain.",
  },
];

export const modelDescription = {
  endpoint: "in-process",
  id: "scripted-test-model",
  thinking: "disabled-external",
  maxOutputTokens: 6_000,
  timeoutMs: 120_000,
  retries: 0,
} as const;
