import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgenticMemory,
  QueueBindingError,
  QueueClosedError,
  QueueConflictError,
  QueueReceiptNotFoundError,
  QueueRequestError,
  QueueStateConflictError,
  QueueWorkerLockedError,
  openIngestionQueue,
  representationVersion,
  type ContextCorrectionInput,
  type ContextCorrectionPreparation,
  type ContextCorrectionPreparer,
  type IngestionQueue,
  type InsertionPlan,
  type LegacyReceipt,
  type MemoryPreparer,
  type Note,
  type PrepareInput,
  type QueueBinding,
  type QueueObservation,
  type QueueReceipt,
} from "../../src/index.js";
import {
  ControlledEmbedder,
  RecordingStore,
  ScriptedModel,
  flush,
  deferred,
  rejection,
} from "./support/memory-harness.js";

/**
 * Component tests for the durable ingestion queue: concurrent submissions, source-key
 * deduplication, one writer per collection, retry and blocking behavior, persisted insertion
 * plans with restart replay, legacy receipt migration and status reporting.
 *
 * See docs/ingestion-queue.md#visibility-and-verification.
 */

const NOTE_TIMESTAMP = "2026-09-27T15:44:27.001+02:00";
const CANDIDATE_ID = "6f2bb0d4-1c1e-4a2b-8f43-1c9a3d4c5e02";
const OTHER_ID = "b1c2d3e4-f506-4a7b-8c9d-0e1f2a3b4c05";
const LEGACY_RECEIPT_ID = "9d1e2f30-4a5b-4c6d-8e7f-0a1b2c3d4e05";
/** A credential-shaped marker that public failure text must never repeat. */
const CREDENTIAL_MARKER = "sk-live-CREDENTIAL-MARKER-0123456789";

const attributes = (
  context: string,
  keywords: string[],
  tags: string[],
): unknown => ({ context, keywords, tags });

const CONSTRUCTED = (): unknown =>
  attributes("Records the incoming account.", ["account"], ["incoming"]);

const candidate = (overrides: Partial<Note> = {}): Note => ({
  id: CANDIDATE_ID,
  content: "An earlier observation.",
  timestamp: NOTE_TIMESTAMP,
  context: "An earlier observation about the same subject.",
  keywords: ["observation"],
  tags: ["history"],
  links: [],
  metadata: { origin: "host" },
  ...overrides,
});

const unchanged = (): unknown => ({
  links: [],
  newTags: ["incoming"],
  updates: [],
});

/** A Memory implementation that records the durable operations the worker consumed. */
class RecordingMemory implements MemoryPreparer {
  readonly prepares: PrepareInput[] = [];
  readonly applies: InsertionPlan[] = [];
  readonly #memory: MemoryPreparer;

  constructor(memory: MemoryPreparer) {
    this.#memory = memory;
  }

  async prepare(input: PrepareInput): Promise<InsertionPlan> {
    this.prepares.push(structuredClone(input));
    return await this.#memory.prepare(input);
  }

  async apply(plan: InsertionPlan): Promise<Note> {
    this.applies.push(plan);
    return await this.#memory.apply(plan);
  }
}

/** A correction capability that records its preparations, to prove none is repeated. */
class RecordingCorrectionPreparer implements ContextCorrectionPreparer {
  readonly preparations: ContextCorrectionPreparation[] = [];
  readonly #preparer: ContextCorrectionPreparer;

  constructor(preparer: ContextCorrectionPreparer) {
    this.#preparer = preparer;
  }

  async prepareContextCorrection(
    input: ContextCorrectionInput,
  ): Promise<ContextCorrectionPreparation> {
    const preparation = await this.#preparer.prepareContextCorrection(input);
    this.preparations.push(preparation);
    return preparation;
  }
}

interface Harness {
  readonly queue: IngestionQueue;
  readonly store: RecordingStore;
  readonly embedder: ControlledEmbedder;
  readonly model: ScriptedModel;
  readonly memory: AgenticMemory;
  readonly preparer: RecordingMemory;
  readonly directory: string;
}

const temporaryDirectories: string[] = [];
const openQueues: IngestionQueue[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const queue of openQueues.splice(0)) {
    await queue.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "amem-queue-"));
  temporaryDirectories.push(directory);
  return directory;
};

/**
 * Own the queue's canonical writer lock as the previous build's worker did, so an in-place schema
 * upgrade must refuse while an old writer could still mutate the journal.
 */
const holdQueueLock = async (
  journalPath: string,
): Promise<() => Promise<void>> => {
  const name = `\0amem-ingestion-queue:${createHash("sha256")
    .update(journalPath)
    .digest("hex")}`;
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.end("worker");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(name, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((cause) => {
        if (cause === undefined) {
          resolve();
          return;
        }
        reject(cause);
      });
    });
  };
};

/** The reviewed replacement of one seeded note's context, keeping its other attributes. */
const correctionInput = (
  note: Note,
  context: string,
): ContextCorrectionInput => ({
  expected: note,
  attributes: { context, keywords: note.keywords, tags: note.tags },
});

const createHarness = async (
  options: {
    directory?: string;
    store?: RecordingStore;
    embedder?: ControlledEmbedder;
    model?: ScriptedModel;
    pollIntervalMs?: number;
  } = {},
): Promise<Harness> => {
  const store = options.store ?? new RecordingStore();
  const embedder = options.embedder ?? new ControlledEmbedder();
  const model = options.model ?? new ScriptedModel();
  const memory = new AgenticMemory(store, embedder, model);
  const preparer = new RecordingMemory(memory);
  const directory = options.directory ?? (await temporaryDirectory());
  const queue = await openIngestionQueue({
    directory,
    binding: {
      endpoint: "http://127.0.0.1:6333",
      collection: "memories",
      embeddingSpace: { ...embedder.space },
    },
    memory: preparer,
    pollIntervalMs: options.pollIntervalMs ?? 10,
  });
  openQueues.push(queue);
  return { queue, store, embedder, model, memory, preparer, directory };
};

/** Advance virtual time in small steps until a durable condition holds. */
const settle = async (
  condition: () => boolean | Promise<boolean>,
  description: string,
  limitMs = 10_000,
): Promise<void> => {
  for (let elapsed = 0; elapsed <= limitMs; elapsed += 10) {
    if (await condition()) {
      return;
    }
    await vi.advanceTimersByTimeAsync(10);
    await flush();
  }
  throw new Error(`Timed out waiting for ${description}.`);
};

const receiptOf = async (
  queue: IngestionQueue,
  id: string,
): Promise<QueueReceipt> => {
  const receipt = await queue.receipt(id);
  if (receipt === undefined) {
    throw new Error(`The queue has no receipt ${id}.`);
  }
  return receipt;
};

/** Retry timing and backoff run on a controlled clock; no test sleeps on a real timer. */
beforeEach(() => {
  vi.useFakeTimers();
});

