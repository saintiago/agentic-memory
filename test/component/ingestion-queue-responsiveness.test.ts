import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import {
  AgenticMemory,
  openIngestionQueue,
  type IngestionQueue,
  type MemoryPreparer,
} from "../../src/index.js";
import {
  ControlledEmbedder,
  RecordingStore,
} from "./support/memory-harness.js";

/**
 * Responsiveness check of the durable queue boundary. Journal work runs on the journal's own
 * thread, so a submission waits for its own durable commit without blocking the producer's event
 * loop, even while another connection holds the journal's write lock. This test uses real timers:
 * the evidence is when an already scheduled timer runs, not what the queue reports.
 *
 * See docs/tech-stack.md#infrastructure and docs/ingestion-queue.md#writer-lifecycle-and-retries.
 */

it("keeps the producer's event loop free while another connection holds the journal", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "amem-queue-responsive-"),
  );
  const store = new RecordingStore();
  const embedder = new ControlledEmbedder();
  const memory: MemoryPreparer = new AgenticMemory(store, embedder, {
    generate: async () => {
      throw new Error("The responsiveness check never drains work.");
    },
  });
  const queue: IngestionQueue = await openIngestionQueue({
    directory,
    binding: {
      endpoint: "http://127.0.0.1:6333",
      collection: "memories",
      embeddingSpace: { ...embedder.space },
    },
    memory,
    pollIntervalMs: 10,
  });

  try {
    // Another process holds the journal's write lock, as a competing writer or backup tool can.
    const blocker = new DatabaseSync(queue.journalPath);
    blocker.exec("PRAGMA busy_timeout = 0");
    blocker.exec("BEGIN IMMEDIATE");

    let settled = false;
    const submission = queue
      .submit({ sourceKey: "contended", content: "The contended observation." })
      .then((receipt) => {
        settled = true;
        return receipt;
      });

    const delayed = await new Promise<number>((resolve) => {
      const scheduledAt = Date.now();
      setTimeout(() => resolve(Date.now() - scheduledAt), 50);
    });
    // The already scheduled timer ran promptly while the durable write waited for the write lock.
    expect(delayed).toBeLessThan(1_000);
    expect(settled).toBe(false);

    blocker.exec("COMMIT");
    blocker.close();
    const receipt = await submission;
    expect(receipt.status).toBe("queued");
    expect((await queue.status()).accepted).toBe(1);
  } finally {
    await queue.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
