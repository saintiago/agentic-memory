/**
 * Pinned local reference encoder: Transformers.js feature extraction with Xenova/bge-m3 in one
 * declared encoding space.
 *
 * See docs/embeddings.md for the pinned settings, the space identity, the truncation boundary and
 * the output validation rules this module implements.
 */
import {
  AutoModel,
  AutoTokenizer,
  Tensor,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { Embedder, EmbeddingSpace } from "./embedder.js";

/** The model repository, fixed by the reference configuration rather than a host setting. */
const MODEL = "Xenova/bge-m3";
/** The immutable repository commit the tokenizer and inference weights are loaded from. */
const REVISION = "4de13258303883538bd53b696b452bf8099f0858";
/** The runtime package that loads and executes the encoder. */
const RUNTIME = "@huggingface/transformers";
/** The hidden size of the pinned model; stored vectors use this many values. */
const DIMENSIONS = 1024;
/** The truncation boundary in tokenizer tokens, including special tokens. */
const MAX_LENGTH = 8192;

/**
 * The encoder settings that define an embedding space. Every field belongs to the identity: a
 * change to any of them is a different space even when the vector dimensions match.
 */
export interface EncoderSettings {
  readonly model: string;
  readonly revision: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly dtype: string;
  readonly device: string;
  readonly pooling: string;
  readonly normalize: boolean;
  readonly maxLength: number;
  readonly truncation: string;
}

/**
 * The exact reference encoder configuration. The local runtime reports its own installed version,
 * so the identity follows the pinned lockfile version instead of a second copy of it.
 */
export const referenceEncoderSettings = Object.freeze({
  model: MODEL,
  revision: REVISION,
  runtime: RUNTIME,
  runtimeVersion: env.version,
  dtype: "q8",
  device: "cpu",
  pooling: "cls",
  normalize: true,
  maxLength: MAX_LENGTH,
  truncation: "right",
} as const satisfies EncoderSettings);

export type ReferenceEncoderSettings = typeof referenceEncoderSettings;

/** Host-supplied settings must declare every identity field and nothing else. */
const settingsSchema: z.ZodType<EncoderSettings> = z.strictObject({
  model: z.string().min(1, "A model must be nonempty."),
  revision: z.string().min(1, "A revision must be nonempty."),
  runtime: z.string().min(1, "A runtime must be nonempty."),
  runtimeVersion: z.string().min(1, "A runtime version must be nonempty."),
  dtype: z.string().min(1, "A dtype must be nonempty."),
  device: z.string().min(1, "A device must be nonempty."),
  pooling: z.string().min(1, "A pooling method must be nonempty."),
  normalize: z.boolean(),
  maxLength: z.int().positive("A maximum length must be a positive integer."),
  truncation: z.string().min(1, "A truncation side must be nonempty."),
});

/** The settings in the documented key order, which is the byte sequence the identity hashes. */
const identityOf = (settings: EncoderSettings): EncoderSettings => ({
  model: settings.model,
  revision: settings.revision,
  runtime: settings.runtime,
  runtimeVersion: settings.runtimeVersion,
  dtype: settings.dtype,
  device: settings.device,
  pooling: settings.pooling,
  normalize: settings.normalize,
  maxLength: settings.maxLength,
  truncation: settings.truncation,
});

/**
 * The declared identity of the space these settings produce. Settings that do not declare exactly
 * the identity fields are rejected instead of hashed with a key silently missing.
 */
export const embeddingSpaceId = (settings: EncoderSettings): string => {
  const parsed = settingsSchema.parse(settings);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(identityOf(parsed)), "utf8")
    .digest("hex")}`;
};

const optionsSchema = z.strictObject({
  cacheDir: z.string().min(1, "A cache directory must be nonempty."),
  allowDownloads: z.boolean(),
});

/** Where pinned artifacts are cached and whether creation may download missing ones. */
export type ReferenceEmbedderOptions = z.infer<typeof optionsSchema>;

/** A ready reference encoder, with the pinned settings its space identity is derived from. */
export interface ReferenceEmbedder extends Embedder {
  readonly settings: ReferenceEncoderSettings;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Load one pinned artifact set, reporting the pin, the cache directory and the download permission
 * so a failure is diagnosable without inspecting the runtime.
 */
const loadArtifacts = async <T>(
  kind: "tokenizer" | "model",
  load: () => Promise<T>,
  { cacheDir, allowDownloads }: ReferenceEmbedderOptions,
): Promise<T> => {
  try {
    return await load();
  } catch (error) {
    throw new Error(
      `Unable to load the pinned ${kind} for ${MODEL}@${REVISION} from cache directory ` +
        `"${cacheDir}"${allowDownloads ? "" : " with downloads disabled"}: ${messageOf(error)}`,
      { cause: error },
    );
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The base model's last hidden states are the only output this encoder pools. */
const lastHiddenState = (outputs: unknown): Tensor => {
  const hidden = isObject(outputs) ? outputs["last_hidden_state"] : undefined;
  if (!(hidden instanceof Tensor)) {
    throw new Error("The reference encoder returned no last hidden states.");
  }
  return hidden;
};

/** Copy the declared number of finite values out of runtime storage. */
const validatedVector = (data: ArrayLike<unknown>): number[] => {
  const vector = Array.from(data);
  if (vector.length !== DIMENSIONS) {
    throw new Error(
      `The reference encoder must produce exactly ${DIMENSIONS} values, received ${vector.length}.`,
    );
  }
  return vector.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("The reference encoder produced a non-finite value.");
    }
    return value;
  });
};

/**
 * Pool the leading token, confirm the declared dimensions, finite values and a nonzero norm, and
 * return the L2-normalized values as a detached array. Nothing is substituted for a rejected
 * output, so callers either receive a usable vector or an explicit failure.
 */
const pooledVector = (hidden: Tensor): number[] => {
  const cls = hidden.slice(null, 0);
  validatedVector(cls.data);
  const magnitude = cls.norm(2, -1).data[0];
  if (
    typeof magnitude !== "number" ||
    !Number.isFinite(magnitude) ||
    magnitude <= 0
  ) {
    throw new Error(
      "The reference encoder produced a vector with no finite nonzero norm.",
    );
  }
  return validatedVector(cls.normalize(2, -1).data);
};

/**
 * One ready reference encoder. The tokenizer and model load once per instance, inference calls run
 * one at a time, and no text or vector is cached between calls.
 */
class LocalReferenceEmbedder implements ReferenceEmbedder {
  readonly settings = referenceEncoderSettings;
  readonly space: EmbeddingSpace;
  readonly #tokenizer: PreTrainedTokenizer;
  readonly #model: PreTrainedModel;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(tokenizer: PreTrainedTokenizer, model: PreTrainedModel) {
    this.#tokenizer = tokenizer;
    this.#model = model;
    this.space = {
      id: embeddingSpaceId(this.settings),
      dimensions: DIMENSIONS,
      distance: "Cosine",
    };
  }

  embed(text: string): Promise<number[]> {
    return this.#serialized(() => this.#infer(text));
  }

  /**
   * Run one inference at a time so concurrent callers cannot share runtime state. A failed call is
   * reported to its caller and does not stop the calls queued behind it.
   */
  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(task, task);
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #infer(text: string): Promise<number[]> {
    if (typeof text !== "string") {
      throw new TypeError("Embedding text must be a string.");
    }
    const inputs = this.#tokenizer(text, {
      truncation: true,
      max_length: MAX_LENGTH,
    });
    const outputs: unknown = await this.#model(inputs);
    // CLS pooling keeps the leading token's hidden state, matching the declared pooling setting.
    return pooledVector(lastHiddenState(outputs));
  }
}

/**
 * Load the pinned reference encoder for one instance. Creation fails when artifacts are missing
 * and downloads are disabled; a resolved embedder is ready to embed.
 */
export const openReferenceEmbedder = async (
  options: ReferenceEmbedderOptions,
): Promise<ReferenceEmbedder> => {
  const parsed = optionsSchema.parse(options);
  const shared = {
    revision: REVISION,
    cache_dir: parsed.cacheDir,
    local_files_only: !parsed.allowDownloads,
  };
  const tokenizer = await loadArtifacts(
    "tokenizer",
    () => AutoTokenizer.from_pretrained(MODEL, shared),
    parsed,
  );
  // The runtime clamps truncation to the tokenizer's own maximum, so a smaller artifact maximum
  // would silently change the space the identity declares.
  if (tokenizer.model_max_length < MAX_LENGTH) {
    throw new Error(
      `The pinned tokenizer declares a maximum of ${String(tokenizer.model_max_length)} tokens, ` +
        `below the declared ${MAX_LENGTH}.`,
    );
  }
  const model = await loadArtifacts(
    "model",
    () =>
      AutoModel.from_pretrained(MODEL, {
        ...shared,
        dtype: "q8",
        device: "cpu",
      }),
    parsed,
  );
  return new LocalReferenceEmbedder(tokenizer, model);
};