describe("durable submission", () => {
  it("accepts concurrent unique submissions and returns one receipt each", async () => {
    const harness = await createHarness();
    const observations: QueueObservation[] = [
      { sourceKey: "source-a", content: "Observation A." },
      {
        sourceKey: "source-b",
        content: "Observation B.",
        timestamp: NOTE_TIMESTAMP,
      },
      {
        sourceKey: "source-c",
        content: "Observation C.",
        provenance: { host: "cli" },
      },
    ];

    const receipts = await Promise.all(
      observations.map((observation) => harness.queue.submit(observation)),
    );

    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(3);
    expect(receipts.map((receipt) => receipt.status)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
    expect(receipts.map((receipt) => receipt.attemptCount)).toEqual([0, 0, 0]);
    expect(receipts[1]?.sourceKey).toBe("source-b");
    // The acceptance is durable before the submission resolves and is not yet searchable.
    expect(receipts.every((receipt) => receipt.noteId === undefined)).toBe(
      true,
    );
    const status = await harness.queue.status();
    expect(status).toMatchObject({
      worker: "stopped",
      accepted: 3,
      backlog: 3,
      counts: { queued: 3, stored: 0, retrying: 0, blocked: 0 },
    });
  });

  it("returns the existing receipt for an identical resubmission and refuses a changed one", async () => {
    const harness = await createHarness();
    const accepted = await harness.queue.submit({
      sourceKey: "source-key",
      content: "The observation.",
      provenance: { host: "cli", task: "AMEM-12" },
    });

    const resubmitted = await harness.queue.submit({
      sourceKey: "source-key",
      content: "The observation.",
      provenance: { task: "AMEM-12", host: "cli" },
    });

    expect(accepted.created).toBe(true);
    // The identical resubmission finds the same receipt, but this call created nothing.
    expect(resubmitted).toEqual({ ...accepted, created: false });
    expect((await harness.queue.status()).accepted).toBe(1);
    await expect(
      harness.queue.submit({
        sourceKey: "source-key",
        content: "Another observation.",
      }),
    ).rejects.toBeInstanceOf(QueueConflictError);
    await expect(
      harness.queue.submit({
        sourceKey: "source-key",
        content: "The observation.",
        provenance: { host: "other" },
      }),
    ).rejects.toBeInstanceOf(QueueConflictError);
    expect((await harness.queue.status()).accepted).toBe(1);
    expect((await receiptOf(harness.queue, accepted.id)).sourceKey).toBe(
      "source-key",
    );
  });

  it("rejects invalid submissions before accepting anything", async () => {
    const harness = await createHarness();
    const invalid: ReadonlyArray<[string, unknown]> = [
      ["an empty source key", { sourceKey: "", content: "Text." }],
      ["whitespace-only content", { sourceKey: "k", content: " \n\t " }],
      [
        "a timestamp without a timezone",
        { sourceKey: "k", content: "Text.", timestamp: "2026-09-27T15:44:27" },
      ],
      [
        "provenance that is not a JSON object",
        { sourceKey: "k", content: "Text.", provenance: [1, 2] },
      ],
      ["an unknown field", { sourceKey: "k", content: "Text.", body: "Text." }],
    ];

    for (const [description, observation] of invalid) {
      await expect(
        harness.queue.submit(observation as QueueObservation),
        description,
      ).rejects.toBeInstanceOf(QueueRequestError);
    }
    expect((await harness.queue.status()).accepted).toBe(0);
  });

  it("rejects a submission when the journal cannot write, keeping accepted work", async () => {
    const harness = await createHarness();
    const accepted = await harness.queue.submit({
      sourceKey: "kept",
      content: "Accepted before the failure.",
    });
    // A full or damaged journal fails the write; accepted observations stay untouched.
    const journal = new DatabaseSync(harness.queue.journalPath);
    journal.exec(
      "CREATE TRIGGER refuse_once BEFORE INSERT ON receipts " +
        "WHEN NEW.source_key = 'refused' " +
        "BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
    );
    journal.close();

    await expect(
      harness.queue.submit({ sourceKey: "refused", content: "Rejected." }),
    ).rejects.toThrow(/disk is full/);

    const status = await harness.queue.status();
    expect(status.accepted).toBe(1);
    expect((await receiptOf(harness.queue, accepted.id)).status).toBe("queued");
  });

  it("rejects a journal opened for another collection binding", async () => {
    const first = await createHarness();

    await expect(
      openIngestionQueue({
        directory: first.directory,
        binding: {
          endpoint: "http://127.0.0.1:6333",
          collection: "another-collection",
          embeddingSpace: { ...first.embedder.space },
        },
        memory: first.preparer,
      }),
    ).rejects.toBeInstanceOf(QueueBindingError);
  });

  it("leaves accepted work durable for a worker started by a later process", async () => {
    const directory = await temporaryDirectory();
    const store = new RecordingStore();
    const embedder = new ControlledEmbedder();
    const producer = await createHarness({ directory, store, embedder });
    const accepted = await producer.queue.submit({
      sourceKey: "source-key",
      content: "The observation.",
      timestamp: NOTE_TIMESTAMP,
    });

    // The producer exits after the acknowledgement, without ever starting a worker.
    await producer.queue.close();

    const restarted = await createHarness({ directory, store, embedder });
    restarted.model.queue("construct", CONSTRUCTED);
    await restarted.queue.start();
    await settle(
      async () =>
        (await restarted.queue.receipt(accepted.id))?.status === "stored",
      "the restored receipt to be stored",
    );

    const stored = await receiptOf(restarted.queue, accepted.id);
    expect(stored.noteId).toBeDefined();
    expect(restarted.store.stored(stored.noteId!)?.timestamp).toBe(
      NOTE_TIMESTAMP,
    );
    expect(restarted.preparer.prepares[0]?.timestamp).toBe(NOTE_TIMESTAMP);
  });
});

describe("worker lifecycle", () => {
  it("drains accepted observations in acceptance order through one worker", async () => {
    const harness = await createHarness();
    // Each observation constructs first; the two later ones also make one evolution decision
    // because the earlier notes are already stored.
    for (const index of [0, 1, 2]) {
      harness.model.queue("construct", () =>
        attributes(
          `Records source ${String(index)}.`,
          ["source"],
          ["observation"],
        ),
      );
      if (index > 0) {
        harness.model.queue("evolve", unchanged);
      }
    }

    await harness.queue.start();
    const receipts = await Promise.all(
      [0, 1, 2].map((index) =>
        harness.queue.submit({
          sourceKey: `source-${String(index)}`,
          content: `Observation ${String(index)}.`,
        }),
      ),
    );
    await settle(
      async () => (await harness.queue.status()).counts.stored === 3,
      "all three observations to be stored",
    );

    expect(
      harness.store.writes.map((batch) => batch.at(-1)!.note.content),
    ).toEqual(["Observation 0.", "Observation 1.", "Observation 2."]);
    for (const receipt of receipts) {
      expect((await receiptOf(harness.queue, receipt.id)).status).toBe(
        "stored",
      );
    }
  });

  it("refuses a second worker while its producers keep submitting", async () => {
    const first = await createHarness();
    await first.queue.start();
    const second = await createHarness({
      directory: first.directory,
      store: first.store,
      embedder: first.embedder,
      model: first.model,
    });

    await expect(second.queue.start()).rejects.toBeInstanceOf(
      QueueWorkerLockedError,
    );

    // A second producer process still submits durably; the owning worker drains the work.
    first.model.queue("construct", CONSTRUCTED);
    const accepted = await second.queue.submit({
      sourceKey: "source-key",
      content: "The observation.",
    });
    await settle(
      async () => (await first.queue.receipt(accepted.id))?.status === "stored",
      "the owning worker to drain the submission",
    );

    // Ownership is released with the worker, so a restart can take over.
    await first.queue.stop();
    await second.queue.start();
  });

  it("settles the active operation on a graceful stop and claims no more work", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    const gate = harness.store.holdWrites();
    await harness.queue.start();
    const active = await harness.queue.submit({
      sourceKey: "active",
      content: "The active observation.",
    });
    await settle(
      async () =>
        (await harness.queue.receipt(active.id))?.status === "processing",
      "the first observation to be claimed",
    );
    const waiting = await harness.queue.submit({
      sourceKey: "waiting",
      content: "The waiting observation.",
    });

    const stopping = harness.queue.stop();
    await flush();
    expect((await receiptOf(harness.queue, active.id)).status).toBe(
      "processing",
    );
    gate.resolve();
    await stopping;

    expect((await receiptOf(harness.queue, active.id)).status).toBe("stored");
    expect((await receiptOf(harness.queue, waiting.id)).status).toBe("queued");
    expect((await harness.queue.status()).worker).toBe("stopped");
  });

  it.each(["stop", "close"] as const)(
    "%s leaves queued work unclaimed when journal selection is pending",
    async (operation) => {
      const harness = await createHarness();
      harness.model.queue("construct", CONSTRUCTED);
      const accepted = await harness.queue.submit({
        sourceKey: "waiting",
        content: "Waiting.",
      });
      // start resolves while the worker awaits its first journal selection.
      await harness.queue.start();
      expect(harness.preparer.prepares).toEqual([]);
      await harness.queue[operation]();
      const reopened = await createHarness({ directory: harness.directory });
      expect(await receiptOf(reopened.queue, accepted.id)).toMatchObject({
        status: "queued",
        attemptCount: 0,
      });
      expect(harness.preparer.prepares).toEqual([]);
      expect(harness.preparer.applies).toEqual([]);
      expect((await reopened.queue.status()).worker).toBe("stopped");
    },
  );

  it("settles a stop that arrives while ownership is still being acquired", async () => {
    const harness = await createHarness();

    // A shutdown handler that runs before startup finished must not leave a worker behind.
    const starting = harness.queue.start();
    await harness.queue.stop();
    await starting;

    const accepted = await harness.queue.submit({
      sourceKey: "after-stop",
      content: "The observation.",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await receiptOf(harness.queue, accepted.id)).status).toBe("queued");
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.writes).toEqual([]);
    expect((await harness.queue.status()).worker).toBe("stopped");

    // A later explicit start runs again and drains the work the stop left durable.
    harness.model.queue("construct", CONSTRUCTED);
    await harness.queue.start();
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the explicitly restarted worker to drain",
    );
  });

  it("shares one completion between a close, a pending start and its own retry", async () => {
    const harness = await createHarness();

    const starting = rejection(harness.queue.start());
    await harness.queue.close();
    expect(await starting).toBeInstanceOf(QueueClosedError);

    // Concurrent closes settle on the same completion instead of closing the journal twice.
    await expect(
      Promise.all([
        harness.queue.close(),
        harness.queue.close(),
        harness.queue.close(),
      ]),
    ).resolves.toBeDefined();
    await expect(harness.queue.status()).rejects.toBeInstanceOf(
      QueueClosedError,
    );
    await expect(
      harness.queue.submit({ sourceKey: "closed", content: "Closed." }),
    ).rejects.toBeInstanceOf(QueueClosedError);
  });

  it("lets a start issued after a stop take over the ownership the stop released", async () => {
    const harness = await createHarness();
    await harness.queue.start();

    // The stop and the start race: the later start waits for the stop to release ownership.
    await Promise.all([harness.queue.stop(), harness.queue.start()]);
    expect((await harness.queue.status()).worker).toBe("running");

    harness.model.queue("construct", CONSTRUCTED);
    const accepted = await harness.queue.submit({
      sourceKey: "after-restart",
      content: "The observation.",
    });
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the restarted worker to drain",
    );
  });

  it("refuses a second worker that names the journal through a filesystem alias", async () => {
    const first = await createHarness();
    await first.queue.start();
    const aliases = await temporaryDirectory();

    // The same journal reached through a directory symlink.
    const directoryAlias = path.join(aliases, "directory-alias");
    await symlink(first.directory, directoryAlias, "dir");
    const viaDirectory = await createHarness({
      directory: directoryAlias,
      store: first.store,
      embedder: first.embedder,
      model: first.model,
    });
    expect(viaDirectory.queue.journalPath).toBe(first.queue.journalPath);
    await expect(viaDirectory.queue.start()).rejects.toBeInstanceOf(
      QueueWorkerLockedError,
    );

    // And the same journal reached through a file symlink.
    const fileAlias = path.join(aliases, "file-alias");
    await mkdir(fileAlias, { recursive: true });
    await symlink(
      first.queue.journalPath,
      path.join(fileAlias, "ingestion-queue.sqlite"),
      "file",
    );
    const viaFile = await createHarness({
      directory: fileAlias,
      store: first.store,
      embedder: first.embedder,
      model: first.model,
    });
    expect(viaFile.queue.journalPath).toBe(first.queue.journalPath);
    await expect(viaFile.queue.start()).rejects.toBeInstanceOf(
      QueueWorkerLockedError,
    );
  });

  it("keeps reads available while a write is in flight", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    const gate = harness.store.holdWrites();
    await harness.queue.start();
    const accepted = await harness.queue.submit({
      sourceKey: "source-key",
      content: "The observation.",
    });
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "processing",
      "the write to be in flight",
    );

    // Retrieval goes through the ordinary API and never waits for the ingestion backlog.
    await expect(harness.memory.get(candidate().id)).resolves.toBeUndefined();
    await expect(
      harness.memory.search("query", { linkedLimit: 0 }),
    ).resolves.toEqual([]);

    gate.resolve();
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the write to settle",
    );
  });
});

