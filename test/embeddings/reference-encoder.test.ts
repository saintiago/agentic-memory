import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  embeddingSpaceId,
  openReferenceEmbedder,
  referenceEncoderSettings,
  type ReferenceEmbedder,
} from "../../src/embeddings/index.js";

/**
 * Explicit pinned-artifact check against the real embedding runtime: loading, dimensions,
 * normalization, stable identity, long-input truncation and revision-only artifact resolution.
 * The setup warms the cache from the pinned revision; no check falls back to a mutable revision or
 * to unversioned local artifacts.
 *
 * docs/embeddings.md#verification, docs/testing.md#contracts-and-cooperation
 */

/** The pinned revision and identity, written here as independent expectations. */
const PINNED_REVISION = "4de13258303883538bd53b696b452bf8099f0858";
const MODEL = "Xenova/bge-m3";
const MAX_LENGTH = 8192;

/** Artifacts are reused between runs here; override with AMEM_EMBEDDING_CACHE when needed. */
const cacheDir =
  process.env["AMEM_EMBEDDING_CACHE"] ??
  fileURLToPath(new URL("../../.data/embeddings", import.meta.url));

/** The version declared by the installed runtime package, read from its own manifest. */
const installedRuntimeVersion = async (): Promise<string> => {
  const entry = createRequire(import.meta.url).resolve(
    "@huggingface/transformers",
  );
  const manifest = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../package.json", pathToFileURL(entry))),
      "utf8",
    ),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error("The installed runtime package declares no version.");
  }
  return manifest.version;
};

const settingsWith = (runtimeVersion: string) => ({
  model: MODEL,
  revision: PINNED_REVISION,
  runtime: "@huggingface/transformers",
  runtimeVersion,
  dtype: "q8",
  device: "cpu",
  pooling: "cls",
  normalize: true,
  maxLength: MAX_LENGTH,
  truncation: "right",
});

