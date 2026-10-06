import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ServiceClientError,
  createMemoryServiceClient,
} from "../../service/client.js";
import {
  ControlledProviders,
  postJson,
  requestJson,
  startServiceHarness,
  uuid,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Component tests for the operator receipt routes: acceptance-sequence enumeration with
 * queue-owned pagination, explicit failed-observation recovery, documented error mapping and the
 * matched client accepting recovery evidence. The journal serves both routes, so they stay
 * available while providers are unavailable.
 *
 * See docs/service.md#api, docs/ingestion-queue.md#recovery-of-failed-observations and
 * docs/testing.md#quality-recovery-and-maintenance-checks.
 */

const directories: string[] = [];
const harnesses: ServiceHarness[] = [];
const gates: Array<{ resolve(): void }> = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "amem-service-operator-recovery-"),
  );
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

interface ReceiptBody {
  readonly id: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly lastError?: string;
  readonly noteId?: string;
  readonly recoveries?: ReadonlyArray<{
    readonly requestedAt: string;
    readonly attemptCount: number;
    readonly lastError: string;
  }>;
}

interface ReceiptPageBody {
  readonly receipts: readonly ReceiptBody[];
  readonly cursor?: string;
}

const receiptOf = async (
  harness: ServiceHarness,
  id: string,
): Promise<ReceiptBody> =>
  (await requestJson(harness.url(`/v1/receipts/${id}`))).body as ReceiptBody;

describe("receipt enumeration route", () => {
  it("pages every outcome in acceptance order with an opaque token", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);

    const first = await postJson(harness.url("/v1/observations"), {
      sourceKey: "first",
      content: "The first accepted observation.",
    });
    await waitFor(
      async () =>
        (await receiptOf(harness, (first.body as ReceiptBody).id)).status ===
        "stored",
      "the first observation to store",
    );
    // Unusable model output ends as a retained failed receipt, not a silent discard.
    harness.providers.model.construction = { context: "Only a context." };
    const second = await postJson(harness.url("/v1/observations"), {
      sourceKey: "second",
      content: "The observation whose output is unusable.",
    });
    await waitFor(
      async () =>
        (await receiptOf(harness, (second.body as ReceiptBody).id)).status ===
        "failed",
      "the second observation to fail explicitly",
    );
    harness.providers.model.construction = {
      context: "Generated context.",
      keywords: ["keyword"],
      tags: ["tag"],
    };
    const third = await postJson(harness.url("/v1/observations"), {
      sourceKey: "third",
      content: "The third accepted observation.",
    });
    await waitFor(
      async () =>
        (await receiptOf(harness, (third.body as ReceiptBody).id)).status ===
        "stored",
      "the third observation to store",
    );

    const page = await requestJson(harness.url("/v1/receipts?limit=2"));
    expect(page.status).toBe(200);
    const firstPage = page.body as ReceiptPageBody;
    expect(
      firstPage.receipts.map((receipt) => [receipt.status, receipt.id]),
    ).toEqual([
      ["stored", (first.body as ReceiptBody).id],
      ["failed", (second.body as ReceiptBody).id],
    ]);
    expect(firstPage.cursor).toBeDefined();
    // A receipt page exposes outcomes only, never retained source material or plans.
    expect(Object.keys(firstPage.receipts[0] ?? {})).not.toContain("content");
    expect(Object.keys(firstPage.receipts[0] ?? {})).not.toContain(
      "provenance",
    );

    const rest = await requestJson(
      harness.url(
        `/v1/receipts?limit=2&cursor=${encodeURIComponent(firstPage.cursor ?? "")}`,
      ),
    );
    expect(rest.status).toBe(200);
    const secondPage = rest.body as ReceiptPageBody;
    expect(secondPage.receipts.map((receipt) => receipt.id)).toEqual([
      (third.body as ReceiptBody).id,
    ]);
    expect(secondPage.cursor).toBeUndefined();

    const limited = await requestJson(harness.url("/v1/receipts?limit=1"));
    expect(limited.status).toBe(200);
    expect((limited.body as ReceiptPageBody).receipts).toHaveLength(1);
  });

  it("refuses invalid limits and cursors without querying another pagination", async () => {
    const harness = await startServiceHarness();
    harnesses.push(harness);
    await postJson(harness.url("/v1/observations"), {
      sourceKey: "any",
      content: "An accepted observation.",
    });

    for (const query of ["?limit=0", "?limit=abc", "?limit=-1"]) {
      const response = await requestJson(harness.url(`/v1/receipts${query}`));
      expect(response.status, query).toBe(400);
      expect(
        (response.body as { error: { code: string } }).error.code,
        query,
      ).toBe("invalid-request");
    }
    const badToken = await requestJson(
      harness.url("/v1/receipts?cursor=not-a-token"),
    );
    expect(badToken.status).toBe(400);
    // A token issued for a note page would decode to another cursor kind and is refused.
    const numberToken = Buffer.from("123", "utf8").toString("base64url");
    const wrongKind = await requestJson(
      harness.url(`/v1/receipts?cursor=${numberToken}`),
    );
    expect(wrongKind.status).toBe(400);
    expect(
      (wrongKind.body as { error: { message: string } }).error.message,
    ).toBe("The receipt page cursor is not valid.");
  });
});