describe("retry, blocking and recovery", () => {
  it("retries a transient failure with bounded backoff and keeps later work behind it", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", unchanged);
    harness.store.nearestError = new Error("the search request failed");
    await harness.queue.start();
    const first = await harness.queue.submit({
      sourceKey: "first",
      content: "The first observation.",
    });
    const second = await harness.queue.submit({
      sourceKey: "second",
      content: "The second observation.",
    });

    await settle(
      async () =>
        (await harness.queue.receipt(first.id))?.status === "retrying",
      "the first receipt to retry",
    );
    const firstRetry = await receiptOf(harness.queue, first.id);
    expect(firstRetry.attemptCount).toBe(1);
    expect(firstRetry.lastError).toBe(
      "The note store failed to return nearest neighbors.",
    );
    expect(
      Date.parse(firstRetry.nextRetryAt!) - Date.parse(firstRetry.updatedAt),
    ).toBe(1_000);
    // The unresolved write retains its position: later observations are not written first.
    expect((await receiptOf(harness.queue, second.id)).status).toBe("queued");
    expect(harness.store.writes).toEqual([]);

    await settle(
      async () => (await harness.queue.receipt(first.id))?.attemptCount === 2,
      "the second attempt",
    );
    const secondRetry = await receiptOf(harness.queue, first.id);
    expect(secondRetry.status).toBe("retrying");
    expect(
      Date.parse(secondRetry.nextRetryAt!) - Date.parse(secondRetry.updatedAt),
    ).toBe(2_000);

    harness.store.nearestError = undefined;
    await settle(
      async () => (await harness.queue.receipt(first.id))?.status === "stored",
      "the healed retry to succeed",
    );
    await settle(
      async () => (await harness.queue.receipt(second.id))?.status === "stored",
      "the later observation to succeed",
    );
    expect(
      harness.store.writes.map((batch) => batch.at(-1)!.note.content),
    ).toEqual(["The first observation.", "The second observation."]);
  });

  it("replays the exact persisted plan after a lost write acknowledgement", async () => {
    const harness = await createHarness();
    const current = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", () => ({
      links: [current.id],
      newTags: ["incoming"],
      updates: [
        {
          id: current.id,
          context: "The earlier observation now supports the incoming account.",
          keywords: ["observation"],
          tags: ["history"],
        },
      ],
    }));
    harness.store.failNextWrites(new Error("the connection was reset"));
    await harness.queue.start();
    const accepted = await harness.queue.submit({
      sourceKey: "source-key",
      content: "The incoming account.",
    });

    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "retrying",
      "the uncertain write to be recorded",
    );
    const retrying = await receiptOf(harness.queue, accepted.id);
    expect(retrying.attemptCount).toBe(1);
    expect(retrying.lastError).toBe(
      "The note store rejected the prepared batch, so its outcome is uncertain.",
    );
    const prepares = harness.preparer.prepares.length;
    const embeddedTexts = [...harness.embedder.texts];

    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the exact plan to be replayed",
    );

    const stored = await receiptOf(harness.queue, accepted.id);
    expect(stored.noteId).toBeDefined();
    // The replay regenerated nothing and applied one batch with the intended neighbor update.
    expect(harness.preparer.prepares).toHaveLength(prepares);
    expect(harness.embedder.texts).toEqual(embeddedTexts);
    expect(harness.model.requests).toHaveLength(2);
    expect(harness.store.writes).toHaveLength(1);
    const [batch] = harness.store.writes;
    expect(batch?.map((record) => record.note.id)).toEqual([
      current.id,
      stored.noteId,
    ]);
    expect(batch?.[0]?.note.updatedAt).toBe(batch?.[1]?.note.updatedAt);
    expect(harness.store.stored(current.id)).toEqual(batch?.[0]?.note);
    expect(harness.store.stored(stored.noteId!)).toEqual(batch?.[1]?.note);
  });

  it("replays the persisted plan after a worker restart without re-preparing", async () => {
    const directory = await temporaryDirectory();
    const store = new RecordingStore();
    const embedder = new ControlledEmbedder();
    const model = new ScriptedModel();
    const crashed = await createHarness({ directory, store, embedder, model });
    store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => ({
      links: [CANDIDATE_ID],
      newTags: ["incoming"],
      updates: [],
    }));
    store.failNextWrites(new Error("the connection was reset"));
    await crashed.queue.start();
    const accepted = await crashed.queue.submit({
      sourceKey: "source-key",
      content: "The incoming account.",
    });
    await settle(
      async () =>
        (await crashed.queue.receipt(accepted.id))?.status === "retrying",
      "the plan to be committed",
    );
    await crashed.queue.close();

    const restarted = await createHarness({
      directory,
      store,
      embedder,
      model,
    });
    await restarted.queue.start();
    await settle(
      async () =>
        (await restarted.queue.receipt(accepted.id))?.status === "stored",
      "the committed plan to be replayed after restart",
    );

    expect(crashed.preparer.prepares).toHaveLength(1);
    expect(restarted.preparer.prepares).toEqual([]);
    expect(model.requests).toHaveLength(2);
    const stored = await receiptOf(restarted.queue, accepted.id);
    expect(store.stored(stored.noteId!)?.links).toEqual([CANDIDATE_ID]);
  });

  it("replays every prepared record after a partial batch write", async () => {
    const harness = await createHarness();
    const current = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", () => ({
      links: [current.id],
      newTags: ["incoming"],
      updates: [
        {
          id: current.id,
          context: "The earlier observation now supports the incoming account.",
          keywords: ["observation"],
          tags: ["history"],
        },
      ],
    }));
    // The neighbor update lands, the incoming note does not, and the acknowledgement is lost.
    harness.store.partialWriteFailures.push(
      new Error("the connection was reset"),
    );
    await harness.queue.start();
    const accepted = await harness.queue.submit({
      sourceKey: "source-key",
      content: "The incoming account.",
    });
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "retrying",
      "the partial batch write to be recorded",
    );
    expect(harness.store.stored(current.id)?.context).toBe(
      "The earlier observation now supports the incoming account.",
    );

    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the interrupted batch to be replayed",
    );

    const stored = await receiptOf(harness.queue, accepted.id);
    const [batch] = harness.store.writes;
    expect(batch?.map((record) => record.note.id)).toEqual([
      current.id,
      stored.noteId,
    ]);
    // The replayed neighbor update and incoming note are exactly the prepared records.
    expect(harness.store.stored(current.id)).toEqual(batch?.[0]?.note);
    expect(harness.store.stored(stored.noteId!)).toEqual(batch?.[1]?.note);
    expect(batch?.[0]?.note.updatedAt).toBe(batch?.[1]?.note.updatedAt);
    expect(harness.store.records.size).toBe(2);
  });

  it("restarts preparation with the accepted identity when no plan was committed", async () => {
    const directory = await temporaryDirectory();
    const store = new RecordingStore();
    const embedder = new ControlledEmbedder();
    const model = new ScriptedModel();
    const crashed = await createHarness({ directory, store, embedder, model });
    model.queue("construct", CONSTRUCTED);
    store.nearestError = new Error("the search request failed");
    await crashed.queue.start();
    const accepted = await crashed.queue.submit({
      sourceKey: "source-key",
      content: "The incoming account.",
      timestamp: NOTE_TIMESTAMP,
    });
    await settle(
      async () =>
        (await crashed.queue.receipt(accepted.id))?.status === "retrying",
      "the first attempt to fail before a plan existed",
    );
    expect(crashed.preparer.prepares).toHaveLength(1);
    await crashed.queue.close();

    const restarted = await createHarness({
      directory,
      store,
      embedder,
      model,
    });
    store.nearestError = undefined;
    model.queue("construct", CONSTRUCTED);
    await restarted.queue.start();
    await settle(
      async () =>
        (await restarted.queue.receipt(accepted.id))?.status === "stored",
      "preparation to restart",
    );

    expect(restarted.preparer.prepares).toHaveLength(1);
    expect(restarted.preparer.prepares[0]?.noteId).toBe(
      crashed.preparer.prepares[0]?.noteId,
    );
    expect(restarted.preparer.prepares[0]?.timestamp).toBe(NOTE_TIMESTAMP);
    const stored = await receiptOf(restarted.queue, accepted.id);
    expect(stored.noteId).toBe(restarted.preparer.prepares[0]?.noteId);
    expect(store.stored(stored.noteId!)?.timestamp).toBe(NOTE_TIMESTAMP);
  });

  it("blocks a receipt whose committed plan was lost instead of preparing again", async () => {
    const directory = await temporaryDirectory();
    const store = new RecordingStore();
    const embedder = new ControlledEmbedder();
    const model = new ScriptedModel();
    const crashed = await createHarness({ directory, store, embedder, model });
    store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => ({
      links: [CANDIDATE_ID],
      newTags: ["incoming"],
      updates: [],
    }));
    store.failNextWrites(new Error("the connection was reset"));
    await crashed.queue.start();
    const accepted = await crashed.queue.submit({
      sourceKey: "source-key",
      content: "The incoming account.",
    });
    await settle(
      async () =>
        (await crashed.queue.receipt(accepted.id))?.status === "retrying",
      "the plan to be committed",
    );
    await crashed.queue.close();

    // A partial journal write or a restoring backup drops the plan but keeps the commit evidence.
    const journal = new DatabaseSync(crashed.queue.journalPath);
    journal
      .prepare("UPDATE receipts SET plan = NULL WHERE id = ?")
      .run(accepted.id);
    journal.close();

    const restarted = await createHarness({
      directory,
      store,
      embedder,
      model,
    });
    await restarted.queue.start();
    await settle(
      async () =>
        (await restarted.queue.receipt(accepted.id))?.status === "blocked",
      "the lost plan to block the queue",
    );
    const blocked = await receiptOf(restarted.queue, accepted.id);
    expect(blocked.nextRetryAt).toBeUndefined();
    expect(blocked.lastError).toContain("missing");
    // Regeneration could change attributes, timestamps and neighbor updates, so none happened.
    expect(restarted.preparer.prepares).toEqual([]);
    expect(model.requests).toHaveLength(2);

    // The operator confirms the insertion was not applied, so preparation restarts exactly.
    model.queue("construct", CONSTRUCTED);
    model.queue("evolve", () => ({
      links: [CANDIDATE_ID],
      newTags: ["incoming"],
      updates: [],
    }));
    const reconciled = await restarted.queue.reconcile(accepted.id, {
      outcome: "not-written",
    });
    expect(reconciled.status).toBe("queued");
    await settle(
      async () =>
        (await restarted.queue.receipt(accepted.id))?.status === "stored",
      "the reconciled receipt to be prepared again",
    );
    expect(restarted.preparer.prepares).toHaveLength(1);
    expect(restarted.preparer.prepares[0]?.noteId).toBe(
      crashed.preparer.prepares[0]?.noteId,
    );
  });

  it("fails invalid model output explicitly and continues with later work", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", () => ({ context: "Only a context." }));
    harness.model.queue("construct", CONSTRUCTED);
    await harness.queue.start();
    const invalid = await harness.queue.submit({
      sourceKey: "invalid",
      content: "The invalid observation.",
    });
    const later = await harness.queue.submit({
      sourceKey: "later",
      content: "The later observation.",
    });

    await settle(
      async () => (await harness.queue.receipt(later.id))?.status === "stored",
      "the later observation to be stored",
    );
    const failed = await receiptOf(harness.queue, invalid.id);
    expect(failed.status).toBe("failed");
    expect(failed.nextRetryAt).toBeUndefined();
    expect(failed.noteId).toBeUndefined();
    expect(failed.lastError).toBe(
      "The construction response does not satisfy the documented contract.",
    );
    expect(harness.store.writes).toHaveLength(1);
    expect(harness.store.writes[0]?.[0]?.note.content).toBe(
      "The later observation.",
    );
  });

  it("blocks on an invalid credential signal and resumes once it is corrected", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", unchanged);
    harness.store.failNextWrites(
      Object.assign(new Error(`Unauthorized ${CREDENTIAL_MARKER}`), {
        status: 401,
      }),
    );
    await harness.queue.start();
    const first = await harness.queue.submit({
      sourceKey: "first",
      content: "The first observation.",
    });
    const second = await harness.queue.submit({
      sourceKey: "second",
      content: "The second observation.",
    });

    await settle(
      async () => (await harness.queue.receipt(first.id))?.status === "blocked",
      "the credential failure to block the queue",
    );
    const blocked = await receiptOf(harness.queue, first.id);
    expect(blocked.nextRetryAt).toBeDefined();
    expect(blocked.lastError).toContain("must be corrected");
    // Untrusted provider text never reaches a public diagnostic.
    expect(blocked.lastError).not.toContain(CREDENTIAL_MARKER);
    expect(blocked.lastError).not.toContain("Unauthorized");
    expect((await harness.queue.status()).lastError).not.toContain(
      CREDENTIAL_MARKER,
    );
    // The blocked write still owns the queue: no later observation is written.
    expect((await receiptOf(harness.queue, second.id)).status).toBe("queued");
    expect(harness.store.writes).toEqual([]);

    await settle(
      async () => (await harness.queue.receipt(first.id))?.status === "stored",
      "the corrected queue to resume",
    );
    await settle(
      async () => (await harness.queue.receipt(second.id))?.status === "stored",
      "the later observation to succeed",
    );
  });

  it.each(
    (["preparation", "application"] as const).flatMap((stage) =>
      (["same", "another"] as const).flatMap((handle) =>
        (["stored", "not-written"] as const).map((outcome) => ({
          stage,
          handle,
          outcome,
        })),
      ),
    ),
  )(
    "preserves $outcome reconciliation through $handle handle ahead of a stale $stage retry claim",
    async ({ stage, handle, outcome }) => {
      const harness = await createHarness();
      const operator =
        handle === "same"
          ? harness.queue
          : (await createHarness({ directory: harness.directory })).queue;
      const credentialFailure = Object.assign(new Error("Unauthorized"), {
        status: 401,
      });
      harness.model.queue("construct", CONSTRUCTED);
      if (stage === "preparation") {
        harness.store.nearestError = credentialFailure;
      } else {
        harness.store.failNextWrites(credentialFailure);
      }
      const accepted = await harness.queue.submit({
        sourceKey: "reconciled",
        content: "The reconciled observation.",
      });
      await harness.queue.start();
      await settle(
        async () => (await operator.receipt(accepted.id))?.status === "blocked",
        "the credential failure to block the receipt",
      );
      const blocked = await receiptOf(operator, accepted.id);
      expect(blocked.nextRetryAt).toBeDefined();
      harness.store.nearestError = undefined;

      // Hold only delivery of the next claim. Selection, journal transactions and Memory stay
      // real, while the operator deterministically commits before that stale claim can run.
      const postMessage = Worker.prototype.postMessage;
      let resumeClaim: (() => void) | undefined;
      const delivery = vi.spyOn(Worker.prototype, "postMessage");
      delivery.mockImplementation(function (
        this: Worker,
        ...args: Parameters<Worker["postMessage"]>
      ) {
        const message: unknown = args[0];
        if (
          typeof message === "object" &&
          message !== null &&
          "operation" in message &&
          message.operation === "claim"
        ) {
          resumeClaim = () => postMessage.apply(this, args);
          return;
        }
        postMessage.apply(this, args);
      });
      try {
        await settle(() => resumeClaim !== undefined, "the due retry's claim");
        const originalNoteId = harness.preparer.prepares[0]!.noteId;
        if (outcome === "stored") {
          harness.store.seed({
            note: candidate({
              id: originalNoteId,
              context: "Operator verified context.",
            }),
            vector: [1, 0, 0, 0],
          });
        }
        const recordsBefore = structuredClone(harness.store.records);
        const reconciled = await operator.reconcile(
          accepted.id,
          outcome === "stored"
            ? { outcome, noteId: originalNoteId }
            : { outcome },
        );
        expect(reconciled.status).toBe(
          outcome === "stored" ? "stored" : "queued",
        );
        // A fresh preparation must replace the discarded plan after not-written reconciliation.
        if (outcome === "not-written") {
          harness.model.queue("construct", () =>
            attributes("Fresh context.", [], []),
          );
        }
        harness.model.queue("construct", CONSTRUCTED);
        harness.model.queue("evolve", unchanged);
        const later = await harness.queue.submit({
          sourceKey: "later",
          content: "The later observation.",
        });
        delivery.mockRestore();
        resumeClaim?.();
        resumeClaim = undefined;
        await settle(
          async () => (await operator.receipt(later.id))?.status === "stored",
          "the backlog to drain after reconciliation",
        );
        const completed = await receiptOf(operator, accepted.id);
        if (outcome === "stored") {
          expect(completed).toEqual(reconciled);
          expect(harness.preparer.prepares).toHaveLength(2);
          expect(harness.preparer.applies).toHaveLength(
            stage === "application" ? 2 : 1,
          );
          expect(harness.store.records.get(originalNoteId)).toEqual(
            recordsBefore.get(originalNoteId),
          );
          expect(harness.store.writes).toHaveLength(1);
        } else {
          expect(completed).toMatchObject({
            status: "stored",
            noteId: originalNoteId,
            attemptCount: 2,
          });
          expect(harness.preparer.prepares).toHaveLength(3);
          expect(harness.store.stored(originalNoteId)?.context).toBe(
            "Fresh context.",
          );
          expect(harness.store.writes).toHaveLength(2);
        }
        await harness.queue.close();
        const reopened = await createHarness({ directory: harness.directory });
        expect(await receiptOf(reopened.queue, accepted.id)).toEqual(completed);
      } finally {
        delivery.mockRestore();
        resumeClaim?.();
      }
    },
  );

  it.each(["preparation", "application"] as const)(
    "rejects reconciliation through another handle after a retry claims %s",
    async (stage) => {
      const harness = await createHarness();
      const operator = await createHarness({ directory: harness.directory });
      const credentialFailure = Object.assign(new Error("Unauthorized"), {
        status: 401,
      });
      harness.model.queue("construct", CONSTRUCTED);
      if (stage === "preparation") {
        harness.store.nearestError = credentialFailure;
      } else {
        harness.store.failNextWrites(credentialFailure);
      }
      const accepted = await harness.queue.submit({
        sourceKey: "claimed-before-reconciliation",
        content: "The observation.",
      });
      await harness.queue.start();
      await settle(
        async () =>
          (await operator.queue.receipt(accepted.id))?.status === "blocked",
        "the initial attempt to block",
      );
      harness.store.nearestError = undefined;
      const gate =
        stage === "application" ? harness.store.holdWrites() : deferred<void>();
      if (stage === "preparation") {
        harness.model.queue("construct", async () => {
          await gate.promise;
          return CONSTRUCTED();
        });
      }
      try {
        await settle(
          async () =>
            (await operator.queue.receipt(accepted.id))?.status ===
            "processing",
          "the retry to claim the receipt",
        );
        for (const outcome of [
          { outcome: "stored", noteId: OTHER_ID },
          { outcome: "not-written" },
        ] as const) {
          await expect(
            operator.queue.reconcile(accepted.id, outcome),
          ).rejects.toBeInstanceOf(QueueRequestError);
        }
      } finally {
        gate.resolve(undefined);
      }
      await settle(
        async () =>
          (await operator.queue.receipt(accepted.id))?.status === "stored",
        "the claimed retry to complete",
      );
      expect(await receiptOf(operator.queue, accepted.id)).toMatchObject({
        noteId: harness.preparer.prepares[0]!.noteId,
        attemptCount: 2,
      });
      expect(harness.store.writes).toHaveLength(1);
    },
  );

  it("blocks a corrupt stored plan for reconciliation and clears it on request", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", unchanged);
    harness.store.failNextWrites(new Error("the connection was reset"));
    await harness.queue.start();
    const first = await harness.queue.submit({
      sourceKey: "first",
      content: "The first observation.",
    });
    await settle(
      async () =>
        (await harness.queue.receipt(first.id))?.status === "retrying",
      "the plan to be committed",
    );
    // Damage the durable plan, as a partial journal write or a restoring backup could.
    const journal = new DatabaseSync(harness.queue.journalPath);
    journal
      .prepare("UPDATE receipts SET plan = ? WHERE id = ?")
      .run('{"version":1', first.id);
    journal.close();

    await settle(
      async () => (await harness.queue.receipt(first.id))?.status === "blocked",
      "the corrupt plan to block the queue",
    );
    const blocked = await receiptOf(harness.queue, first.id);
    expect(blocked.nextRetryAt).toBeUndefined();
    expect(blocked.lastError).toContain("unreadable");

    const second = await harness.queue.submit({
      sourceKey: "second",
      content: "The second observation.",
    });
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await receiptOf(harness.queue, second.id)).status).toBe("queued");
    expect(harness.store.writes).toEqual([]);

    // The operator confirms the plan was not applied, so preparation restarts with the same id.
    const reconciled = await harness.queue.reconcile(first.id, {
      outcome: "not-written",
    });
    expect(reconciled.status).toBe("queued");
    await settle(
      async () => (await harness.queue.receipt(second.id))?.status === "stored",
      "reconciled work and later observations to drain",
    );
    const stored = await receiptOf(harness.queue, first.id);
    expect(stored.status).toBe("stored");
    expect(stored.noteId).toBe(harness.preparer.prepares[0]?.noteId);
  });
});

