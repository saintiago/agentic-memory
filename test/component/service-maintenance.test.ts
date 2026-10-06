import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startMemoryService } from "../../service/lifecycle.js";
import { runMaintenanceCommand } from "../../service/maintenance.js";
import {
  ControlledProviders,
  postJson,
  record,
  requestJson,
  serviceSettings,
  startServiceHarness,
  uuid,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Workflow tests for the offline reviewed context correction: the command prepares and applies a
 * correction under the queue's exclusive writer ownership, an interrupted application replays
 * exactly before later ingestion when the matched service restarts, and fresh inspection serves
 * the corrected record. No browser control or agent tool is involved.
 *
 * See docs/service.md#operator-context-correction, docs/testing.md#quality-recovery-and-maintenance-checks
 * and docs/ingestion-queue.md#context-maintenance.
 */

const directories: string[] = [];
const harnesses: ServiceHarness[] = [];
const gates: Array<{ resolve(): void }> = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "amem-maintenance-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  // Release any held provider step so a failed assertion cannot stall harness shutdown.
  for (const gate of gates.splice(0)) {
    gate.resolve();
  }
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface NoteBody {
  readonly id: string;
  readonly content: string;
  readonly timestamp: string;
  readonly updatedAt?: string;
  readonly context: string;
  readonly keywords: readonly string[];
  readonly tags: readonly string[];
  readonly links: readonly string[];
}

interface CommandResult {
  readonly noteId: string;
  readonly changed: boolean;
  readonly note: NoteBody;
}

const correction = {
  attributes: {
    context: "The corrected context of the stored observation.",
    keywords: ["corrected"],
    tags: ["observation"],
  },
};

const writeProposal = async (
  directory: string,
  note: NoteBody,
): Promise<string> => {
  const proposalPath = path.join(directory, "proposal.json");
  await writeFile(
    proposalPath,
    JSON.stringify({ expected: note, attributes: correction.attributes }),
  );
  return proposalPath;
};

const runCorrection = async (
  proposalPath: string,
  harness: Pick<ServiceHarness, "settings" | "providers">,
): Promise<{
  readonly exitCode: number;
  readonly output: readonly string[];
  readonly errors: readonly string[];
}> => {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runMaintenanceCommand(
    ["correct-context", "--input", proposalPath],
    {
      settings: harness.settings,
      factories: harness.providers.factories,
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );
  return { exitCode, output, errors };
};

describe("offline context correction", () => {
  it("refuses a malformed command line or proposal before opening the journal", async () => {
    const directory = await temporaryDirectory();
    const providers = new ControlledProviders();
    const settings = serviceSettings(directory);
    const run = (argv: readonly string[]): Promise<number> =>
      runMaintenanceCommand(argv, {
        settings,
        factories: providers.factories,
        stdout: () => undefined,
        stderr: () => undefined,
      });

    expect(await run([])).toBe(1);
    expect(await run(["correct-context"])).toBe(1);
    expect(await run(["not-a-command", "--input", "x"])).toBe(1);
    expect(await run(["correct-context", "--input"])).toBe(1);
    expect(await run(["correct-context", "--other", "x"])).toBe(1);
    expect(
      await run([
        "correct-context",
        "--input",
        path.join(directory, "absent.json"),
      ]),
    ).toBe(1);

    const notJson = path.join(directory, "not-json.json");
    await writeFile(notJson, "{not json");
    expect(await run(["correct-context", "--input", notJson])).toBe(1);

    const invalid = path.join(directory, "invalid.json");
    await writeFile(invalid, JSON.stringify({ expected: {} }));
    expect(await run(["correct-context", "--input", invalid])).toBe(1);

    // Validation happened before any provider or journal work.
    expect(providers.embedderOpens).toBe(0);
    expect(providers.storeOpens).toBe(0);
    await expect(readdir(directory)).resolves.not.toContain(
      "ingestion-queue.sqlite",
    );
  });

  it("reports an unchanged proposal without a plan or a write", async () => {
    const directory = await temporaryDirectory();
    const providers = new ControlledProviders();
    providers.store.seed(record(1));
    const stored = providers.store.stored(uuid(1)) as NoteBody;
    const proposalPath = path.join(directory, "unchanged.json");
    await writeFile(
      proposalPath,
      JSON.stringify({
        expected: stored,
        attributes: {
          context: stored.context,
          keywords: stored.keywords,
          tags: stored.tags,
        },
      }),
    );

    const result = await runCorrection(proposalPath, {
      settings: serviceSettings(directory),
      providers,
    });
    expect(result.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
    const unchanged = JSON.parse(result.output[0] ?? "") as CommandResult;
    expect(unchanged.changed).toBe(false);
    expect(unchanged.note).toEqual(stored);
    expect(providers.store.writes).toHaveLength(0);
    expect(providers.embedder.texts).toHaveLength(0);
    expect(providers.model.requests).toHaveLength(0);
  });

  it("refuses a stale proposal without writing", async () => {
    const directory = await temporaryDirectory();
    const providers = new ControlledProviders();
    providers.store.seed(record(1));
    const stored = providers.store.stored(uuid(1)) as NoteBody;

    const stalePath = path.join(directory, "stale.json");
    await writeFile(
      stalePath,
      JSON.stringify({
        expected: { ...stored, content: "Source material that moved on." },
        attributes: correction.attributes,
      }),
    );
    const stale = await runCorrection(stalePath, {
      settings: serviceSettings(directory),
      providers,
    });
    expect(stale.exitCode).toBe(1);
    expect(stale.output).toEqual([]);
    expect(
      (JSON.parse(stale.errors[0] ?? "") as { error: { code: string } }).error
        .code,
    ).toBe("stale-proposal");

    const missingPath = path.join(directory, "missing.json");
    await writeFile(
      missingPath,
      JSON.stringify({
        expected: { ...stored, id: uuid(9_999) },
        attributes: correction.attributes,
      }),
    );
    const missing = await runCorrection(missingPath, {
      settings: serviceSettings(directory),
      providers,
    });
    expect(missing.exitCode).toBe(1);
    expect(
      (JSON.parse(missing.errors[0] ?? "") as { error: { code: string } }).error
        .code,
    ).toBe("stale-proposal");

    expect(providers.store.writes).toHaveLength(0);
  });

  it("acknowledges a reviewed correction and serves fresh inspection after restart", async () => {
    const directory = await temporaryDirectory();
    const providers = new ControlledProviders();
    providers.store.seed(record(1, [uuid(2)]));
    const first = await startServiceHarness({
      providers,
      dataDirectory: directory,
    });
    const inspected = await requestJson(first.url(`/v1/notes/${uuid(1)}`));
    expect(inspected.status).toBe(200);
    const expected = inspected.body as NoteBody;
    const proposalPath = await writeProposal(directory, expected);
    await first.runtime.stop();

    const result = await runCorrection(proposalPath, first);
    expect(result.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
    const acknowledged = JSON.parse(result.output[0] ?? "") as CommandResult;
    expect(acknowledged.changed).toBe(true);
    expect(acknowledged.noteId).toBe(uuid(1));
    expect(acknowledged.note.context).toBe(correction.attributes.context);
    // Identity, original source, time and links survive the reviewed attribute change.
    expect(acknowledged.note.content).toBe(expected.content);
    expect(acknowledged.note.timestamp).toBe(expected.timestamp);
    expect(acknowledged.note.links).toEqual(expected.links);
    // No construction, search or evolution ran for the correction.
    expect(providers.model.requests).toHaveLength(0);
    expect(providers.store.writes).toHaveLength(1);
    expect(providers.store.writes[0]).toHaveLength(1);
    expect(providers.store.stored(uuid(1))?.context).toBe(
      correction.attributes.context,
    );

    const second = await startServiceHarness({
      providers,
      dataDirectory: directory,
    });
    harnesses.push(second);
    const inspection = await requestJson(second.url("/v1/inspection/records"));
    expect(inspection.status).toBe(200);
    const records = (
      inspection.body as {
        records: ReadonlyArray<{ note: NoteBody; vector: readonly number[] }>;
      }
    ).records;
    const corrected = records.find((entry) => entry.note.id === uuid(1));
    expect(corrected?.note.context).toBe(correction.attributes.context);
    expect(corrected?.note.content).toBe(expected.content);
    expect(corrected?.vector.length).toBeGreaterThan(0);

    const search = await postJson(second.url("/v1/search"), {
      query: "corrected context",
    });
    const results = (
      search.body as { results: ReadonlyArray<{ note: NoteBody }> }
    ).results;
    expect(
      results.find((entry) => entry.note.id === uuid(1))?.note.context,
    ).toBe(correction.attributes.context);
  });

  it("refuses to correct while the supervised service owns the queue", async () => {
    const directory = await temporaryDirectory();
    const providers = new ControlledProviders();
    providers.store.seed(record(1));
    const harness = await startServiceHarness({
      providers,
      dataDirectory: directory,
    });
    harnesses.push(harness);
    const expected = (await requestJson(harness.url(`/v1/notes/${uuid(1)}`)))
      .body as NoteBody;
    const proposalPath = await writeProposal(directory, expected);

    const result = await runCorrection(proposalPath, harness);
    expect(result.exitCode).toBe(1);
    expect(result.output).toEqual([]);
    const failure = JSON.parse(result.errors[0] ?? "") as {
      error: { code: string; message: string };
    };
    expect(failure.error.code).toBe("ownership-conflict");
    expect(failure.error.message).toContain("already owns the queue");
    // The refused session wrote nothing and the stored record is untouched.
    expect(providers.store.writes).toHaveLength(0);
    expect(providers.store.stored(uuid(1))?.context).toBe(expected.context);
  });

  it("replays an interrupted correction before later ingestion after restart", async () => {
    const directory = await temporaryDirectory();
    const providers = new ControlledProviders();
    providers.store.seed(record(1));
    const expected = providers.store.stored(uuid(1));
    expect(expected).toBeDefined();
    const proposalPath = await writeProposal(directory, expected as NoteBody);

    // The reviewed plan commits durably, then the application acknowledgement is lost.
    providers.store.partialWriteFailures.push(
      new Error("the storage acknowledgement was lost"),
    );
    const interrupted = await runCorrection(proposalPath, {
      settings: serviceSettings(directory),
      providers,
    });
    expect(interrupted.exitCode).toBe(1);
    expect(interrupted.output).toEqual([]);
    const failure = JSON.parse(interrupted.errors[0] ?? "") as {
      error: { code: string };
    };
    expect(failure.error.code).toBe("conflict");
    expect(providers.store.writes).toHaveLength(0);
    expect(providers.store.stored(uuid(1))?.context).toBe(expected?.context);

    // The matched service replays the exact committed plan before any later observation drains.
    const service = await startServiceHarness({
      providers,
      dataDirectory: directory,
    });
    harnesses.push(service);
    await waitFor(
      async () => providers.store.writes.length === 1,
      "the committed correction to replay",
      15_000,
    );
    expect(providers.store.writes[0]?.map((entry) => entry.note.id)).toEqual([
      uuid(1),
    ]);
    expect(providers.store.stored(uuid(1))?.context).toBe(
      correction.attributes.context,
    );
    // Replay applies the stored plan; it never prepares or calls the model again.
    expect(providers.model.requests).toHaveLength(0);
    expect(providers.store.stored(uuid(1))?.updatedAt).toBe(
      providers.store.writes[0]?.[0]?.note.updatedAt,
    );

    const inspection = await requestJson(service.url("/v1/inspection/records"));
    const records = (
      inspection.body as {
        records: ReadonlyArray<{ note: NoteBody; vector: readonly number[] }>;
      }
    ).records;
    const corrected = records.find((entry) => entry.note.id === uuid(1));
    expect(corrected?.note.context).toBe(correction.attributes.context);
    expect(corrected?.vector.length).toBeGreaterThan(0);

    const later = await postJson(service.url("/v1/observations"), {
      sourceKey: "later-observation",
      content: "A later observation accepted after the correction.",
    });
    expect(later.status).toBe(202);
    await waitFor(
      async () => providers.store.writes.length === 2,
      "the later insertion to drain after the correction",
      15_000,
    );
    expect(
      providers.store.writes[1]
        ?.map((entry) => entry.note.content)
        .includes("A later observation accepted after the correction."),
    ).toBe(true);
  });

  it("refuses a second service while the correction owns the queue", async () => {
    const directory = await temporaryDirectory();
    const providers = new ControlledProviders();
    providers.store.seed(record(1));
    const expected = providers.store.stored(uuid(1));
    const proposalPath = await writeProposal(directory, expected as NoteBody);
    const settings = serviceSettings(directory);

    // Hold the correction inside preparation: the queue's writer ownership is held, and the
    // corrected plan has not been written yet.
    const gate = providers.embedder.holdEmbeds();
    gates.push(gate);
    const running = runMaintenanceCommand(
      ["correct-context", "--input", proposalPath],
      { settings, factories: providers.factories, stdout: () => undefined },
    );
    await waitFor(
      () => providers.embedder.embedsStarted === 1,
      "the correction to hold queue ownership",
    );
    await expect(
      startMemoryService({
        settings,
        factories: providers.factories,
        queuePollIntervalMs: 10,
      }),
    ).rejects.toThrow(
      "Another memory service already owns the ingestion queue",
    );

    gate.resolve();
    expect(await running).toBe(0);
    expect(providers.store.stored(uuid(1))?.context).toBe(
      correction.attributes.context,
    );

    // Ownership was released cleanly, so the matched service may start and serve the record.
    const service = await startServiceHarness({
      providers,
      dataDirectory: directory,
    });
    harnesses.push(service);
    const note = await requestJson(service.url(`/v1/notes/${uuid(1)}`));
    expect(note.status).toBe(200);
    expect((note.body as NoteBody).context).toBe(correction.attributes.context);
  });
});
