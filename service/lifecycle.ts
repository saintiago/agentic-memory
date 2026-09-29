/**
 * Composition and supervised lifecycle of the local memory service: the durable queue and its
 * writer ownership exist before providers load, providers initialize and retry in the background,
 * the HTTP listener starts independently of them, and shutdown stops admission, stops claiming
 * work, settles in-flight requests and the active operation, then releases providers and the
 * journal.
 *
 * With the bundled dashboard requested, the same listener also serves the read-only browser API,
 * the WebSocket notification channel and the built UI, and every completed collection write
 * invalidates the projected view.
 *
 * See docs/service.md#availability-restart-and-shutdown, docs/service.md#bundled-dashboard and
 * docs/ingestion-queue.md#writer-lifecycle-and-retries.
 */
import {
  QueueWorkerLockedError,
  openIngestionQueue,
  referenceEmbeddingSpace,
  type IngestionQueue,
  type MemoryPreparer,
} from "../src/index.js";
import {
  openBundledDashboard,
  type BundledDashboard,
  type BundledDashboardOptions,
} from "./dashboard.js";
import { ProviderRuntime, type ProviderFactories } from "./providers.js";
import { FairScheduler } from "./scheduler.js";
import {
  startMemoryServiceServer,
  type MemoryServiceServer,
} from "./server.js";
import { MemoryService } from "./service.js";
import { validateProviderSettings, type ServiceSettings } from "./settings.js";
import { WorkerSupervisor } from "./supervisor.js";

export interface StartMemoryServiceOptions {
  readonly settings: ServiceSettings;
  /** Compose the bundled read-only dashboard on the service listener when supplied. */
  readonly dashboard?: BundledDashboardOptions;
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
  // Provider-owned validation runs before the journal exists, so a malformed endpoint or
  // credential cannot permanently bind a durable queue to a configuration the providers reject.
  validateProviderSettings(settings);
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
  /**
   * Completed writes invalidate the inspection view. The durable worker applies both fresh
   * ingestion and replayed recovery plans through this preparer, so one hook covers both. The
   * dashboard that receives the invalidation is attached once the service it reads exists.
   */
  const inspection: { invalidate(): void } = { invalidate: () => undefined };
  const memory: MemoryPreparer =
    options.dashboard === undefined
      ? providers.memory()
      : {
          prepare: (input) => providers.memory().prepare(input),
          apply: async (plan) => {
            const note = await providers.memory().apply(plan);
            inspection.invalidate();
            return note;
          },
        };
  const queue = await openIngestionQueue({
    directory: settings.dataDirectory,
    binding: {
      endpoint: settings.qdrant.url,
      collection: settings.qdrant.collection,
      embeddingSpace: { ...referenceEmbeddingSpace },
    },
    memory,
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
  const dashboard: BundledDashboard | undefined =
    options.dashboard === undefined
      ? undefined
      : openBundledDashboard({ service, dashboard: options.dashboard });
  if (dashboard !== undefined) {
    inspection.invalidate = () => {
      dashboard.invalidate();
    };
  }
  try {
    // Worker ownership is acquired before the listener is exposed.
    await queue.start();
  } catch (cause) {
    await dashboard?.stop();
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
      ...(dashboard === undefined ? {} : { dashboard: dashboard.routes }),
    });
  } catch (cause) {
    await dashboard?.stop();
    await queue.close();
    await providers.stop();
    throw cause;
  }
  const supervisor = new WorkerSupervisor({
    worker: queue,
    intervalMs: options.supervisionIntervalMs ?? defaultSupervisionIntervalMs,
  });
  supervisor.start();
  // The listener answers while the first export and projection run in the background.
  dashboard?.start();

  let stopping: Promise<void> | undefined;
  return {
    port: server.port,
    service,
    queue,
    stop: () => {
      stopping ??= (async () => {
        // Stop admitting requests, stop claiming new durable work, then let accepted requests and
        // the active operation settle before the providers and the journal are released.
        service.beginShutdown();
        const stoppingDashboard = dashboard?.stop();
        await supervisor.stop();
        const stoppingQueue = queue.stop();
        const closing = server.close();
        await server.settled();
        await stoppingDashboard;
        await closing;
        await stoppingQueue;
        await providers.stop();
        await queue.close();
      })();
      return stopping;
    },
  };
};