describe("legacy receipt migration", () => {
  it.each(["prepare", "apply"] as const)(
    "refuses imports through either handle during %s without accepting uncertainty",
    async (stage) => {
      const harness = await createHarness();
      const other = await createHarness({ directory: harness.directory });
      const gate = deferred<void>();
      const entered = deferred<void>();
      const operation = harness.preparer[stage].bind(harness.preparer);
      // Hold a public provider boundary, leaving the real queue and both journals active.
      if (stage === "prepare") {
        vi.spyOn(harness.preparer, "prepare").mockImplementation(
          async (input) => {
            entered.resolve();
            await gate.promise;
            return (operation as MemoryPreparer["prepare"])(input);
          },
        );
      } else {
        vi.spyOn(harness.preparer, "apply").mockImplementation(async (plan) => {
          entered.resolve();
          await gate.promise;
          return (operation as MemoryPreparer["apply"])(plan);
        });
      }
      harness.model.queue("construct", CONSTRUCTED);
      const accepted = await harness.queue.submit({
        sourceKey: "active",
        content: "Active.",
      });
      await harness.queue.start();
      await entered.promise;
      try {
        for (const queue of [harness.queue, other.queue]) {
          await expect(
            queue.importLegacyReceipts([
              { status: "pending", sourceKey: "pending", content: "Pending." },
              {
                status: "uncertain",
                sourceKey: "uncertain",
                content: "Uncertain.",
                receiptId: LEGACY_RECEIPT_ID,
              },
            ]),
          ).rejects.toBeInstanceOf(QueueWorkerLockedError);
          expect(await queue.receipt(LEGACY_RECEIPT_ID)).toBeUndefined();
          expect((await queue.status()).accepted).toBe(1);
        }
      } finally {
        gate.resolve();
      }
      await settle(
        async () =>
          (await harness.queue.receipt(accepted.id))?.status === "stored",
        "the active operation to settle",
      );
      await harness.queue.stop();
      expect(
        await other.queue.importLegacyReceipts([
          {
            status: "uncertain",
            sourceKey: "uncertain",
            content: "Uncertain.",
            receiptId: LEGACY_RECEIPT_ID,
          },
        ]),
      ).toEqual({ imported: 1, existing: 0, blocked: 1 });
    },
  );

  it.each([
    ["prepared", "different"],
    ["prepared", "same"],
    ["prepared", "unknown"],
    ["preparing", "different"],
    ["preparing", "same"],
    ["preparing", "unknown"],
  ] as const)(
    "blocks legacy uncertainty for a %s receipt with a %s identity",
    async (phase, identity) => {
      const harness = await createHarness();
      harness.model.queue("construct", CONSTRUCTED);
      if (phase === "prepared")
        harness.store.failNextWrites(new Error("Lost acknowledgement."));
      else harness.store.nearestError = new Error("Preparation interrupted.");
      const accepted = await harness.queue.submit({
        sourceKey: "shared",
        content: "Observation.",
      });
      await harness.queue.start();
      await settle(
        async () =>
          (await harness.queue.receipt(accepted.id))?.status === "retrying",
        "the interrupted attempt",
      );
      await harness.queue.stop();
      if (phase === "preparing") {
        // Persist the state left by termination during preparation, before a plan was saved.
        const journal = new DatabaseSync(harness.queue.journalPath);
        journal
          .prepare("UPDATE receipts SET status = 'processing' WHERE id = ?")
          .run(accepted.id);
        journal.close();
      }
      const record: LegacyReceipt = {
        status: "uncertain",
        sourceKey: "shared",
        content: "Observation.",
        ...(identity === "unknown"
          ? {}
          : {
              noteId:
                identity === "same"
                  ? harness.preparer.prepares[0]!.noteId
                  : OTHER_ID,
            }),
      };
      expect(await harness.queue.importLegacyReceipts([record])).toEqual({
        imported: 0,
        existing: 0,
        blocked: 1,
      });
      expect(await harness.queue.importLegacyReceipts([record])).toEqual({
        imported: 0,
        existing: 1,
        blocked: 0,
      });
      expect(await receiptOf(harness.queue, accepted.id)).toMatchObject({
        status: "blocked",
      });
      const preparations = harness.preparer.prepares.length;
      const applications = harness.preparer.applies.length;
      await harness.queue.start();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(harness.preparer.prepares).toHaveLength(preparations);
      expect(harness.preparer.applies).toHaveLength(applications);
      await harness.queue.stop();
      await harness.queue.reconcile(accepted.id, { outcome: "not-written" });
      expect(await harness.queue.importLegacyReceipts([record])).toEqual({
        imported: 0,
        existing: 1,
        blocked: 0,
      });
    },
  );

  it("imports pending observations idempotently and drains them with their timestamps", async () => {
    const harness = await createHarness();
    const records: LegacyReceipt[] = [
      {
        status: "pending",
        sourceKey: "legacy-1",
        content: "Legacy one.",
        timestamp: NOTE_TIMESTAMP,
        receiptId: LEGACY_RECEIPT_ID,
      },
      { status: "pending", sourceKey: "legacy-2", content: "Legacy two." },
    ];

    expect(await harness.queue.importLegacyReceipts(records)).toEqual({
      imported: 2,
      existing: 0,
      blocked: 0,
    });
    // A repeated import neither duplicates the work nor changes the accepted identity.
    expect(await harness.queue.importLegacyReceipts(records)).toEqual({
      imported: 0,
      existing: 2,
      blocked: 0,
    });
    expect((await harness.queue.status()).accepted).toBe(2);

    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", unchanged);
    await harness.queue.start();
    await settle(
      async () => (await harness.queue.status()).counts.stored === 2,
      "the imported observations to drain",
    );

    const first = await receiptOf(harness.queue, LEGACY_RECEIPT_ID);
    expect(first.sourceKey).toBe("legacy-1");
    expect(first.status).toBe("stored");
    expect(harness.store.stored(first.noteId!)?.timestamp).toBe(NOTE_TIMESTAMP);
    await harness.queue.stop();
    const second = await harness.queue.importLegacyReceipts(records);
    expect(second).toEqual({ imported: 0, existing: 2, blocked: 0 });
    expect(await receiptOf(harness.queue, LEGACY_RECEIPT_ID)).toEqual(first);
  });

  it("preserves the completed identity of stored legacy receipts", async () => {
    const harness = await createHarness();

    expect(
      await harness.queue.importLegacyReceipts([
        {
          status: "stored",
          sourceKey: "legacy-stored",
          content: "Already stored.",
          noteId: OTHER_ID,
          receiptId: LEGACY_RECEIPT_ID,
          storedAt: "2026-09-27T16:00:00.000Z",
        },
      ]),
    ).toEqual({ imported: 1, existing: 0, blocked: 0 });

    const receipt = await receiptOf(harness.queue, LEGACY_RECEIPT_ID);
    expect(receipt.status).toBe("stored");
    expect(receipt.noteId).toBe(OTHER_ID);
    await harness.queue.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.writes).toEqual([]);
    expect((await harness.queue.status()).counts.stored).toBe(1);
  });

  it("blocks an uncertain legacy receipt until an operator reconciles it", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    expect(
      await harness.queue.importLegacyReceipts([
        {
          status: "uncertain",
          sourceKey: "legacy-uncertain",
          content: "Unknown outcome.",
          receiptId: LEGACY_RECEIPT_ID,
          noteId: OTHER_ID,
        },
      ]),
    ).toEqual({ imported: 1, existing: 0, blocked: 1 });
    const blocked = await receiptOf(harness.queue, LEGACY_RECEIPT_ID);
    expect(blocked.status).toBe("blocked");
    expect(blocked.nextRetryAt).toBeUndefined();
    expect(blocked.lastError).toContain("reconciliation");

    const later = await harness.queue.submit({
      sourceKey: "later",
      content: "The later observation.",
    });
    await harness.queue.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await receiptOf(harness.queue, later.id)).status).toBe("queued");
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.writes).toEqual([]);

    const reconciled = await harness.queue.reconcile(LEGACY_RECEIPT_ID, {
      outcome: "stored",
      noteId: OTHER_ID,
    });
    expect(reconciled.status).toBe("stored");
    expect(reconciled.noteId).toBe(OTHER_ID);
    await settle(
      async () => (await harness.queue.receipt(later.id))?.status === "stored",
      "later work to proceed after reconciliation",
    );
  });

  it("refuses a conflicting legacy record without changing the queue", async () => {
    const harness = await createHarness();
    await harness.queue.importLegacyReceipts([
      { status: "pending", sourceKey: "legacy-1", content: "Original." },
    ]);

    await expect(
      harness.queue.importLegacyReceipts([
        { status: "pending", sourceKey: "legacy-1", content: "Changed." },
      ]),
    ).rejects.toBeInstanceOf(QueueConflictError);

    expect((await harness.queue.status()).accepted).toBe(1);
  });

  it("holds a mixed legacy batch until its uncertainty is reconciled", async () => {
    const harness = await createHarness();
    expect(
      await harness.queue.importLegacyReceipts([
        {
          status: "pending",
          sourceKey: "legacy-pending",
          content: "Known unwritten.",
        },
        {
          status: "uncertain",
          sourceKey: "legacy-uncertain",
          content: "Unknown outcome.",
          receiptId: LEGACY_RECEIPT_ID,
        },
      ]),
    ).toEqual({ imported: 2, existing: 0, blocked: 1 });

    harness.model.queue("construct", CONSTRUCTED);
    await harness.queue.start();
    await vi.advanceTimersByTimeAsync(120_000);
    // The earlier, known-unwritten record must not be written while the uncertainty is open.
    expect((await harness.queue.status()).counts).toMatchObject({
      queued: 1,
      blocked: 1,
    });
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.writes).toEqual([]);

    const reconciled = await harness.queue.reconcile(LEGACY_RECEIPT_ID, {
      outcome: "stored",
      noteId: OTHER_ID,
    });
    expect(reconciled.status).toBe("stored");
    await settle(
      async () => (await harness.queue.status()).counts.stored === 2,
      "the legacy batch to drain after reconciliation",
    );
  });

  it("holds accepted work while a later legacy uncertainty is unresolved", async () => {
    const harness = await createHarness();
    const accepted = await harness.queue.submit({
      sourceKey: "accepted",
      content: "The accepted observation.",
    });
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", unchanged);
    expect(
      await harness.queue.importLegacyReceipts([
        {
          status: "uncertain",
          sourceKey: "legacy-uncertain",
          content: "Unknown outcome.",
          receiptId: LEGACY_RECEIPT_ID,
        },
      ]),
    ).toEqual({ imported: 1, existing: 0, blocked: 1 });

    await harness.queue.start();
    await vi.advanceTimersByTimeAsync(120_000);
    // The uncertainty is later in the drain order, yet no collection write may proceed.
    expect((await receiptOf(harness.queue, accepted.id)).status).toBe("queued");
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.writes).toEqual([]);
    expect((await harness.queue.status()).lastError).toContain(
      "reconciliation",
    );

    const reconciled = await harness.queue.reconcile(LEGACY_RECEIPT_ID, {
      outcome: "not-written",
    });
    expect(reconciled.status).toBe("queued");
    await settle(
      async () => (await harness.queue.status()).counts.stored === 2,
      "the accepted and reconciled work to drain",
    );
  });

  it("blocks an accepted receipt when an uncertain legacy record names the same observation", async () => {
    const harness = await createHarness();
    const accepted = await harness.queue.submit({
      sourceKey: "shared-key",
      content: "The observation.",
      provenance: { host: "cli" },
    });
    const record: LegacyReceipt = {
      status: "uncertain",
      sourceKey: "shared-key",
      content: "The observation.",
      provenance: { host: "cli" },
      noteId: OTHER_ID,
    };

    // Equal observation text is not equal evidence: the legacy system may have written it.
    expect(await harness.queue.importLegacyReceipts([record])).toEqual({
      imported: 0,
      existing: 0,
      blocked: 1,
    });
    const blocked = await receiptOf(harness.queue, accepted.id);
    expect(blocked.status).toBe("blocked");
    expect(blocked.nextRetryAt).toBeUndefined();
    expect(blocked.lastError).toContain("reconciliation");

    harness.model.queue("construct", CONSTRUCTED);
    await harness.queue.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.model.requests).toEqual([]);
    expect(harness.store.writes).toEqual([]);

    // The completed identity resolves it, and the repeated import stays idempotent.
    const reconciled = await harness.queue.reconcile(accepted.id, {
      outcome: "stored",
      noteId: OTHER_ID,
    });
    expect(reconciled.status).toBe("stored");
    expect(reconciled.noteId).toBe(OTHER_ID);
    await harness.queue.stop();
    expect(await harness.queue.importLegacyReceipts([record])).toEqual({
      imported: 0,
      existing: 1,
      blocked: 0,
    });
  });

  it("keeps an operator decision when the same uncertainty is imported again", async () => {
    const harness = await createHarness();
    const accepted = await harness.queue.submit({
      sourceKey: "shared-key",
      content: "The observation.",
    });
    const record: LegacyReceipt = {
      status: "uncertain",
      sourceKey: "shared-key",
      content: "The observation.",
    };
    expect(await harness.queue.importLegacyReceipts([record])).toEqual({
      imported: 0,
      existing: 0,
      blocked: 1,
    });

    const reconciled = await harness.queue.reconcile(accepted.id, {
      outcome: "not-written",
    });
    expect(reconciled.status).toBe("queued");
    // The operator already decided this receipt's outcome; the import neither blocks nor conflicts.
    expect(await harness.queue.importLegacyReceipts([record])).toEqual({
      imported: 0,
      existing: 1,
      blocked: 0,
    });

    harness.model.queue("construct", CONSTRUCTED);
    await harness.queue.start();
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the reconciled receipt to drain",
    );
  });

  it("refuses an uncertain legacy record that names another completed identity", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    const accepted = await harness.queue.submit({
      sourceKey: "shared-key",
      content: "The observation.",
    });
    await harness.queue.start();
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the observation to be stored",
    );

    await harness.queue.stop();
    await expect(
      harness.queue.importLegacyReceipts([
        {
          status: "uncertain",
          sourceKey: "shared-key",
          content: "The observation.",
          noteId: OTHER_ID,
        },
      ]),
    ).rejects.toBeInstanceOf(QueueConflictError);
  });
});

