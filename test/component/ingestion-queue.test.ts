import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgenticMemory,
  QueueBindingError,
  QueueConflictError,
  QueueRequestError,
  QueueWorkerLockedError,
  openIngestionQueue,
  type IngestionQueue,
  type InsertionPlan,
  type LegacyReceipt,
  type MemoryPreparer,
  type Note,
  type PrepareInput,
  type QueueObservation,
  type QueueReceipt,
} from "../../src/index.js";
import {
  ControlledEmbedder,
  RecordingStore,
  ScriptedModel,
  flush,
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

    expect(resubmitted).toEqual(accepted);
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
});

describe("receipts and status", () => {
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
});
