# Embeddings design

## Responsibility

Convert supplied text to vectors in one declared, reproducible space. This component owns encoder
settings, model loading, inference and output validation; it does not interpret the text.

## Interface

```ts
interface EmbeddingSpace {
  readonly id: string;
  readonly dimensions: number;
  readonly distance: "Cosine";
}
interface Embedder {
  readonly space: EmbeddingSpace;
  embed(text: string): Promise<number[]>;
}
```

There are no dependencies on other system components. Hosts pass `space` as plain initialization
data to their storage implementation. A resolved embedder is ready to use; loading failures reject
creation. Results are detached arrays. Inference failures reject explicitly; never return a zero
vector, cached unrelated vector or a shorter substituted input.

## Reference encoder

Use Transformers.js feature extraction with `Xenova/bge-m3`, CPU execution, q8 model weights,
CLS pooling and normalization, producing 1,024 floating-point values. Query and document encoding
use the same encoder with no extra instruction prefix. Load the model once per instance, not once
per note. Q8 describes inference weights; it does not make stored vectors 8-bit.

Pin the model repository to an immutable revision and the runtime in the lockfile. A host supplies
the cache directory and whether downloads are allowed. Offline creation fails if required artifacts
are absent. Never resolve a mutable default revision silently for an existing collection.

The space ID is `sha256:` followed by the lowercase SHA-256 hex digest of UTF-8 `JSON.stringify`
of the following object, in the displayed key order, with no whitespace or extra keys:

```ts
{
  model: "Xenova/bge-m3",
  revision: "<immutable model repository commit>",
  runtime: "@huggingface/transformers",
  runtimeVersion: "<exact installed version>",
  dtype: "q8",
  device: "cpu",
  pooling: "cls",
  normalize: true,
  maxLength: 8192,
  truncation: "right"
}
```

Tokenizer artifacts come from that same pinned revision, without host overrides. Cache paths and
download permission do not alter the space ID. Expose these settings alongside the ID for diagnosis.
Identical dimensions are insufficient evidence of compatibility.

## Length and validation

Set the reference maximum to 8,192 tokenizer tokens including special tokens. Use tokenizer
truncation at that boundary, retaining the leading token sequence according to the pinned tokenizer.
Do not split a source into additional notes or alter stored source text. This is encoder truncation,
not evidence that the entire source influenced the vector. The tokenizer's handling and maximum
must be explicit in the space identity and confirmed against the chosen model artifacts.

Validate exactly 1,024 finite values with nonzero norm from the reference implementation; provider
replacements validate their declared dimensions. Normalized outputs should have unit norm within
floating-point tolerance. Do not cache unbounded text/vector pairs. Concurrent calls must not corrupt
results; an implementation may serialize inference if required by the runtime.

## Verification

Use fixed artifact revisions and small fixtures to verify actual runtime output, identity stability,
configuration changes producing different identities, and long-input truncation. Routine component
tests use controlled inference output; an explicit real-model integration check verifies loading,
dimensions and normalization without asserting a brittle exact vector. Record cold loading
separately from warm inference in [evaluation](evaluation.md#performance-and-cost).
