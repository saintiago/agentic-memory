/**
 * Minimal Linux/WSL host composition for the assembled library: load the pinned local encoder,
 * open or create a compatible Qdrant collection with the encoder's declared space, supply an HTTP
 * model transport and construct AgenticMemory from host-owned settings. It demonstrates add,
 * search and inspection against one collection; it is not a hosted service.
 *
 * Every external setting comes from the host, and initialization fails before the instance is
 * exposed when a provider is unavailable or the collection is incompatible. This in-repository
 * example imports the public component surface (`../src/index.js`) so the repository type checks
 * it; a consumer imports the same exports from the installed `agentic-memory` package.
 *
 * See docs/architecture.md#composition and examples/README.md.
 */
import {
  AgenticMemory,
  embeddingText,
  openQdrantNoteStore,
  openReferenceEmbedder,
  type Note,
  type SearchResult,
} from "../src/index.js";
import { createHostModelTransport } from "./host-model-transport.js";

/** One required host setting; nothing is discovered from Nexus or the environment implicitly. */
const setting = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be supplied by the host.`);
  }
  return value;
};

/** An optional host setting; an empty value means the host supplied nothing. */
const optionalSetting = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
};

/** A positive safe integer setting with the supplied default. */
const integerSetting = (name: string, fallback: number): number => {
  const raw = optionalSetting(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
};

/** Host-owned source material for a small demonstration corpus. */
const SOURCES = [
  "Removing a stale queue entry requires an operator approval.",
  "An approved removal of a stale queue entry is recorded in the operations log.",
];
const QUERY = "removing a stale queue entry";

const main = async (): Promise<void> => {
  const collection = setting("AMEM_QDRANT_COLLECTION");
  const qdrantApiKey = optionalSetting("AMEM_QDRANT_API_KEY");
  const modelApiKey = optionalSetting("AMEM_MODEL_API_KEY");

  // Host-owned provider setup. The cache directory and download permission are host settings, and
  // the collection declares the exact embedding space the encoder reports.
  const embedder = await openReferenceEmbedder({
    cacheDir: optionalSetting("AMEM_EMBEDDING_CACHE") ?? ".data/embeddings",
    allowDownloads:
      optionalSetting("AMEM_ALLOW_EMBEDDING_DOWNLOADS") !== "false",
  });
  const store = await openQdrantNoteStore({
    url: setting("AMEM_QDRANT_URL"),
    collection,
    space: embedder.space,
    timeoutMs: integerSetting("AMEM_QDRANT_TIMEOUT_MS", 120_000),
    ...(qdrantApiKey === undefined ? {} : { apiKey: qdrantApiKey }),
  });
  const model = createHostModelTransport({
    endpoint: setting("AMEM_MODEL_ENDPOINT"),
    model: setting("AMEM_MODEL_ID"),
    timeoutMs: integerSetting("AMEM_MODEL_TIMEOUT_MS", 120_000),
    maxOutputTokens: integerSetting("AMEM_MODEL_MAX_OUTPUT_TOKENS", 6_000),
    ...(modelApiKey === undefined ? {} : { apiKey: modelApiKey }),
  });

  const memory = new AgenticMemory(store, embedder, model);

  // Insert source material. The library constructs the note, links it to related stored notes and
  // persists the accepted evolution before reporting success.
  const stored: Note[] = [];
  for (const content of SOURCES) {
    stored.push(
      await memory.add({
        content,
        metadata: { origin: "host-composition-example" },
      }),
    );
  }
  console.log(`Stored ${String(stored.length)} notes in "${collection}".`);

  // Search. Direct matches keep their similarity scores; distinct notes reached through one hop of
  // their outgoing links are appended as linked additions, and no model call is involved.
  const results: SearchResult[] = await memory.search(QUERY, {
    limit: 5,
    linkedLimit: 5,
  });
  console.log(
    `Search for "${QUERY}" returned ${String(results.length)} notes:`,
  );
  for (const result of results) {
    const score =
      result.via === "match" ? ` score ${result.score.toFixed(4)}` : "";
    console.log(
      `- [${result.via}${score}] ${result.note.id}: ${result.note.content}`,
    );
    console.log(`  Context: ${result.note.context}`);
    console.log(
      `  Keywords: ${result.note.keywords.join(", ")} | ` +
        `Tags: ${result.note.tags.join(", ")} | ` +
        `Links: ${result.note.links.join(", ") || "none"}`,
    );
  }

  // Inspect one current note and one page of the collection without model interpretation.
  const first = results[0];
  if (first !== undefined) {
    const current = await memory.get(first.note.id);
    console.log(
      `get(${first.note.id}) returns ${current?.content ?? "no note"}.`,
    );
    console.log(
      `Canonical embedding text: ${JSON.stringify(embeddingText(current ?? first.note))}`,
    );
  }
  const page = await memory.page(10);
  console.log(
    `The first page holds ${String(page.notes.length)} notes; ` +
      `another page exists: ${String(page.cursor !== undefined)}.`,
  );

  // The host owns provider lifecycle: every write above was awaited, so no insertion is pending.
};

await main();
