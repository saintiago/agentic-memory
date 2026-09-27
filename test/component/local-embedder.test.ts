import { Tensor, env } from "@huggingface/transformers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  embeddingSpaceId,
  openReferenceEmbedder,
  referenceEncoderSettings,
  type EncoderSettings,
  type ReferenceEmbedder,
  type ReferenceEmbedderOptions,
} from "../../src/embeddings/index.js";

/**
 * Component cases for the reference encoder through its public contract. The pinned runtime is
 * replaced at its boundary with controlled tokenizer and inference output, so these cases need no
 * artifacts, network or real filesystem.
 *
 * docs/embeddings.md, docs/testing.md#contracts-and-cooperation
 */

interface LoadCall {
  readonly model: string;
  readonly options: Record<string, unknown>;
}

/** The mutable state the runtime boundary reads, so each case can control tokenizer and output. */
interface RuntimeState {
  tokenizerLoads: LoadCall[];
  modelLoads: LoadCall[];
  modelMaxLength: number;
  tokenize(text: unknown, options: unknown): unknown;
  infer(inputs: unknown): Promise<unknown>;
  failTokenizerLoad: string | undefined;
  failModelLoad: string | undefined;
}

const runtime = vi.hoisted((): RuntimeState => ({
  tokenizerLoads: [],
  modelLoads: [],
  modelMaxLength: 8192,
  tokenize: () => ({}),
  infer: () => Promise.reject(new Error("Inference was not configured.")),
  failTokenizerLoad: undefined,
  failModelLoad: undefined,
}));

vi.mock("@huggingface/transformers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@huggingface/transformers")>();
  return {
    ...actual,
    AutoTokenizer: {
      from_pretrained: async (
        model: string,
        options: Record<string, unknown>,
      ) => {
        runtime.tokenizerLoads.push({ model, options });
        if (runtime.failTokenizerLoad !== undefined) {
          throw new Error(runtime.failTokenizerLoad);
        }
        return Object.assign(
          (text: unknown, tokenOptions: unknown) =>
            runtime.tokenize(text, tokenOptions),
          {
            get model_max_length() {
              return runtime.modelMaxLength;
            },
          },
        );
      },
    },
    AutoModel: {
      from_pretrained: async (
        model: string,
        options: Record<string, unknown>,
      ) => {
        runtime.modelLoads.push({ model, options });
        if (runtime.failModelLoad !== undefined) {
          throw new Error(runtime.failModelLoad);
        }
        return (inputs: unknown) => runtime.infer(inputs);
      },
    },
  };
});

/** The pinned revision the settings must declare, written here as an independent expectation. */
const PINNED_REVISION = "4de13258303883538bd53b696b452bf8099f0858";
/** The identity of the pinned configuration, hashed independently of the implementation. */
const PINNED_SPACE_ID =
  "sha256:42d052a0f15c190a63f97c22e0aa9dc41c7fc107c243a70ffc7cf5e5b6136b8e";

const cacheDir = "/var/cache/agentic-memory/embeddings";

const open = (
  options: Partial<ReferenceEmbedderOptions> = {},
): Promise<ReferenceEmbedder> =>
  openReferenceEmbedder({ cacheDir, allowDownloads: false, ...options });

/**
 * One model output whose leading token carries `cls` in its first hidden units; other tokens carry
 * unrelated values that pooling and validation must not collect.
 */
const modelOutput = (
  cls: number[],
  tokens = 3,
): { last_hidden_state: Tensor } => {
  const data = new Float32Array(tokens * 1024);
  cls.forEach((value, index) => {
    data[index] = value;
  });
  for (let index = 1024; index < data.length; index += 1) {
    data[index] = 0.5;
  }
  return { last_hidden_state: new Tensor("float32", data, [1, tokens, 1024]) };
};

beforeEach(() => {
  runtime.tokenizerLoads.length = 0;
  runtime.modelLoads.length = 0;
  runtime.modelMaxLength = 8192;
  runtime.tokenize = (text, options) => ({ text, options });
  runtime.infer = async () => modelOutput([3, 4]);
  runtime.failTokenizerLoad = undefined;
  runtime.failModelLoad = undefined;
});