describe("receipts and status", () => {
  it("shares a later global block's diagnostic and clears it after reconciliation on another handle", async () => {
    const harness = await createHarness();
    await harness.queue.submit({
      sourceKey: "older",
      content: "Older queued work.",
    });
    await harness.queue.importLegacyReceipts([
      {
        status: "uncertain",
        sourceKey: "later",
        content: "Unknown outcome.",
        receiptId: LEGACY_RECEIPT_ID,
      },
    ]);
    const other = await createHarness({ directory: harness.directory });
    await harness.queue.start();
    await vi.advanceTimersByTimeAsync(100);
    await harness.queue.stop();
    for (const queue of [harness.queue, other.queue]) {
      expect((await queue.status()).lastError).toContain("reconciliation");
      expect((await queue.status()).counts).toMatchObject({
        queued: 1,
        blocked: 1,
      });
    }
    await other.queue.close();
    const reopened = await createHarness({ directory: harness.directory });
    expect((await reopened.queue.status()).lastError).toContain(
      "reconciliation",
    );
    await reopened.queue.reconcile(LEGACY_RECEIPT_ID, {
      outcome: "not-written",
    });
    // The stopped worker must not retain its old diagnostic after another handle resolves it.
    expect((await harness.queue.status()).lastError).toBeUndefined();
    expect((await reopened.queue.status()).lastError).toBeUndefined();
  });

  it("reports outcomes, backlog, oldest pending age and worker availability", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    const accepted = await harness.queue.submit({
      sourceKey: "source-key",
      content: "The observation.",
    });

    const waiting = await harness.queue.status();
    expect(waiting).toMatchObject({
      worker: "stopped",
      accepted: 1,
      backlog: 1,
      counts: { queued: 1 },
      oldestPendingAt: accepted.acceptedAt,
      oldestPendingAgeMs: 0,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect((await harness.queue.status()).oldestPendingAgeMs).toBe(5_000);

    await harness.queue.start();
    await settle(
      async () =>
        (await harness.queue.receipt(accepted.id))?.status === "stored",
      "the observation to be stored",
    );
    const drained = await harness.queue.status();
    expect(drained).toMatchObject({
      worker: "running",
      accepted: 1,
      backlog: 0,
      counts: { stored: 1 },
    });
    expect(drained.oldestPendingAt).toBeUndefined();
    expect(drained.oldestPendingAgeMs).toBeUndefined();
    const stored = await receiptOf(harness.queue, accepted.id);
    expect(stored.noteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.attemptCount).toBe(1);
    expect(stored.lastError).toBeUndefined();
    await harness.queue.stop();
    expect((await harness.queue.status()).worker).toBe("stopped");
  });

  it("returns no receipt for an unknown or malformed identity", async () => {
    const harness = await createHarness();

    await expect(
      harness.queue.receipt("1e0c0b1e-5b3c-4a2f-9f1b-0c2d3e4f5a6b"),
    ).resolves.toBeUndefined();
    await expect(harness.queue.receipt("not-a-uuid")).resolves.toBeUndefined();
    await expect(
      harness.queue.reconcile("1e0c0b1e-5b3c-4a2f-9f1b-0c2d3e4f5a6b", {
        outcome: "not-written",
      }),
    ).rejects.toBeInstanceOf(QueueRequestError);
  });

  it("reports shared worker availability and durable diagnostics through another handle", async () => {
    const first = await createHarness();
    await first.queue.start();
    const second = await createHarness({
      directory: first.directory,
      store: first.store,
      embedder: first.embedder,
      model: first.model,
    });

    // Availability belongs to the queue, not to the handle that happens to run the worker.
    expect((await second.queue.status()).worker).toBe("running");
    await first.queue.stop();

    expect(
      await second.queue.importLegacyReceipts([
        {
          status: "uncertain",
          sourceKey: "legacy-uncertain",
          content: "Unknown outcome.",
          receiptId: LEGACY_RECEIPT_ID,
        },
      ]),
    ).toEqual({ imported: 1, existing: 0, blocked: 1 });
    await first.queue.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const reported = await second.queue.status();
    expect(reported.lastError).toContain("reconciliation");
    expect(reported.counts.blocked).toBe(1);

    await first.queue.close();
    expect((await second.queue.status()).worker).toBe("stopped");
    await second.queue.close();

    // A reopened queue still reports why its durable backlog is blocked.
    const reopened = await createHarness({
      directory: first.directory,
      store: first.store,
      embedder: first.embedder,
      model: first.model,
    });
    const durable = await reopened.queue.status();
    expect(durable.worker).toBe("stopped");
    expect(durable.lastError).toContain("reconciliation");
  });
});

describe("receipt traversal", () => {
  it("pages every outcome in acceptance order without duplicates or payloads", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", () => ({ context: "Only a context." }));
    await harness.queue.start();
    const stored = await harness.queue.submit({
      sourceKey: "stored",
      content: "The stored observation.",
    });
    const failed = await harness.queue.submit({
      sourceKey: "failed",
      content: "The invalid observation.",
    });
    await settle(
      async () => (await harness.queue.receipt(failed.id))?.status === "failed",
      "the failure to be retained",
    );
    await harness.queue.stop();
    const queued = await harness.queue.submit({
      sourceKey: "queued",
      content: "The queued observation.",
    });

    // A page that exactly reaches the end omits the cursor, so completion needs no extra call.
    const complete = await harness.queue.pageReceipts(3);
    expect(complete.receipts).toHaveLength(3);
    expect(complete.cursor).toBeUndefined();

    const first = await harness.queue.pageReceipts(2);
    expect(first.receipts.map((receipt) => receipt.id)).toEqual([
      stored.id,
      failed.id,
    ]);
    expect(first.receipts.map((receipt) => receipt.status)).toEqual([
      "stored",
      "failed",
    ]);
    expect(first.cursor).toBeDefined();

    const second = await harness.queue.pageReceipts(2, first.cursor);
    expect(second.receipts.map((receipt) => receipt.id)).toEqual([queued.id]);
    expect(second.receipts[0]?.status).toBe("queued");
    expect(second.cursor).toBeUndefined();

    // A page exposes receipt outcomes only, never retained source material or plans.
    const keys = Object.keys(second.receipts[0] ?? {});
    expect(keys).not.toContain("content");
    expect(keys).not.toContain("provenance");
    expect(keys).not.toContain("plan");
  });

  it("refuses invalid limits and cursors", async () => {
    const harness = await createHarness();
    await harness.queue.submit({
      sourceKey: "one",
      content: "An observation.",
    });
    await expect(harness.queue.pageReceipts(0)).rejects.toBeInstanceOf(
      QueueRequestError,
    );
    await expect(harness.queue.pageReceipts(-1)).rejects.toBeInstanceOf(
      QueueRequestError,
    );
    await expect(harness.queue.pageReceipts(1.5)).rejects.toBeInstanceOf(
      QueueRequestError,
    );
    await expect(harness.queue.pageReceipts(1, "")).rejects.toBeInstanceOf(
      QueueRequestError,
    );
    await expect(harness.queue.pageReceipts(1, "1.5")).rejects.toBeInstanceOf(
      QueueRequestError,
    );
    await expect(
      harness.queue.pageReceipts(1, "not-a-cursor"),
    ).rejects.toBeInstanceOf(QueueRequestError);
    await expect(harness.queue.pageReceipts(1, "-1")).rejects.toBeInstanceOf(
      QueueRequestError,
    );
  });

  it("continues traversal when receipts change status and new work is accepted", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("construct", CONSTRUCTED);
    const first = await harness.queue.submit({
      sourceKey: "first",
      content: "The first observation.",
    });
    const second = await harness.queue.submit({
      sourceKey: "second",
      content: "The second observation.",
    });
    const page = await harness.queue.pageReceipts(1);
    expect(page.receipts[0]?.id).toBe(first.id);
    expect(page.receipts[0]?.status).toBe("queued");

    await harness.queue.start();
    await settle(
      async () => (await harness.queue.receipt(first.id))?.status === "stored",
      "the first write",
    );
    const third = await harness.queue.submit({
      sourceKey: "third",
      content: "The third observation.",
    });
    const rest = await harness.queue.pageReceipts(10, page.cursor);
    expect(rest.receipts.map((receipt) => receipt.id)).toEqual([
      second.id,
      third.id,
    ]);
    expect(rest.receipts.map((receipt) => receipt.status)).toEqual([
      "queued",
      "queued",
    ]);
    expect(rest.receipts[0]?.id).not.toBe(first.id);
    expect(rest.cursor).toBeUndefined();
  });
});

