# Host examples

`host-model-transport.ts` is the minimal host implementation of the public
[LanguageModel contract](../docs/language-model.md#interface). It speaks an OpenAI-compatible
chat-completions protocol with explicit host settings: endpoint, model ID, output budget, timeout
and optional credential, cancellation signal and fetch implementation. The library does not depend
on it and never constructs a provider, so a host copies, adapts or replaces this example.

```ts
import {
  assembleConstructionPrompt,
  defaultPrompts,
  readConstructionResponse,
} from "agentic-memory";
import { createHostModelTransport } from "./host-model-transport.js";

const model = createHostModelTransport({
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-chat",
  apiKey: process.env.AMEM_MODEL_API_KEY, // host-owned credential
  timeoutMs: 120_000,
  maxOutputTokens: 6_000,
});

// The host supplies the source text and the resolved observation timestamp.
const prompt = assembleConstructionPrompt(defaultPrompts.construction, {
  content: sourceText,
  timestamp: resolvedTimestamp,
});
const response = await model.generate({ stage: "construct", prompt });
const attributes = readConstructionResponse(response);
```

The transport sends the assembled prompt unchanged, removes at most one outer Markdown JSON fence
and returns parsed JSON, including a structurally invalid value for the memory response schema to
reject. Timeout, cancellation, provider errors, length-truncated output and invalid JSON fail with a
`HostModelTransportError` that names the stage and never exposes authorization headers. There are
no implicit retries; a host that retries transport failures owns that policy and its bounds.

A live call needs host credentials and is opt-in; the deterministic checks use controlled protocol
fixtures and invoke no model. To record raw exchanges, usage, duration and finish reason for
evaluation, inject a `fetch` wrapper instead of adding provider state to this transport.

In this repository the example imports the public component surface (`../src/index.js`) and is
covered by `npm run validate`. Consumers import the same contracts from the published package.