describe("reference encoder identity", () => {
  it("declares the pinned settings and the identity they produce", async () => {
    expect(referenceEncoderSettings).toEqual({
      model: "Xenova/bge-m3",
      revision: PINNED_REVISION,
      runtime: "@huggingface/transformers",
      runtimeVersion: env.version,
      dtype: "q8",
      device: "cpu",
      pooling: "cls",
      normalize: true,
      maxLength: 8192,
      truncation: "right",
    });
    expect(Object.isFrozen(referenceEncoderSettings)).toBe(true);
    expect(embeddingSpaceId(referenceEncoderSettings)).toBe(PINNED_SPACE_ID);

    const embedder = await open();

    expect(embedder.settings).toBe(referenceEncoderSettings);
    expect(embedder.space).toEqual({
      id: PINNED_SPACE_ID,
      dimensions: 1024,
      distance: "Cosine",
    });
  });

  it("gives every settings field its own contribution to the identity", () => {
    const variants: ReadonlyArray<readonly [string, EncoderSettings]> = [
      ["model", { ...referenceEncoderSettings, model: "BAAI/bge-m3" }],
      ["revision", { ...referenceEncoderSettings, revision: "0".repeat(40) }],
      [
        "runtime",
        { ...referenceEncoderSettings, runtime: "@xenova/transformers" },
      ],
      [
        "runtimeVersion",
        { ...referenceEncoderSettings, runtimeVersion: "0.0.0" },
      ],
      ["dtype", { ...referenceEncoderSettings, dtype: "fp16" }],
      ["device", { ...referenceEncoderSettings, device: "wasm" }],
      ["pooling", { ...referenceEncoderSettings, pooling: "mean" }],
      ["normalize", { ...referenceEncoderSettings, normalize: false }],
      ["maxLength", { ...referenceEncoderSettings, maxLength: 4096 }],
      ["truncation", { ...referenceEncoderSettings, truncation: "left" }],
    ];

    const identities = new Set([
      PINNED_SPACE_ID,
      ...variants.map(([, settings]) => embeddingSpaceId(settings)),
    ]);

    expect(variants).toHaveLength(10);
    expect(identities.size).toBe(variants.length + 1);
  });

  it("rejects settings that do not declare exactly the identity fields", () => {
    const incomplete: Record<string, unknown> = {
      ...referenceEncoderSettings,
    };
    delete incomplete["dtype"];

    expect(() =>
      embeddingSpaceId(incomplete as unknown as EncoderSettings),
    ).toThrow(/dtype/);
    expect(() =>
      embeddingSpaceId({ ...referenceEncoderSettings, dtype: "" }),
    ).toThrow(/dtype/);
    expect(() =>
      embeddingSpaceId({
        ...referenceEncoderSettings,
        cacheDir: "/var/cache",
      } as unknown as EncoderSettings),
    ).toThrow();
  });
});

