/**
 * Offline maintenance host of the local memory service: the reviewed context-correction command
 * documented in docs/service.md#operator-context-correction. It validates the proposal before any
 * provider work, opens the configured journal, and composes Memory's preparation with the queue's
 * `correctContext`, so the pinned encoder and compatible collection initialize only inside the
 * queue's exclusive writer ownership. It loads no HTTP listener, dashboard, ingestion worker or
 * model invocation, and reports acknowledged, unchanged or unresolved outcomes as structured JSON.
 *
 * See docs/service.md#operator-context-correction and docs/ingestion-queue.md#context-maintenance.
 */
import { readFile } from "node:fs/promises";

import {
  AgenticMemory,
  MemoryError,
  QueueBindingError,
  QueueClosedError,
  QueueRequestError,
  QueueStateConflictError,
  QueueWorkerLockedError,
  contextCorrectionInputSchema,
  openIngestionQueue,
  referenceEmbeddingSpace,
  type ContextCorrectionInput,
  type ContextCorrectionPreparer,
  type IngestionQueue,
  type MemoryPreparer,
} from "../src/index.js";
import {
  defaultProviderFactories,
  sameEmbeddingSpace,
  type ProviderFactories,
} from "./providers.js";
import { validateProviderSettings, type ServiceSettings } from "./settings.js";

/** The safe error codes of the offline correction command; service/README.md documents them. */
type MaintenanceErrorCode =
  | "invalid-proposal"
  | "invalid-configuration"
  | "stale-proposal"
  | "preparation-failed"
  | "ownership-conflict"
  | "conflict"
  | "internal";

export interface MaintenanceCommandOptions {
  readonly settings: ServiceSettings;
  /** Controlled provider construction for component tests; the pinned providers by default. */
  readonly factories?: Partial<ProviderFactories>;
  /** Structured result sinks; the process streams by default. */
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

/** A refused command line or proposal file; it carries only the command's own safe text. */
class MaintenanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceInputError";
  }
}

/** One opened maintenance stack: the Memory composition and the encoder it must release. */
interface MaintenanceMemory {
  readonly memory: AgenticMemory;
  close(): Promise<void>;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : "The context correction command failed.";

const errorOutput = (
  code: MaintenanceErrorCode,
  message: string,
): { readonly error: { readonly code: string; readonly message: string } } => ({
  error: { code, message },
});

/** Read the `correct-context --input <proposal.json>` command line. */
const parseArguments = (argv: readonly string[]): string => {
  if (argv[0] !== "correct-context") {
    throw new MaintenanceInputError(
      'The maintenance command must be "correct-context".',
    );
  }
  let input: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new MaintenanceInputError(
          '"--input" requires a proposal file path.',
        );
      }
      if (input !== undefined) {
        throw new MaintenanceInputError(
          '"--input" was supplied more than once.',
        );
      }
      input = value;
      index += 1;
      continue;
    }
    throw new MaintenanceInputError(`Unknown argument "${String(argument)}".`);
  }
  if (input === undefined) {
    throw new MaintenanceInputError(
      'correct-context requires "--input <proposal.json>".',
    );
  }
  return input;
};

/** Read and validate one reviewed proposal with Memory's own exported input schema. */
const readProposal = async (path: string): Promise<ContextCorrectionInput> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new MaintenanceInputError("The proposal file could not be read.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new MaintenanceInputError("The proposal file is not valid JSON.");
  }
  const parsed = contextCorrectionInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new MaintenanceInputError(
      "The proposal is not a valid context correction input.",
    );
  }
  return parsed.data;
};

/**
 * Open the pinned encoder and the compatible collection for one maintenance session. The loaded
 * encoder must declare the space the queue binding owns; the model transport is composed from the
 * same host settings but is never invoked, because correction has no generation step.
 */
const openMemory = async (
  settings: ServiceSettings,
  factories: ProviderFactories,
): Promise<MaintenanceMemory> => {
  const embedder = await factories.openEmbedder({
    cacheDir: settings.embedding.cacheDir,
    allowDownloads: settings.embedding.allowDownloads,
  });
  try {
    if (!sameEmbeddingSpace(embedder.space, referenceEmbeddingSpace)) {
      throw new Error(
        "The loaded encoder declares a different embedding space than the configured collection.",
      );
    }
    const store = await factories.openStore({
      url: settings.qdrant.url,
      collection: settings.qdrant.collection,
      timeoutMs: settings.qdrant.timeoutMs,
      space: embedder.space,
      ...(settings.qdrant.apiKey === undefined
        ? {}
        : { apiKey: settings.qdrant.apiKey }),
    });
    const model = factories.createModel({
      endpoint: settings.model.endpoint,
      model: settings.model.model,
      timeoutMs: settings.model.timeoutMs,
      maxOutputTokens: settings.model.maxOutputTokens,
      ...(settings.model.apiKey === undefined
        ? {}
        : { apiKey: settings.model.apiKey }),
    });
    return {
      memory: new AgenticMemory(store, embedder, model),
      close: async () => {
        await factories.closeEmbedder?.(embedder);
      },
    };
  } catch (cause) {
    await factories.closeEmbedder?.(embedder).catch(() => undefined);
    throw cause;
  }
};