describe("failed-observation recovery route", () => {
  it("recovers a failed receipt without providers and preserves its evidence", async () => {
    const directory = await temporaryDirectory();
    const failing = new ControlledProviders();
    failing.model.construction = { context: "Only a context." };
    const first = await startServiceHarness({
      providers: failing,
      dataDirectory: directory,
    });
    const accepted = await postJson(first.url("/v1/observations"), {
      sourceKey: "retained-failure",
      content: "An observation with unusable model output.",
    });
    expect(accepted.status).toBe(202);
    const receiptId = (accepted.body as ReceiptBody).id;
    await waitFor(
      async () => (await receiptOf(first, receiptId)).status === "failed",
      "the observation to be retained as failed",
    );
    const failed = await receiptOf(first, receiptId);
    expect(failed.attemptCount).toBe(1);
    expect(failed.lastError).toBeDefined();
    await first.runtime.stop();

    // The journal alone serves enumeration and recovery: a held encoder means the restarted
    // service has no provider stack at all.
    const unavailable = new ControlledProviders();
    const gate = unavailable.holdEmbedder();
    gates.push(gate);
    const second = await startServiceHarness({
      providers: unavailable,
      dataDirectory: directory,
      waitForProviders: false,
    });
    harnesses.push(second);
    const status = await requestJson(second.url("/v1/status"));
    expect(
      (status.body as { availability: { retrieval: boolean } }).availability
        .retrieval,
    ).toBe(false);

    const client = createMemoryServiceClient({ url: second.baseUrl });
    const page = await client.receipts();
    expect(page.receipts.map((receipt) => receipt.id)).toEqual([receiptId]);
    expect(page.receipts[0]?.status).toBe("failed");
    expect(page.cursor).toBeUndefined();

    const recovered = await client.recover(receiptId, 1);
    expect(recovered.recovered).toBe(true);
    expect(recovered.receipt.status).toBe("queued");
    expect(recovered.receipt.recoveries).toEqual([
      expect.objectContaining({
        attemptCount: 1,
        lastError: failed.lastError,
      }),
    ]);
    expect(
      new Date(recovered.receipt.recoveries![0]!.requestedAt).toISOString(),
    ).toBe(recovered.receipt.recoveries![0]!.requestedAt);
    expect(unavailable.storeOpens).toBe(0);

    // The recovered receipt is enumerable with its retained evidence and no source payload.
    const after = await client.receipts(10);
    expect(after.receipts[0]?.recoveries).toHaveLength(1);

    // Repeating the inspected count is ineffective, not a second recovery.
    const repeat = await client.recover(receiptId, 1);
    expect(repeat.recovered).toBe(false);
    expect(repeat.receipt.recoveries).toHaveLength(1);

    // A count the receipt never reached is refused with the queue's safe reason.
    const future = await client
      .recover(receiptId, 99)
      .catch((cause: unknown) => cause);
    expect(future).toBeInstanceOf(ServiceClientError);
    expect(future).toMatchObject({
      status: 409,
      code: "conflict",
      retryable: false,
    });
    expect((future as ServiceClientError).message).toContain("fewer than");

    const missing = await client
      .recover(uuid(9_999), 1)
      .catch((cause: unknown) => cause);
    expect(missing).toMatchObject({ status: 404, code: "not-found" });

    const malformed = await postJson(
      second.url("/v1/receipts/not-a-uuid/recover"),
      { expectedAttemptCount: 1 },
    );
    expect(malformed.status).toBe(400);
    const invalidCount = await postJson(
      second.url(`/v1/receipts/${receiptId}/recover`),
      { expectedAttemptCount: -1 },
    );
    expect(invalidCount.status).toBe(400);
    const wrongMethod = await requestJson(
      second.url(`/v1/receipts/${receiptId}/recover`),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    // The recovery itself wrote no note; the recovered work waits for the missing provider.
    expect(unavailable.store.writes).toHaveLength(0);
    gate.resolve();
  });
});
