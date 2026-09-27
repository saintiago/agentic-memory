# LanguageModel design

## Responsibility

Transport an assembled request to a model and return parsed JSON or an explicit failure. Provider
selection, credentials, thinking, timeout and output limits are host settings, not memory policy.

## Interface

```ts
interface ModelRequest {
  stage: "construct" | "evolve";
  prompt: string;
}
interface LanguageModel {
  generate(request: ModelRequest): Promise<unknown>;
}
```

This component imports no other component's types. The stage is for host routing and observation,
not a provider-specific model name. The caller owns response schemas; returning `unknown` prevents
transport success from implying that a proposed memory update is valid.

The library exports this contract and accepts a host implementation directly. It does not include a
mandatory provider client or infer credentials from Nexus. A minimal host example and evaluation
transport demonstrate actual invocation without turning one provider into a core dependency.

## Transport behavior

The host implementation must send the supplied instructions and data envelope without silently
dropping neighbors or shortening content. Configure a finite timeout and provider output budget.
Reject timeout, cancellation, provider error, incomplete/length-truncated output and invalid JSON.
An optional single outer Markdown JSON fence can be removed; do not scrape a valid-looking fragment
out of otherwise invalid output. Return parsed JSON, including a structurally invalid value, for
the caller to validate. Do not repair a failed semantic response with an undisclosed second request.

There are no implicit retries in the supplied example or evaluation default. A host implementing
transport retries must bound and account for them; retrying this read-only generation boundary is
different from retrying an entire memory insertion. Never treat an interrupted insertion as safe
to repeat merely because generation itself is read-only.

Provider errors identify stage and safe diagnostic details without exposing authorization headers.
Detailed prompts and raw outputs can contain private source text; recording them is an explicit
evaluation concern. Token usage, cache usage, duration, finish reason and provider request ID should
be captured by an instrumented host wrapper, not written into note metadata automatically.

## Reference experiment settings

The latest prototype used DeepSeek Flash with thinking disabled, a 6,000-output-token budget and a
120-second request timeout through an Anthropic-compatible transport. These are a reproducibility
reference, not promises about current provider availability or a mandatory production choice. The
live runner takes endpoint/model settings explicitly and records the exact provider model ID.

Thinking remains disabled for the reference evaluation. A prompt asking for accurate, concise text
does not require enabling a reasoning mode. Structural validity is checked in code; prompt wording
cannot guarantee fidelity, brevity, attribution or relevance. Report those through evaluation.

## Verification

Use controlled protocol fixtures for authentication errors, non-success responses, timeout, output
length termination, fenced JSON, malformed JSON and valid JSON of the wrong shape. Verify failures
are not transformed into empty success. A live paid smoke check is opt-in and reports actual usage;
routine validation does not require a key or invoke a model.
