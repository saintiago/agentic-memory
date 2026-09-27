# Host examples

The examples cover the two host-owned boundaries of the library: assembling it from public exports
with explicit settings, and implementing the `LanguageModel` transport.

## Composition

`host-composition.ts` is the minimal Linux/WSL host composition of the assembled library. It loads
the pinned local encoder, opens or creates a Qdrant collection with the encoder's declared space,
supplies the model transport below and constructs `AgenticMemory`; then it demonstrates add, search
and inspection. It is not a hosted service, and the library discovers no settings by itself:

```ts
import {
  AgenticMemory,
  openQdrantNoteStore,
  openReferenceEmbedder,
} from "agentic-memory";
import { createHostModelTransport } from "./host-model-transport.js";

// Host-owned providers. Initialization fails before the instance is exposed when a provider is
// unavailable or the collection is incompatible.
const embedder = await openReferenceEmbedder({ cacheDir, allowDownloads });
const store = await openQdrantNoteStore({
  url: qdrantUrl,
  collection,
  space: embedder.space, // the exact declared embedding space, not just its dimensions
  timeoutMs: 120_000,
});
const model = createHostModelTransport({
  endpoint,
  model: modelId,
  apiKey, // host-owned credential
  timeoutMs: 120_000,
  maxOutputTokens: 6_000,
});
const memory = new AgenticMemory(store, embedder, model);

const note = await memory.add({
  content: sourceText,
  metadata: { origin: "host" },
});
const results = await memory.search(query, { limit: 5, linkedLimit: 5 });
const current = await memory.get(note.id);
const page = await memory.page(10);
```

Every external setting is supplied by the host environment; a missing required value fails before
any provider work. `AMEM_QDRANT_URL` and `AMEM_QDRANT_COLLECTION` name the Qdrant endpoint and its
dedicated collection, and `AMEM_MODEL_ENDPOINT` with `AMEM_MODEL_ID` name the model the transport
invokes. Optional settings are the Qdrant and provider credentials (`AMEM_QDRANT_API_KEY`,
`AMEM_MODEL_API_KEY`), the encoder cache and its download permission (`AMEM_EMBEDDING_CACHE`,
default `.data/embeddings`; `AMEM_ALLOW_EMBEDDING_DOWNLOADS`, default enabled), and the request
bounds (`AMEM_QDRANT_TIMEOUT_MS`, `AMEM_MODEL_TIMEOUT_MS`, `AMEM_MODEL_MAX_OUTPUT_TOKENS`). The
host owns server startup, credentials, collection choice and shutdown; it waits for pending writes
before releasing provider resources.

## Model transport

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
`HostModelTransportError` that names the stage and keeps the configured credential out of every
diagnostic: text a provider or fetch failure echoes is redacted before it is shortened, and no raw
provider or fetch cause is attached. An API key the platform cannot send unchanged as an
`authorization` header (including a key with trailing whitespace), or an endpoint that embeds
credentials, is rejected when the transport is created without echoing the value. There are no
implicit retries; a host that retries transport failures owns that policy and its bounds.

A live call needs host credentials and is opt-in; the deterministic checks use controlled protocol
fixtures and invoke no model. To record raw exchanges, usage, duration and finish reason for
evaluation, inject a `fetch` wrapper instead of adding provider state to this transport.

In this repository both examples import the public component surface (`../src/index.js`) and are
covered by `npm run validate`. Consumers import the same contracts from the published package.