describe("reference encoder lifecycle", () => {
  it("loads the pinned artifacts once per instance, honoring cache and download settings", async () => {
    const embedder = await open();

    expect(runtime.tokenizerLoads).toEqual([
      {
        model: "Xenova/bge-m3",
        options: {
          revision: PINNED_REVISION,
          cache_dir: cacheDir,
          local_files_only: true,
        },
      },
    ]);
    expect(runtime.modelLoads).toEqual([
      {
        model: "Xenova/bge-m3",
        options: {
          revision: PINNED_REVISION,
          cache_dir: cacheDir,
          local_files_only: true,
          dtype: "q8",
          device: "cpu",
        },
      },
    ]);

    await embedder.embed("first");
    await embedder.embed("second");

    expect(runtime.tokenizerLoads).toHaveLength(1);
    expect(runtime.modelLoads).toHaveLength(1);

    const online = await open({ allowDownloads: true });

    expect(runtime.tokenizerLoads[1]?.options["local_files_only"]).toBe(false);
    expect(runtime.modelLoads[1]?.options["local_files_only"]).toBe(false);
    // Cache paths and download permission are lifecycle settings, not identity inputs.
    expect(online.space).toEqual(embedder.space);
  });

  it("rejects unusable host settings before loading anything", async () => {
    await expect(open({ cacheDir: "" })).rejects.toThrow(/cache directory/);
    await expect(
      open({ allowDownloads: "yes" as unknown as boolean }),
    ).rejects.toThrow();
    await expect(
      openReferenceEmbedder({
        cacheDir,
        allowDownloads: true,
        revision: "main",
      } as unknown as ReferenceEmbedderOptions),
    ).rejects.toThrow();

    expect(runtime.tokenizerLoads).toEqual([]);
    expect(runtime.modelLoads).toEqual([]);
  });

  it("rejects creation when a pinned artifact cannot be loaded", async () => {
    runtime.failTokenizerLoad = "offline tokenizer failure";

    await expect(open()).rejects.toThrow(
      new RegExp(`tokenizer.*Xenova/bge-m3@${PINNED_REVISION}.*${cacheDir}`),
    );
    expect(runtime.modelLoads).toEqual([]);

    runtime.failTokenizerLoad = undefined;
    runtime.failModelLoad = "offline model failure";

    const failure: unknown = await open().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/downloads disabled/);
    expect((failure as Error).message).toMatch(/offline model failure/);
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it("rejects creation when the artifacts declare a smaller tokenizer maximum", async () => {
    runtime.modelMaxLength = 512;

    await expect(open()).rejects.toThrow(/maximum of 512 tokens/);
    expect(runtime.modelLoads).toEqual([]);
  });
});

describe("reference encoder inference", () => {
  it("pools the leading token, normalizes it and truncates at the declared boundary", async () => {
    const tokenize = vi.fn((text: unknown, options: unknown): unknown => ({
      text,
      options,
    }));
    runtime.tokenize = tokenize;
    runtime.infer = async () => modelOutput([3, 4]);

    const embedder = await open();
    const vector = await embedder.embed("a small fixture");

    expect(tokenize).toHaveBeenCalledWith("a small fixture", {
      truncation: true,
      max_length: 8192,
    });
    expect(vector).toHaveLength(1024);
    expect(vector[0]).toBeCloseTo(0.6, 6);
    expect(vector[1]).toBeCloseTo(0.8, 6);
    expect(vector.slice(2).every((value) => value === 0)).toBe(true);
  });

  it("returns a detached array and does not cache text or vectors", async () => {
    const infer = vi.fn(async () => modelOutput([3, 4]));
    runtime.infer = infer;
    const embedder = await open();
    const first = await embedder.embed("same text");
    first[0] = 99;
    first.fill(0);

    const second = await embedder.embed("same text");

    expect(second).not.toBe(first);
    expect(second[0]).toBeCloseTo(0.6, 6);
    expect(infer).toHaveBeenCalledTimes(2);
    expect(runtime.tokenizerLoads).toHaveLength(1);
    expect(runtime.modelLoads).toHaveLength(1);
  });

  it("serializes concurrent inference and keeps each caller's own result", async () => {
    let active = 0;
    let peak = 0;
    runtime.tokenize = (text: unknown) => ({ text });
    runtime.infer = async (inputs) => {
      const { text } = inputs as { text: string };
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return modelOutput(text === "first" ? [3, 4] : [4, 3]);
    };

    const embedder = await open();
    const [first, second] = await Promise.all([
      embedder.embed("first"),
      embedder.embed("second"),
    ]);

    expect(peak).toBe(1);
    expect(first[0]).toBeCloseTo(0.6, 6);
    expect(first[1]).toBeCloseTo(0.8, 6);
    expect(second[0]).toBeCloseTo(0.8, 6);
    expect(second[1]).toBeCloseTo(0.6, 6);
  });

  it("continues the queue after a failed inference", async () => {
    runtime.tokenize = (text: unknown) => ({ text });
    runtime.infer = async (inputs) => {
      const { text } = inputs as { text: string };
      if (text === "unusable") {
        throw new Error("inference failed");
      }
      return modelOutput([4, 3]);
    };

    const embedder = await open();
    const failure = embedder.embed("unusable");
    const success = embedder.embed("usable");

    await expect(failure).rejects.toThrow("inference failed");
    await expect(success).resolves.toHaveLength(1024);
  });

  it("rejects unusable output instead of substituting a vector", async () => {
    const embedder = await open();

    runtime.infer = async () => ({
      last_hidden_state: new Tensor(
        "float32",
        new Float32Array(512).fill(0.5),
        [1, 1, 512],
      ),
    });
    await expect(embedder.embed("short")).rejects.toThrow(
      /exactly 1024 values, received 512/,
    );

    runtime.infer = async () => modelOutput([3, Number.NaN]);
    await expect(embedder.embed("not finite")).rejects.toThrow(/non-finite/);

    runtime.infer = async () => modelOutput([0, 0]);
    await expect(embedder.embed("zero")).rejects.toThrow(/nonzero norm/);

    runtime.infer = async () => ({ logits: modelOutput([3, 4]) });
    await expect(embedder.embed("no states")).rejects.toThrow(
      /last hidden states/,
    );
  });

  it("rejects text that is not a string", async () => {
    const tokenize = vi.fn();
    runtime.tokenize = tokenize;
    const embedder = await open();

    await expect(embedder.embed(42 as unknown as string)).rejects.toThrow(
      /must be a string/,
    );
    expect(tokenize).not.toHaveBeenCalled();
  });
});
