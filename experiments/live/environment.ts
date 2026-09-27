/**
 * The live replay environment: the runtime collection through the library's Qdrant NoteStore,
 * separate evaluation-baseline collections with their own representation identities, a
 * host-supplied model transport and the real encoder supplied by the caller.
 *
 * The host owns provider lifecycle; `dispose` removes only the disposable collections this
 * environment created, and only when the caller asked for cleanup.
 *
 * See docs/evaluation.md#comparison-modes and docs/architecture.md#composition.
 */
import { randomUUID } from "node:crypto";

import {
  openQdrantNoteStore,
  type Embedder,
  type JsonValue,
  type LanguageModel,
  type NoteStore,
  type NoteStoreSpace,
} from "../../src/index.js";
import type { ManifestModel, StorageObservation } from "../replay/artifacts.js";
import { runtimeRepresentation } from "../replay/comparison.js";
import type {
  EnvironmentDescription,
  EvaluationEnvironment,
  OpenedCollection,
} from "../replay/environment.js";
import type { ExchangeLog } from "../replay/recorder.js";
import {
  deleteEvaluationCollection,
  evaluationClient,
  openEvaluationBaselineStore,
} from "./baseline-store.js";

/** Everything one live run needs from its host settings. */
export interface LiveEnvironmentOptions {
  url: string;
  apiKey?: string;
  /** Prefix of the collection names this run may create and delete. */
  baseName: string;
  space: NoteStoreSpace;
  embedder: Embedder;
  model: LanguageModel;
  exchanges: ExchangeLog | null;
  encoderSettings: Record<string, JsonValue> | null;
  modelDescription: ManifestModel;
  timeoutMs?: number;
  /** Delete the disposable collections after the run; the default keeps nothing behind. */
  cleanup?: boolean;
}

const collectionName = (baseName: string, label: string): string =>
  `${baseName}-${label}-${randomUUID().slice(0, 8)}`.replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );

/**
 * Open a live environment over one Qdrant instance. Every collection name is unique to the run, so
 * a fresh replay never reads or clears an earlier collection.
 */
export const createLiveEnvironment = (
  options: LiveEnvironmentOptions,
): EvaluationEnvironment => {
  const created: string[] = [];
  const cleanup = options.cleanup ?? true;
  const timeout = options.timeoutMs;
  return {
    embedder: options.embedder,
    model: options.model,
    exchanges: options.exchanges,
    describe(): EnvironmentDescription {
      return {
        encoder: { settings: options.encoderSettings },
        model: options.modelDescription,
        storage: { kind: "qdrant", endpoint: options.url, schemaVersion: 1 },
      };
    },
    async openCollection(request): Promise<OpenedCollection> {
      const collection = collectionName(options.baseName, request.label);
      const store: NoteStore =
        request.representation === runtimeRepresentation
          ? await openQdrantNoteStore({
              url: options.url,
              collection,
              space: options.space,
              ...(options.apiKey === undefined
                ? {}
                : { apiKey: options.apiKey }),
              ...(timeout === undefined ? {} : { timeoutMs: timeout }),
            })
          : await openEvaluationBaselineStore({
              url: options.url,
              collection,
              representation: request.representation,
              space: options.space,
              ...(options.apiKey === undefined
                ? {}
                : { apiKey: options.apiKey }),
              ...(timeout === undefined ? {} : { timeoutMs: timeout }),
            });
      created.push(collection);
      return { store, collection };
    },
    async observe(collection: string): Promise<StorageObservation | null> {
      try {
        const client = evaluationClient({
          url: options.url,
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
          ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        });
        const info = await client.getCollection(collection);
        const config = info.config as unknown as {
          params?: { vectors?: unknown };
          hnsw_config?: unknown;
          metadata?: unknown;
        };
        return {
          indexedVectors: info.indexed_vectors_count ?? null,
          configuration: {
            vectors: (config.params?.vectors ?? null) as JsonValue,
            hnsw: (config.hnsw_config ?? null) as JsonValue,
            metadata: (config.metadata ?? null) as JsonValue,
          },
        };
      } catch {
        // An unavailable observation stays unknown instead of being invented or failing the run.
        return null;
      }
    },
    async dispose(): Promise<void> {
      if (!cleanup) {
        return;
      }
      for (const collection of created) {
        await deleteEvaluationCollection({
          url: options.url,
          collection,
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
          ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        });
      }
      created.length = 0;
    },
  };
};