describe("failed receipt recovery", () => {
  it("recovers a known-unwritten failure on its original sequence and identity", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", () => ({ context: "Only a context." }));
    await harness.queue.start();
    const failed = await harness.queue.submit({
      sourceKey: "retained",
      content: "The retained observation.",
      timestamp: NOTE_TIMESTAMP,
      provenance: { origin: "host" },
    });
    await settle(
      async () => (await harness.queue.receipt(failed.id))?.status === "failed",
      "the failure to be retained",
    );
    const before = await receiptOf(harness.queue, failed.id);
    expect(before.attemptCount).toBe(1);

    // An identical producer resubmission returns the retained receipt without restarting it.
    await expect(
      harness.queue.submit({
        sourceKey: "retained",
        content: "The retained observation.",
        timestamp: NOTE_TIMESTAMP,
        provenance: { origin: "host" },
      }),
    ).resolves.toMatchObject({
      id: failed.id,
      status: "failed",
      created: false,
    });

    harness.model.queue("construct", CONSTRUCTED);
    const recovery = await harness.queue.recoverFailed(failed.id, {
      expectedAttemptCount: before.attemptCount,
    });
    expect(recovery.recovered).toBe(true);
    expect(recovery.receipt).toMatchObject({
      id: failed.id,
      sourceKey: "retained",
      status: "queued",
      acceptedAt: before.acceptedAt,
      attemptCount: 1,
    });
    expect(recovery.receipt.noteId).toBeUndefined();
    expect(recovery.receipt.lastError).toBeUndefined();
    expect(recovery.receipt.nextRetryAt).toBeUndefined();
    expect(recovery.receipt.recoveries).toEqual([
      {
        requestedAt: expect.any(String),
        attemptCount: 1,
        lastError: before.lastError,
      },
    ]);

    // The recovered observation keeps its accepted identity and source values, and the drained
    // receipt keeps the recovery evidence after storage.
    await settle(
      async () => (await harness.queue.receipt(failed.id))?.status === "stored",
      "the recovered observation to store",
    );
    const stored = await receiptOf(harness.queue, failed.id);
    expect(harness.preparer.prepares).toHaveLength(2);
    expect(harness.preparer.prepares[1]).toEqual(harness.preparer.prepares[0]);
    expect(stored.noteId).toBe(harness.preparer.prepares[0]?.noteId);
    expect(harness.store.stored(stored.noteId!)?.content).toBe(
      "The retained observation.",
    );
    expect(harness.store.stored(stored.noteId!)?.timestamp).toBe(
      NOTE_TIMESTAMP,
    );
    expect(harness.store.stored(stored.noteId!)?.metadata).toEqual({
      origin: "host",
    });
    expect(stored.recoveries).toHaveLength(1);
    expect(stored.attemptCount).toBe(2);
  });

  it("reports a stale count as an ineffective repeat and never resumes a later failure", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", () => ({ context: "Only a context." }));
    harness.model.queue("construct", () => ({
      context: "Still only a context.",
    }));
    await harness.queue.start();
    const failed = await harness.queue.submit({
      sourceKey: "repeat",
      content: "The repeating observation.",
    });
    await settle(
      async () => (await harness.queue.receipt(failed.id))?.status === "failed",
      "the first failure",
    );

    const first = await harness.queue.recoverFailed(failed.id, {
      expectedAttemptCount: 1,
    });
    expect(first.recovered).toBe(true);

    // A repeat with the same inspected count appends no evidence and performs no write.
    const repeat = await harness.queue.recoverFailed(failed.id, {
      expectedAttemptCount: 1,
    });
    expect(repeat.recovered).toBe(false);
    expect(repeat.receipt.status).toBe("queued");
    expect(repeat.receipt.recoveries).toHaveLength(1);

    // The worker claims it and fails again, increasing the cumulative attempt count.
    await settle(async () => {
      const receipt = await harness.queue.receipt(failed.id);
      return receipt?.status === "failed" && receipt.attemptCount === 2;
    }, "the later failure");
    const later = await receiptOf(harness.queue, failed.id);
    expect(later.recoveries).toHaveLength(1);

    // The earlier inspected count no longer matches: the request reports the current receipt.
    const stale = await harness.queue.recoverFailed(failed.id, {
      expectedAttemptCount: 1,
    });
    expect(stale.recovered).toBe(false);
    expect(stale.receipt.status).toBe("failed");
    expect(stale.receipt.attemptCount).toBe(2);

    // A future count is refused; the inspected new count recovers the later failure.
    await expect(
      harness.queue.recoverFailed(failed.id, { expectedAttemptCount: 3 }),
    ).rejects.toBeInstanceOf(QueueStateConflictError);
    harness.model.queue("construct", CONSTRUCTED);
    const second = await harness.queue.recoverFailed(failed.id, {
      expectedAttemptCount: 2,
    });
    expect(second.recovered).toBe(true);
    expect(second.receipt.recoveries).toEqual([
      expect.objectContaining({ attemptCount: 1 }),
      expect.objectContaining({ attemptCount: 2 }),
    ]);
    await settle(
      async () => (await harness.queue.receipt(failed.id))?.status === "stored",
      "the second recovery to store",
    );
  });

  it("refuses recovery while a later write is processing or its plan is unresolved", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", () => ({ context: "Only a context." }));
    await harness.queue.start();
    const failed = await harness.queue.submit({
      sourceKey: "failed",
      content: "The failed observation.",
    });
    await settle(
      async () => (await harness.queue.receipt(failed.id))?.status === "failed",
      "the failure to be retained",
    );

    // The later receipt prepares and commits its plan; its application has not settled.
    harness.model.queue("construct", CONSTRUCTED);
    const gate = harness.store.holdWrites();
    const later = await harness.queue.submit({
      sourceKey: "later",
      content: "The later observation.",
    });
    // Await one journal round trip in the condition, so the worker thread's plan commit and the
    // gated application can progress between timer advances.
    await settle(async () => {
      await harness.queue.receipt(later.id);
      return harness.store.calls.includes("put");
    }, "the later application to start");
    const refused = await rejection(
      harness.queue.recoverFailed(failed.id, { expectedAttemptCount: 1 }),
    );
    expect(refused).toBeInstanceOf(QueueStateConflictError);
    expect((refused as QueueStateConflictError).reason).toContain("processing");
    await expect(harness.queue.receipt(failed.id)).resolves.toMatchObject({
      status: "failed",
    });

    gate.resolve();
    await settle(
      async () => (await harness.queue.receipt(later.id))?.status === "stored",
      "the later write",
    );

    // Once the later write settled, the earlier failure can be recovered without undoing it.
    harness.model.queue("construct", CONSTRUCTED);
    harness.model.queue("evolve", unchanged);
    const recovered = await harness.queue.recoverFailed(failed.id, {
      expectedAttemptCount: 1,
    });
    expect(recovered.recovered).toBe(true);
    await settle(
      async () => (await harness.queue.receipt(failed.id))?.status === "stored",
      "the recovered head",
    );
    expect(
      harness.store.writes.map((batch) => batch.at(-1)!.note.content),
    ).toEqual(["The later observation.", "The failed observation."]);
  });

  it("refuses an unknown receipt, a blocked receipt and an unresolved legacy uncertainty", async () => {
    const harness = await createHarness();
    await expect(
      harness.queue.recoverFailed("1e0c0b1e-5b3c-4a2f-9f1b-0c2d3e4f5a6b", {
        expectedAttemptCount: 1,
      }),
    ).rejects.toBeInstanceOf(QueueReceiptNotFoundError);
    await expect(
      harness.queue.recoverFailed("not-a-uuid", { expectedAttemptCount: 1 }),
    ).rejects.toBeInstanceOf(QueueRequestError);
    await expect(
      harness.queue.recoverFailed(LEGACY_RECEIPT_ID, {
        expectedAttemptCount: -1,
      }),
    ).rejects.toBeInstanceOf(QueueRequestError);
    await expect(
      harness.queue.recoverFailed(LEGACY_RECEIPT_ID, {
        expectedAttemptCount: 1.5,
      }),
    ).rejects.toBeInstanceOf(QueueRequestError);

    harness.model.queue("construct", () => ({ context: "Only a context." }));
    harness.model.queue("construct", () => ({
      context: "Still only a context.",
    }));
    await harness.queue.start();
    const failed = await harness.queue.submit({
      sourceKey: "failed",
      content: "The failed observation.",
    });
    const second = await harness.queue.submit({
      sourceKey: "second",
      content: "The second observation.",
    });
    await settle(
      async () =>
        (await harness.queue.receipt(failed.id))?.status === "failed" &&
        (await harness.queue.receipt(second.id))?.status === "failed",
      "both failures to be retained",
    );
    await harness.queue.stop();

    // A legacy uncertainty that names this receipt turns it into a reconciliation block.
    await harness.queue.importLegacyReceipts([
      {
        status: "uncertain",
        sourceKey: "failed",
        content: "The failed observation.",
      },
    ]);
    const blocked = await rejection(
      harness.queue.recoverFailed(failed.id, { expectedAttemptCount: 1 }),
    );
    expect(blocked).toBeInstanceOf(QueueStateConflictError);
    expect((blocked as QueueStateConflictError).reason).toContain("blocked");

    // A separate unresolved uncertainty also refuses recovery of a failed receipt.
    await harness.queue.importLegacyReceipts([
      {
        status: "uncertain",
        sourceKey: "elsewhere",
        content: "An unrelated unknown outcome.",
      },
    ]);
    const held = await rejection(
      harness.queue.recoverFailed(second.id, { expectedAttemptCount: 1 }),
    );
    expect(held).toBeInstanceOf(QueueStateConflictError);
    expect((held as QueueStateConflictError).reason).toContain("legacy");
  });

  it("refuses recovery while a later committed plan is unresolved", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", () => ({ context: "Only a context." }));
    harness.model.queue("construct", CONSTRUCTED);
    await harness.queue.start();
    const failed = await harness.queue.submit({
      sourceKey: "failed",
      content: "The failed observation.",
    });
    const later = await harness.queue.submit({
      sourceKey: "later",
      content: "The later observation.",
    });
    harness.store.putError = new Error("the connection was reset");
    await settle(
      async () =>
        (await harness.queue.receipt(later.id))?.status === "retrying",
      "the later plan to be committed",
    );
    expect(await receiptOf(harness.queue, failed.id)).toMatchObject({
      status: "failed",
    });
    await harness.queue.stop();

    const refused = await rejection(
      harness.queue.recoverFailed(failed.id, { expectedAttemptCount: 1 }),
    );
    expect(refused).toBeInstanceOf(QueueStateConflictError);
    expect((refused as QueueStateConflictError).reason).toContain("plan");
    await expect(harness.queue.receipt(failed.id)).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("serializes concurrent recovery requests into one effective transition", async () => {
    const harness = await createHarness();
    harness.model.queue("construct", () => ({ context: "Only a context." }));
    await harness.queue.start();
    const failed = await harness.queue.submit({
      sourceKey: "raced",
      content: "The raced observation.",
    });
    await settle(
      async () => (await harness.queue.receipt(failed.id))?.status === "failed",
      "the failure to be retained",
    );
    await harness.queue.stop();
    const other = await createHarness({
      directory: harness.directory,
      store: harness.store,
      embedder: harness.embedder,
      model: harness.model,
    });

    const outcomes = await Promise.all([
      harness.queue.recoverFailed(failed.id, { expectedAttemptCount: 1 }),
      other.queue.recoverFailed(failed.id, { expectedAttemptCount: 1 }),
    ]);
    expect(outcomes.filter((outcome) => outcome.recovered)).toHaveLength(1);
    const ineffective = outcomes.find((outcome) => !outcome.recovered);
    expect(ineffective?.receipt.status).toBe("queued");
    expect(ineffective?.receipt.recoveries).toHaveLength(1);
    expect((await harness.queue.receipt(failed.id))?.recoveries).toHaveLength(
      1,
    );
  });
});