const spaceIdOf = (settings: object): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(settings), "utf8")
    .digest("hex")}`;

const norm = (vector: number[]): number => Math.hypot(...vector);

const maxDifference = (left: number[], right: number[]): number =>
  Math.max(
    ...left.map((value, index) => Math.abs(value - (right[index] ?? Infinity))),
  );

const expectUsableVector = (vector: number[]): void => {
  expect(vector).toHaveLength(1024);
  expect(vector.every((value) => Number.isFinite(value))).toBe(true);
  expect(Math.abs(norm(vector) - 1)).toBeLessThan(1e-5);
};

let embedder: ReferenceEmbedder;

beforeAll(async () => {
  embedder = await openReferenceEmbedder({ cacheDir, allowDownloads: true });
});

describe("reference encoder against the pinned artifacts", () => {
  it("loads the pinned revision into the documented space", async () => {
    const runtimeVersion = await installedRuntimeVersion();

    expect(env.version).toBe(runtimeVersion);
    expect(referenceEncoderSettings).toEqual(settingsWith(runtimeVersion));
    expect(embeddingSpaceId(referenceEncoderSettings)).toBe(
      spaceIdOf(settingsWith(runtimeVersion)),
    );
    expect(embedder.settings).toEqual(referenceEncoderSettings);
    expect(embedder.space).toEqual({
      id: spaceIdOf(settingsWith(runtimeVersion)),
      dimensions: 1024,
      distance: "Cosine",
    });
  });

  it("embeds small fixtures into usable unit vectors", async () => {
    const first = await embedder.embed(
      "Removing a stale queue entry requires an operator approval.",
    );
    const second = await embedder.embed(
      "The harbour crane lifts containers from the freight terminal.",
    );

    expectUsableVector(first);
    expectUsableVector(second);
    // Different subjects must not collapse onto one vector in this space.
    expect(maxDifference(first, second)).toBeGreaterThan(0.01);
  });

  it("reuses cached artifacts offline and reproduces the same vectors", async () => {
    const offline = await openReferenceEmbedder({
      cacheDir,
      allowDownloads: false,
    });

    expect(offline.space).toEqual(embedder.space);
    const [warm, offlineVector] = await Promise.all([
      embedder.embed("Operator approval is required."),
      offline.embed("Operator approval is required."),
    ]);
    expect(maxDifference(warm, offlineVector)).toBeLessThan(1e-6);
  });

  it("truncates long input at the declared boundary, retaining the leading tokens", async () => {
    // Load the tokenizer through the runtime's own revision-scoped resolution as well, which checks
    // that the pinned cache directory holds the artifacts where the runtime looks for that revision.
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL, {
      revision: PINNED_REVISION,
      cache_dir: cacheDir,
      local_files_only: true,
    });
    const longPrefix = "queue ".repeat(9000);

    expect(tokenizer.model_max_length).toBe(MAX_LENGTH);
    expect(tokenizer(longPrefix).input_ids.dims[1]).toBeGreaterThan(MAX_LENGTH);
    expect(
      tokenizer(longPrefix, { truncation: true, max_length: MAX_LENGTH })
        .input_ids.dims[1],
    ).toBe(MAX_LENGTH);

    // Both texts share their leading tokens; only the truncated tail distinguishes them.
    const [first, second] = await Promise.all([
      embedder.embed(`${longPrefix} alpha`),
      embedder.embed(`${longPrefix} omega`),
    ]);

    expectUsableVector(first);
    expect(maxDifference(first, second)).toBeLessThan(1e-6);
  });

  it("fails offline creation when the pinned artifacts are absent", async () => {
    const emptyCache = await mkdtemp(`${tmpdir()}/amem-embeddings-`);

    try {
      const failure: unknown = await openReferenceEmbedder({
        cacheDir: emptyCache,
        allowDownloads: false,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(PINNED_REVISION);
      expect(message).toContain(emptyCache);
      expect(message).toContain("downloads disabled");
      expect(message).toContain("onnx/model_quantized.onnx");
    } finally {
      await rm(emptyCache, { recursive: true, force: true });
    }
  });

  it("never accepts unversioned local artifacts as the pinned encoder", async () => {
    // Populate the runtime's default local model directory, which is not revision scoped, with a
    // complete but conflicting artifact set: a modified tokenizer plus the pinned config and
    // weights. A host cache without the pinned revision must never fall back to these files.
    const unversioned = await mkdtemp(`${tmpdir()}/amem-unversioned-`);
    const emptyCache = await mkdtemp(`${tmpdir()}/amem-embeddings-`);
    const localModelPath = env.localModelPath;
    const pinned = join(cacheDir, MODEL, PINNED_REVISION);

    try {
      await mkdir(join(unversioned, MODEL, "onnx"), { recursive: true });
      await symlink(
        join(pinned, "onnx/model_quantized.onnx"),
        join(unversioned, MODEL, "onnx/model_quantized.onnx"),
      );
      await symlink(
        join(pinned, "config.json"),
        join(unversioned, MODEL, "config.json"),
      );
      const conflicting = JSON.parse(
        await readFile(join(pinned, "tokenizer.json"), "utf8"),
      ) as Record<string, unknown>;
      conflicting["normalizer"] = {
        type: "Replace",
        pattern: { Regex: "." },
        content: "x",
      };
      await writeFile(
        join(unversioned, MODEL, "tokenizer.json"),
        JSON.stringify(conflicting),
      );
      await writeFile(
        join(unversioned, MODEL, "tokenizer_config.json"),
        JSON.stringify({
          tokenizer_class: "XLMRobertaTokenizer",
          model_max_length: MAX_LENGTH,
        }),
      );

      env.localModelPath = unversioned;

      const failure: unknown = await openReferenceEmbedder({
        cacheDir: emptyCache,
        allowDownloads: false,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(`${MODEL}@${PINNED_REVISION}`);
      expect(message).toContain(emptyCache);
      expect(message).toContain("downloads disabled");
      expect(message).toContain("is missing");
      expect(message).not.toContain(unversioned);
    } finally {
      env.localModelPath = localModelPath;
      await rm(unversioned, { recursive: true, force: true });
      await rm(emptyCache, { recursive: true, force: true });
    }
  });
});