/** Map one failed correction onto a safe outcome the operator can act on. */
const classifyFailure = (
  cause: unknown,
): {
  readonly code: MaintenanceErrorCode;
  readonly message: string;
} => {
  if (cause instanceof MaintenanceInputError) {
    return { code: "invalid-proposal", message: cause.message };
  }
  if (cause instanceof QueueWorkerLockedError) {
    return { code: "ownership-conflict", message: cause.message };
  }
  if (cause instanceof QueueBindingError) {
    return { code: "invalid-configuration", message: cause.message };
  }
  if (cause instanceof QueueStateConflictError) {
    return { code: "conflict", message: cause.reason };
  }
  if (cause instanceof MemoryError) {
    return cause.operation === "prepareContextCorrection" &&
      cause.stage === "read"
      ? { code: "stale-proposal", message: cause.reason }
      : { code: "preparation-failed", message: cause.reason };
  }
  if (cause instanceof QueueRequestError) {
    return { code: "invalid-proposal", message: cause.reason };
  }
  if (cause instanceof QueueClosedError) {
    return {
      code: "internal",
      message: "The durable queue is not available right now.",
    };
  }
  return {
    code: "internal",
    message:
      "The context correction command could not complete; no reviewed change was applied.",
  };
};

/**
 * Run the offline reviewed context correction. The proposal is validated before the journal or a
 * provider is touched, providers initialize inside the queue's writer ownership, and the returned
 * status is the process exit code: `0` for an acknowledged or unchanged correction, `1` otherwise.
 */
export const runMaintenanceCommand = async (
  argv: readonly string[],
  options: MaintenanceCommandOptions,
): Promise<number> => {
  const writeOut =
    options.stdout ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const writeErr =
    options.stderr ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });

  let proposal: ContextCorrectionInput;
  try {
    proposal = await readProposal(parseArguments(argv));
  } catch (cause) {
    const failure = classifyFailure(cause);
    writeErr(JSON.stringify(errorOutput(failure.code, failure.message)));
    return 1;
  }
  try {
    // The provider-owned configuration rules run before the journal is opened, exactly as in the
    // service, so a malformed endpoint or credential cannot touch durable state.
    validateProviderSettings(options.settings);
  } catch (cause) {
    writeErr(
      JSON.stringify(errorOutput("invalid-configuration", messageOf(cause))),
    );
    return 1;
  }

  const factories: ProviderFactories = {
    ...defaultProviderFactories,
    ...options.factories,
  };
  // Provider initialization is deferred until the queue's correction lock is held, so the offline
  // session never opens an encoder or collection as a competing writer.
  let opening: Promise<MaintenanceMemory> | undefined;
  const opened = (): Promise<MaintenanceMemory> =>
    (opening ??= openMemory(options.settings, factories));
  const preparer: MemoryPreparer & ContextCorrectionPreparer = {
    prepare: async (input) => (await opened()).memory.prepare(input),
    apply: async (plan) => (await opened()).memory.apply(plan),
    prepareContextCorrection: async (input) =>
      (await opened()).memory.prepareContextCorrection(input),
  };

  let queue: IngestionQueue | undefined;
  try {
    queue = await openIngestionQueue({
      directory: options.settings.dataDirectory,
      binding: {
        endpoint: options.settings.qdrant.url,
        collection: options.settings.qdrant.collection,
        embeddingSpace: { ...referenceEmbeddingSpace },
      },
      memory: preparer,
    });
    const result = await queue.correctContext(proposal, preparer);
    writeOut(
      JSON.stringify({
        noteId: result.note.id,
        changed: result.changed,
        note: result.note,
      }),
    );
    return 0;
  } catch (cause) {
    const failure = classifyFailure(cause);
    writeErr(JSON.stringify(errorOutput(failure.code, failure.message)));
    return 1;
  } finally {
    await queue?.close().catch((cause: unknown) => {
      console.error(
        "[maintenance] the queue journal could not be closed:",
        cause,
      );
    });
    await opening
      ?.then(
        (open) => open.close(),
        () => undefined,
      )
      .catch((cause: unknown) => {
        console.error(
          "[maintenance] the encoder could not be released:",
          cause,
        );
      });
  }
};