describe("context correction", () => {
  it("applies one reviewed correction, clears its slot and creates no receipt", async () => {
    const harness = await createHarness();
    const note = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    const correction = new RecordingCorrectionPreparer(harness.memory);
    const result = await harness.queue.correctContext(
      correctionInput(note, "The corrected earlier context."),
      correction,
    );

    expect(result.changed).toBe(true);
    expect(result.note).toMatchObject({
      id: note.id,
      content: note.content,
      timestamp: note.timestamp,
      context: "The corrected earlier context.",
      keywords: note.keywords,
      tags: note.tags,
      links: note.links,
      metadata: note.metadata,
    });
    // The reviewed one-record plan was committed before the write and applied exactly once.
    const plan = correction.preparations[0]?.plan;
    expect(plan?.records).toHaveLength(1);
    expect(harness.preparer.applies).toEqual([plan]);
    expect(harness.store.writes).toHaveLength(1);
    expect(harness.store.writes[0]?.map((record) => record.note.id)).toEqual([
      note.id,
    ]);
    expect(harness.store.stored(note.id)).toEqual(result.note);
    expect(harness.store.storedVector(note.id)).toEqual(
      plan?.records[0]?.vector,
    );

    // Maintenance creates no observation receipt, and acknowledgment cleared the slot.
    const status = await harness.queue.status();
    expect(status.accepted).toBe(0);
    expect(status.contextCorrection).toBeUndefined();
    expect((await harness.queue.pageReceipts()).receipts).toEqual([]);

    // Repeating the reviewed attributes is a no-op preparation: no plan and no write.
    const repeat = new RecordingCorrectionPreparer(harness.memory);
    await expect(
      harness.queue.correctContext(
        correctionInput(
          harness.store.stored(note.id)!,
          "The corrected earlier context.",
        ),
        repeat,
      ),
    ).resolves.toEqual({ note: result.note, changed: false });
    expect(repeat.preparations[0]?.plan).toBeUndefined();
    expect(harness.store.writes).toHaveLength(1);
  });

  it("refuses a malformed or failed preparation without writing or creating a slot", async () => {
    const harness = await createHarness();
    const note = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    const prepared = await harness.memory.prepareContextCorrection(
      correctionInput(note, "A reviewed revision."),
    );
    const plan = prepared.plan!;
    const anotherNote = structuredClone(plan);
    anotherNote.noteId = OTHER_ID;
    const emptyPlan = structuredClone(plan);
    emptyPlan.records = [];
    const changedSource = structuredClone(plan);
    changedSource.records[0]!.note.content = "Changed source content.";
    const zeroVector = structuredClone(plan);
    zeroVector.records[0]!.vector = [];
    const shortVector = structuredClone(plan);
    shortVector.records[0]!.vector = [1];
    const longVector = structuredClone(plan);
    longVector.records[0]!.vector = [1, 0, 0, 0, 0];
    for (const invalid of [
      anotherNote,
      emptyPlan,
      changedSource,
      zeroVector,
      shortVector,
      longVector,
    ]) {
      const preparer: ContextCorrectionPreparer = {
        prepareContextCorrection: async () => ({
          note: prepared.note,
          plan: invalid,
        }),
      };
      await expect(
        harness.queue.correctContext(
          correctionInput(note, "A reviewed revision."),
          preparer,
        ),
      ).rejects.toBeInstanceOf(QueueStateConflictError);
      expect(harness.store.calls).not.toContain("put");
      expect((await harness.queue.status()).contextCorrection).toBeUndefined();
    }
    const failing: ContextCorrectionPreparer = {
      prepareContextCorrection: async () => {
        throw new Error("The correction preparation failed.");
      },
    };
    await expect(
      harness.queue.correctContext(
        correctionInput(note, "A reviewed revision."),
        failing,
      ),
    ).rejects.toThrow("The correction preparation failed.");

    expect(harness.store.calls).not.toContain("put");
    expect((await harness.queue.status()).contextCorrection).toBeUndefined();
  });

  it("schedules no retry for a blocking correction failure and resumes on restart", async () => {
    const harness = await createHarness();
    const note = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    const correction = new RecordingCorrectionPreparer(harness.memory);
    // A rejected credential or storage configuration blocks instead of being retried as an
    // outage, even though ingestion keeps its own documented schedule for this condition.
    harness.store.putError = Object.assign(new Error("unauthorized"), {
      status: 401,
    });
    const diagnostic =
      "The storage or provider rejected the queue's credential or storage configuration, " +
      "which must be corrected before this observation can be processed.";
    const failure = await rejection(
      harness.queue.correctContext(
        correctionInput(note, "The revised context."),
        correction,
      ),
    );
    expect(failure).toBeInstanceOf(QueueStateConflictError);
    expect((failure as QueueStateConflictError).reason).toBe(diagnostic);

    // The recorded attempt keeps its evidence but schedules no automatic retry.
    const journal = new DatabaseSync(harness.queue.journalPath);
    expect(
      journal
        .prepare(
          "SELECT attempt_count, next_retry_at, last_error FROM correction_slot WHERE id = 1",
        )
        .get(),
    ).toEqual({
      attempt_count: 1,
      next_retry_at: null,
      last_error: diagnostic,
    });
    journal.close();

    // A worker start replays the slot once, and no later backoff deadline resumes it.
    await harness.queue.start();
    const attempts = (): number =>
      harness.store.calls.filter((call) => call === "put").length;
    await settle(
      () => attempts() === 2,
      "the blocked replay to be attempted",
      120_000,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts()).toBe(2);

    // Correcting the configuration and restarting is what resumes the exact replay.
    harness.store.putError = undefined;
    await harness.queue.stop();
    await harness.queue.start();
    await settle(
      async () =>
        (await harness.queue.status()).contextCorrection === undefined,
      "the corrected configuration to resume the replay",
      120_000,
    );
    const plan = correction.preparations[0]!.plan!;
    // The blocked failure and the worker-start replay applied the same committed plan, then the
    // corrected configuration applied it once more.
    expect(harness.preparer.applies).toEqual([plan, plan, plan]);
    expect(harness.store.stored(note.id)?.context).toBe("The revised context.");
  });

  it("holds later mutation, retains retry timing and replays before ingestion after a restart", async () => {
    const directory = await temporaryDirectory();
    const harness = await createHarness({ directory });
    harness.model.queue("construct", () => ({ context: "Only a context." }));
    await harness.queue.start();
    const failed = await harness.queue.submit({
      sourceKey: "failed",
      content: "The failed observation.",
    });
    await settle(
      async () => (await harness.queue.receipt(failed.id))?.status === "failed",
      "the failure to be retained",
    );
    await harness.queue.stop();

    const note = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    const correction = new RecordingCorrectionPreparer(harness.memory);
    harness.store.putError = new Error("the connection was reset");
    const diagnostic =
      "The note store rejected the prepared batch, so its outcome is uncertain.";
    const failure = await rejection(
      harness.queue.correctContext(
        correctionInput(note, "The revised context."),
        correction,
      ),
    );
    expect(failure).toBeInstanceOf(QueueStateConflictError);
    expect((failure as QueueStateConflictError).reason).toBe(diagnostic);

    // The pending slot is visible with its safe diagnostic and holds every later mutation.
    const status = await harness.queue.status();
    expect(status.contextCorrection).toEqual({
      noteId: note.id,
      lastError: diagnostic,
    });
    expect(status.lastError).toBe(diagnostic);
    const held = new RecordingCorrectionPreparer(harness.memory);
    await expect(
      harness.queue.correctContext(
        correctionInput(note, "Another revision."),
        held,
      ),
    ).rejects.toBeInstanceOf(QueueStateConflictError);
    await expect(
      harness.queue.importLegacyReceipts([
        {
          status: "pending",
          sourceKey: "later",
          content: "The later observation.",
        },
      ]),
    ).rejects.toBeInstanceOf(QueueStateConflictError);
    await expect(
      harness.queue.recoverFailed(failed.id, { expectedAttemptCount: 1 }),
    ).rejects.toBeInstanceOf(QueueStateConflictError);
    expect(held.preparations).toHaveLength(0);

    // An interrupted application leaves the committed plan, the recorded attempt and its retry
    // timing in the slot, so a crash before clearing cannot lose them.
    const plan = correction.preparations[0]!.plan!;
    const journal = new DatabaseSync(harness.queue.journalPath);
    expect(
      journal
        .prepare(
          "SELECT plan, attempt_count, next_retry_at FROM correction_slot WHERE id = 1",
        )
        .get(),
    ).toMatchObject({
      plan: JSON.stringify(plan),
      attempt_count: 1,
      next_retry_at: expect.any(String),
    });
    journal.close();
    await harness.queue.close();

    // Reopening replays the exact committed plan before draining later work.
    const restarted = await createHarness({
      directory,
      store: harness.store,
      embedder: harness.embedder,
      model: harness.model,
    });
    const waiting = await restarted.queue.submit({
      sourceKey: "waiting",
      content: "The waiting observation.",
    });
    restarted.model.queue("construct", CONSTRUCTED);
    restarted.model.queue("evolve", unchanged);
    restarted.store.putError = undefined;
    expect((await restarted.queue.status()).contextCorrection?.noteId).toBe(
      note.id,
    );
    await restarted.queue.start();

    // The retained backoff is honoured: half the delay is not enough.
    await vi.advanceTimersByTimeAsync(500);
    expect((await restarted.queue.status()).contextCorrection?.noteId).toBe(
      note.id,
    );
    expect(restarted.preparer.applies).toHaveLength(0);

    await settle(
      async () =>
        (await restarted.queue.status()).contextCorrection === undefined,
      "the committed correction to be replayed",
    );
    expect(restarted.preparer.applies).toEqual([plan]);
    await settle(
      async () =>
        (await restarted.queue.receipt(waiting.id))?.status === "stored",
      "later ingestion to drain",
    );
    // No correction was prepared again; only the later observation was.
    expect(restarted.preparer.prepares).toHaveLength(1);
    expect(restarted.store.writes[0]?.map((record) => record.note.id)).toEqual([
      note.id,
    ]);
    expect(restarted.store.stored(note.id)?.context).toBe(
      "The revised context.",
    );
  });

  it("blocks a committed correction whose plan was lost instead of preparing again", async () => {
    const directory = await temporaryDirectory();
    const store = new RecordingStore();
    const embedder = new ControlledEmbedder();
    const model = new ScriptedModel();
    const harness = await createHarness({ directory, store, embedder, model });
    const note = store.seed({ note: candidate(), vector: [1, 0, 0, 0] });
    const waiting = await harness.queue.submit({
      sourceKey: "waiting",
      content: "The waiting observation.",
    });
    await harness.queue.close();

    // A committed slot with missing plan data is crash evidence, never unstarted preparation.
    const journal = new DatabaseSync(
      path.join(directory, "ingestion-queue.sqlite"),
    );
    journal
      .prepare(
        "INSERT INTO correction_slot (id, note_id, plan, attempt_count, next_retry_at, " +
          "last_error, updated_at) VALUES (1, ?, NULL, 0, NULL, NULL, ?)",
      )
      .run(note.id, new Date().toISOString());
    journal.close();

    const restarted = await createHarness({
      directory,
      store,
      embedder,
      model,
    });
    await restarted.queue.start();
    await settle(
      async () =>
        (await restarted.queue.status()).contextCorrection?.lastError !==
        undefined,
      "the corrupt slot diagnostic",
    );
    const status = await restarted.queue.status();
    expect(status.contextCorrection?.noteId).toBe(note.id);
    expect(status.contextCorrection?.lastError).toContain("no stored plan");
    expect(status.lastError).toBe(status.contextCorrection?.lastError);

    // Ingestion stays held until the operator restores a consistent journal/collection pair.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restarted.preparer.prepares).toHaveLength(0);
    expect(restarted.preparer.applies).toHaveLength(0);
    expect(store.writes).toEqual([]);
    expect(await restarted.queue.receipt(waiting.id)).toMatchObject({
      status: "queued",
    });
  });

  it("refuses preparation before reading state while a legacy uncertainty is unresolved", async () => {
    const harness = await createHarness();
    const note = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    await harness.queue.importLegacyReceipts([
      {
        status: "uncertain",
        sourceKey: "elsewhere",
        content: "An unrelated unknown outcome.",
      },
    ]);
    const preparer = new RecordingCorrectionPreparer(harness.memory);
    const failure = await rejection(
      harness.queue.correctContext(
        correctionInput(note, "A reviewed revision."),
        preparer,
      ),
    );
    expect(failure).toBeInstanceOf(QueueStateConflictError);
    expect((failure as QueueStateConflictError).reason).toContain("legacy");
    expect(preparer.preparations).toHaveLength(0);
    expect(harness.store.calls).not.toContain("put");
  });

  it("excludes the worker while a correction is prepared and refuses a correction while it drains", async () => {
    const harness = await createHarness();
    const note = harness.store.seed({
      note: candidate(),
      vector: [1, 0, 0, 0],
    });
    await harness.queue.start();
    const whileRunning = new RecordingCorrectionPreparer(harness.memory);
    await expect(
      harness.queue.correctContext(
        correctionInput(note, "A reviewed revision."),
        whileRunning,
      ),
    ).rejects.toBeInstanceOf(QueueWorkerLockedError);
    expect(whileRunning.preparations).toHaveLength(0);
    await harness.queue.stop();

    // While one correction holds maintenance ownership, neither another correction nor the
    // worker can own the queue.
    const gate = deferred<void>();
    const entered = deferred<void>();
    const blocking: ContextCorrectionPreparer = {
      prepareContextCorrection: async (input) => {
        entered.resolve();
        await gate.promise;
        return await harness.memory.prepareContextCorrection(input);
      },
    };
    const first = harness.queue.correctContext(
      correctionInput(note, "The held revision."),
      blocking,
    );
    await entered.promise;
    await expect(harness.queue.start()).rejects.toBeInstanceOf(
      QueueWorkerLockedError,
    );
    await expect(
      harness.queue.correctContext(
        correctionInput(note, "Another revision."),
        new RecordingCorrectionPreparer(harness.memory),
      ),
    ).rejects.toBeInstanceOf(QueueWorkerLockedError);
    gate.resolve();
    await expect(first).resolves.toMatchObject({ changed: true });
    expect(harness.store.stored(note.id)?.context).toBe("The held revision.");
  });
});

