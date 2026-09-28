/**
 * Composition and supervised lifecycle of the local memory service: the durable queue and its
 * writer ownership exist before providers load, providers initialize and retry in the background,
 * the HTTP listener starts independently of them, and shutdown stops admission, settles in-flight
 * requests, stops claiming work, finishes the active operation and releases the journal.
 *
 * See docs/service.md#availability-restart-and-shutdown and
 * docs/ingestion-queue.md#writer-lifecycle-and-retries.
 */
import {
  QueueWorkerLockedError,
  openIngestionQueue,
  referenceEmbeddingSpace,
  type IngestionQueue,
} from "../src/index.js";
import { ProviderRuntime, type ProviderFactories } from "./providers.js";
import { FairScheduler } from "./scheduler.js";
import {
  startMemoryServiceServer,
  type MemoryServiceServer,
} from "./server.js";
import { MemoryService } from "./service.js";
import type { ServiceSettings } from "./settings.js";
import { WorkerSupervisor } from "./supervisor.js";

export interface StartMemoryServiceOptions {
  readonly settings: ServiceSettings;
  /** Controlled provider construction for component tests. */
  readonly factories?: Partial<ProviderFactories>;
  readonly scheduler?: FairScheduler;
  readonly queuePollIntervalMs?: number;
  readonly providerRetryBaseMs?: number;
  readonly supervisionIntervalMs?: number;
  readonly now?: () => Date;
}

/** One running service process: its loopback port and its graceful stop. */
export interface MemoryServiceRuntime {
  readonly port: number;
  readonly service: MemoryService;
  readonly queue: IngestionQueue;
  stop(): Promise<void>;
}

/** The default provider retry delay after a failed initialization attempt. */
const defaultProviderRetryBaseMs = 1_000;
/** How often the supervisor checks that the durable worker still runs. */
const defaultSupervisionIntervalMs = 5_000;

/**
 * Start the service: open the journal, take worker ownership, begin provider initialization and
 * serve loopback HTTP. Provider availability never blocks the listener; a second service that
 * names the same queue is refused before the listener starts.
 */
export const startMemoryService = async (
  options: StartMemoryServiceOptions,
): Promise<MemoryServiceRuntime> => {
  const settings = options.settings;
  const scheduler = options.scheduler ?? new FairScheduler();
  const providers = new ProviderRuntime({
    space: referenceEmbeddingSpace,
    settings: {
      qdrant: settings.qdrant,
      embedding: settings.embedding,
      model: settings.model,
    },
    scheduler,
    ...(options.factories === undefined
      ? {}
      : { factories: options.factories }),
    retryBaseMs: options.providerRetryBaseMs ?? defaultProviderRetryBaseMs,
  });
  const queue = await openIngestionQueue({
    directory: settings.dataDirectory,
    binding: {
      endpoint: settings.qdrant.url,
      collection: settings.qdrant.collection,
      embeddingSpace: { ...referenceEmbeddingSpace },
    },
    memory: providers.memory(),
    ...(options.queuePollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.queuePollIntervalMs }),
  });
  const service = new MemoryService({
    queue,
    providers,
    collection: settings.qdrant.collection,
    embeddingSpace: referenceEmbeddingSpace,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    // Worker ownership is acquired before the listener is exposed.
    await queue.start();
  } catch (cause) {
    await queue.close();
    if (cause instanceof QueueWorkerLockedError) {
      throw new Error(
        `Another memory service already owns the ingestion queue at ${cause.journalPath}.`,
        { cause },
      );
    }
    throw cause;
  }
  providers.start();
  let server: MemoryServiceServer;
  try {
    server = await startMemoryServiceServer({
      service,
      port: settings.port,
      bodyLimitBytes: settings.bodyLimitBytes,
    });
  } catch (cause) {
    await queue.close();
    await providers.stop();
    throw cause;
  }
  const supervisor = new WorkerSupervisor({
    worker: queue,
    intervalMs: options.supervisionIntervalMs ?? defaultSupervisionIntervalMs,
  });
  supervisor.start();

  let stopping: Promise<void> | undefined;
  return {
    port: server.port,
    service,
    queue,
    stop: () => {
      stopping ??= (async () => {
        // Stop admitting requests, then let accepted requests and the active operation settle.
        service.beginShutdown();
        await supervisor.stop();
        const closing = server.close();
        await server.settled();
        await closing;
        await queue.stop();
        await providers.stop();
        await queue.close();
      })();
      return stopping;
    },
  };
};
