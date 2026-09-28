/**
 * Public-API composition of the inspection host: one matching embedder for queries, one compatible
 * Qdrant collection opened with that embedder's declared space, one `AgenticMemory` for public
 * `get` and `search`, and a host-local model that fails if generation is ever attempted.
 *
 * The inspection process needs no generation-provider credentials and exposes no write route.
 *
 * See docs/dashboard.md#startup-and-composition.
 */
import {
  AgenticMemory,
  openQdrantNoteStore,
  openReferenceEmbedder,
  type Embedder,
  type LanguageModel,
  type NoteStore,
} from "../src/index.js";
import type { InspectionSettings } from "./settings.js";

/** The opened read stack of one inspection host. */
export interface InspectionMemory {
  readonly embedder: Embedder;
  readonly store: NoteStore;
  readonly memory: AgenticMemory;
}

/**
 * The host-local model of the inspection process. Reading, searching and projecting never generate
 * text, so any invocation is a host bug and fails instead of contacting a provider.
 */
const refusingModel: LanguageModel = {
  async generate(): Promise<never> {
    throw new Error("The inspection host does not invoke a language model.");
  },
};

/** Open the read stack; initialization fails before the host is exposed when it is incompatible. */
export const openInspectionMemory = async (
  settings: InspectionSettings,
): Promise<InspectionMemory> => {
  const embedder = await openReferenceEmbedder({
    cacheDir: settings.embedding.cacheDir,
    allowDownloads: settings.embedding.allowDownloads,
  });
  const store = await openQdrantNoteStore({
    url: settings.qdrant.url,
    collection: settings.qdrant.collection,
    space: embedder.space,
    timeoutMs: settings.qdrant.timeoutMs,
    ...(settings.qdrant.apiKey === undefined
      ? {}
      : { apiKey: settings.qdrant.apiKey }),
  });
  return {
    embedder,
    store,
    memory: new AgenticMemory(store, embedder, refusingModel),
  };
};