/** One receipt as the previous journal schema stored it, without recovery evidence. */
interface RetainedReceipt {
  readonly sequence: number;
  readonly id: string;
  readonly sourceKey: string;
  readonly noteId: string;
  readonly status: string;
  readonly content: string;
  readonly timestamp: string;
  readonly provenance?: Record<string, unknown>;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly attemptCount: number;
  readonly nextRetryAt?: string;
  readonly lastError?: string;
  readonly storedAt?: string;
  readonly plan?: string;
  readonly planCommitted: boolean;
  readonly requiresReconciliation: boolean;
  readonly reconciled: boolean;
}

/** Write one journal in the previous schema, as the previous build left it. */
const writeRetainedJournal = (
  file: string,
  binding: QueueBinding,
  receipts: readonly RetainedReceipt[],
  version = "2",
): void => {
  const db = new DatabaseSync(file);
  try {
    // The previous queue build ran its journal in WAL mode; the retained fixture keeps that.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE queue_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_key TEXT NOT NULL UNIQUE,
        note_id TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        provenance TEXT,
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        next_retry_at TEXT,
        last_error TEXT,
        stored_at TEXT,
        plan TEXT,
        plan_committed INTEGER NOT NULL DEFAULT 0,
        requires_reconciliation INTEGER NOT NULL DEFAULT 0,
        reconciled INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
    const metadata = db.prepare(
      "INSERT INTO queue_metadata (key, value) VALUES (?, ?)",
    );
    metadata.run("journalVersion", version);
    metadata.run("representation", representationVersion);
    metadata.run("binding", JSON.stringify(binding));
    const insert = db.prepare(
      "INSERT INTO receipts (sequence, id, source_key, note_id, status, content, timestamp, " +
        "provenance, accepted_at, updated_at, attempt_count, next_retry_at, last_error, " +
        "stored_at, plan, plan_committed, requires_reconciliation, reconciled) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const receipt of receipts) {
      insert.run(
        receipt.sequence,
        receipt.id,
        receipt.sourceKey,
        receipt.noteId,
        receipt.status,
        receipt.content,
        receipt.timestamp,
        receipt.provenance === undefined
          ? null
          : JSON.stringify(receipt.provenance),
        receipt.acceptedAt,
        receipt.updatedAt,
        receipt.attemptCount,
        receipt.nextRetryAt ?? null,
        receipt.lastError ?? null,
        receipt.storedAt ?? null,
        receipt.plan ?? null,
        receipt.planCommitted ? 1 : 0,
        receipt.requiresReconciliation ? 1 : 0,
        receipt.reconciled ? 1 : 0,
      );
    }
  } finally {
    db.close();
  }
};

const retainedBinding = (embedder: ControlledEmbedder): QueueBinding => ({
  endpoint: "http://127.0.0.1:6333",
  collection: "memories",
  embeddingSpace: { ...embedder.space },
});

const retainedReceipts = (): RetainedReceipt[] => [
  {
    sequence: 1,
    id: "0f0e0d0c-0b0a-4000-8000-000000000001",
    sourceKey: "stored",
    noteId: CANDIDATE_ID,
    status: "stored",
    content: "The stored observation.",
    timestamp: NOTE_TIMESTAMP,
    provenance: { origin: "host" },
    acceptedAt: "2026-09-27T15:44:27.001+02:00",
    updatedAt: "2026-09-27T15:44:28.001+02:00",
    attemptCount: 2,
    storedAt: "2026-09-27T15:44:28.001+02:00",
    planCommitted: true,
    requiresReconciliation: false,
    reconciled: true,
  },
  {
    sequence: 2,
    id: "0f0e0d0c-0b0a-4000-8000-000000000002",
    sourceKey: "retrying",
    noteId: OTHER_ID,
    status: "retrying",
    content: "The retrying observation.",
    timestamp: NOTE_TIMESTAMP,
    acceptedAt: "2026-09-27T15:45:27.001+02:00",
    updatedAt: "2026-09-27T15:45:28.001+02:00",
    attemptCount: 3,
    nextRetryAt: "2026-10-06T10:00:00.000Z",
    lastError:
      "A temporary model provider failure interrupted this observation.",
    planCommitted: false,
    requiresReconciliation: false,
    reconciled: false,
  },
  {
    sequence: 3,
    id: "0f0e0d0c-0b0a-4000-8000-000000000003",
    sourceKey: "failed",
    noteId: "0f0e0d0c-0b0a-4000-8000-000000000103",
    status: "failed",
    content: "The failed observation.",
    timestamp: NOTE_TIMESTAMP,
    acceptedAt: "2026-09-27T15:46:27.001+02:00",
    updatedAt: "2026-09-27T15:46:28.001+02:00",
    attemptCount: 5,
    lastError:
      "The model returned output the queue cannot use, so this observation failed permanently.",
    planCommitted: false,
    requiresReconciliation: false,
    reconciled: false,
  },
];

describe("journal upgrade", () => {
  it("upgrades a previous journal in place and preserves its receipts and plan evidence", async () => {
    const directory = await temporaryDirectory();
    const embedder = new ControlledEmbedder();
    const binding = retainedBinding(embedder);
    const file = path.join(directory, "ingestion-queue.sqlite");
    const receipts = retainedReceipts();
    writeRetainedJournal(file, binding, receipts);

    const harness = await createHarness({ directory, embedder });
    const page = await harness.queue.pageReceipts(10);
    expect(
      page.receipts.map((receipt) => [
        receipt.id,
        receipt.status,
        receipt.attemptCount,
      ]),
    ).toEqual([
      [receipts[0]!.id, "stored", 2],
      [receipts[1]!.id, "retrying", 3],
      [receipts[2]!.id, "failed", 5],
    ]);
    expect(page.receipts[0]).toMatchObject({
      sourceKey: "stored",
      acceptedAt: receipts[0]!.acceptedAt,
      noteId: CANDIDATE_ID,
    });
    expect(page.receipts.map((receipt) => receipt.recoveries)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect((await harness.queue.status()).contextCorrection).toBeUndefined();
    expect(harness.queue.binding).toEqual(binding);

    // The file now declares the current schema, with no invented recovery history and no slot.
    const journal = new DatabaseSync(harness.queue.journalPath);
    expect(
      journal
        .prepare(
          "SELECT value FROM queue_metadata WHERE key = 'journalVersion'",
        )
        .get(),
    ).toEqual({ value: "3" });
    expect(
      journal.prepare("SELECT COUNT(*) AS count FROM correction_slot").get(),
    ).toEqual({ count: 0 });
    expect(
      journal
        .prepare("SELECT recoveries FROM receipts WHERE id = ?")
        .get(receipts[1]!.id),
    ).toEqual({ recoveries: null });
    journal.close();

    // The upgraded column is usable: the retained failure can be recovered with new evidence.
    const recovered = await harness.queue.recoverFailed(receipts[2]!.id, {
      expectedAttemptCount: 5,
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.receipt).toMatchObject({
      id: receipts[2]!.id,
      sourceKey: "failed",
      status: "queued",
      attemptCount: 5,
    });
    expect(recovered.receipt.recoveries).toEqual([
      {
        requestedAt: expect.any(String),
        attemptCount: 5,
        lastError: receipts[2]!.lastError,
      },
    ]);
  });

  it("preserves committed plan data and flags through the upgrade", async () => {
    const directory = await temporaryDirectory();
    const embedder = new ControlledEmbedder();
    const file = path.join(directory, "ingestion-queue.sqlite");
    const plan = JSON.stringify({
      version: 1,
      noteId: CANDIDATE_ID,
      representation: representationVersion,
      records: [],
    });
    const id = "0f0e0d0c-0b0a-4000-8000-000000000011";
    writeRetainedJournal(file, retainedBinding(embedder), [
      {
        sequence: 1,
        id,
        sourceKey: "interrupted",
        noteId: CANDIDATE_ID,
        status: "processing",
        content: "The interrupted observation.",
        timestamp: NOTE_TIMESTAMP,
        acceptedAt: "2026-09-27T15:44:27.001+02:00",
        updatedAt: "2026-09-27T15:44:28.001+02:00",
        attemptCount: 1,
        plan,
        planCommitted: true,
        requiresReconciliation: false,
        reconciled: false,
      },
    ]);

    const harness = await createHarness({ directory, embedder });
    const journal = new DatabaseSync(harness.queue.journalPath);
    expect(
      journal
        .prepare(
          "SELECT status, plan, plan_committed, attempt_count FROM receipts WHERE id = ?",
        )
        .get(id),
    ).toEqual({
      status: "processing",
      plan,
      plan_committed: 1,
      attempt_count: 1,
    });
    journal.close();
    await expect(receiptOf(harness.queue, id)).resolves.toMatchObject({
      status: "processing",
      attemptCount: 1,
    });
  });

  it("refuses the upgrade while an old writer owns the journal and leaves the file unchanged", async () => {
    const directory = await temporaryDirectory();
    const embedder = new ControlledEmbedder();
    const binding = retainedBinding(embedder);
    const file = path.join(directory, "ingestion-queue.sqlite");
    writeRetainedJournal(file, binding, retainedReceipts().slice(0, 1));

    const release = await holdQueueLock(await realpath(file));
    try {
      await expect(
        createHarness({ directory, embedder }),
      ).rejects.toBeInstanceOf(QueueWorkerLockedError);
    } finally {
      await release();
    }

    // The refused handle changed nothing: the journal is still the previous schema.
    const journal = new DatabaseSync(file);
    expect(
      journal
        .prepare(
          "SELECT value FROM queue_metadata WHERE key = 'journalVersion'",
        )
        .get(),
    ).toEqual({ value: "2" });
    expect(
      journal.prepare("SELECT COUNT(*) AS count FROM receipts").get(),
    ).toEqual({ count: 1 });
    journal.close();

    // Once the old writer stopped, the same journal opens and upgrades.
    const harness = await createHarness({ directory, embedder });
    expect((await harness.queue.pageReceipts()).receipts).toHaveLength(1);
  });

  it.each(["1", "4"])(
    "refuses the unsupported journal version %s and leaves the file unchanged",
    async (version) => {
      const directory = await temporaryDirectory();
      const embedder = new ControlledEmbedder();
      const file = path.join(directory, "ingestion-queue.sqlite");
      writeRetainedJournal(
        file,
        retainedBinding(embedder),
        retainedReceipts().slice(0, 1),
        version,
      );

      const failure = await rejection(createHarness({ directory, embedder }));
      expect(failure).toBeInstanceOf(QueueBindingError);
      expect((failure as Error).message).toContain(
        `schema version is ${version}`,
      );
      const journal = new DatabaseSync(file);
      expect(
        journal
          .prepare(
            "SELECT value FROM queue_metadata WHERE key = 'journalVersion'",
          )
          .get(),
      ).toEqual({ value: version });
      journal.close();
    },
  );

  it("waits out a concurrent upgrade of the same journal", async () => {
    const directory = await temporaryDirectory();
    const embedder = new ControlledEmbedder();
    const file = path.join(directory, "ingestion-queue.sqlite");
    writeRetainedJournal(
      file,
      retainedBinding(embedder),
      retainedReceipts().slice(0, 1),
    );

    const [first, second] = await Promise.all([
      createHarness({ directory, embedder }),
      createHarness({ directory, embedder }),
    ]);
    for (const harness of [first, second]) {
      expect((await harness.queue.pageReceipts()).receipts).toHaveLength(1);
    }
    const journal = new DatabaseSync(first.queue.journalPath);
    expect(
      journal
        .prepare(
          "SELECT value FROM queue_metadata WHERE key = 'journalVersion'",
        )
        .get(),
    ).toEqual({ value: "3" });
    journal.close();
  });
});
