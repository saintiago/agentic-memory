import { afterEach, describe, expect, it } from "vitest";

import {
  FairScheduler,
  InferenceOverloadedError,
} from "../../service/scheduler.js";
import {
  ControlledProviders,
  deferred,
  postJson,
  requestJson,
  startServiceHarness,
  waitFor,
  type ServiceHarness,
} from "./support/service.js";

/**
 * Component tests for the shared inference scheduling: bounded fair admission in arrival order,
 * ingestion that does not starve a waiting search, and explicit overload instead of unbounded
 * in-memory work.
 *
 * See docs/service.md#async-work-and-resource-sharing.
 */

const harnesses: ServiceHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

describe("fair scheduler", () => {
  it("admits waiting operations in arrival order and refuses work beyond its bound", async () => {
    const scheduler = new FairScheduler({ limit: 1, queueLimit: 1 });
    const order: string[] = [];
    const release = deferred<void>();
    const first = scheduler.run(async () => {
      order.push("first");
      await release.promise;
    });
    const second = scheduler.run(async () => {
      order.push("second");
    });
    const third = scheduler.run(async () => {
      order.push("third");
    });

    await expect(third).rejects.toBeInstanceOf(InferenceOverloadedError);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(scheduler.running).toBe(0);
    expect(scheduler.waiting).toBe(0);
  });
});

describe("service admission", () => {
  it("serves a search that arrived during an ingestion operation before later ingestion work", async () => {
    const providers = new ControlledProviders();
    const scheduler = new FairScheduler({ limit: 1, queueLimit: 8 });
    const harness = await startServiceHarness({ providers, scheduler });
    harnesses.push(harness);
    const gate = providers.model.holdGenerate();

    const first = await postJson(harness.url("/v1/observations"), {
      sourceKey: "first-source",
      content: "The first observation.",
    });
    expect(first.status).toBe(202);
    await waitFor(
      () => providers.model.requests.length === 1,
      "the first insertion to reach the model",
    );

    const search = postJson(harness.url("/v1/search"), {
      query: "query text",
    });
    await waitFor(
      () => scheduler.waiting === 1,
      "the search to wait for the inference slot",
    );
    // Once the search is admitted to the queue, later ingestion work cannot overtake it.
    // The durable worker accepts the second observation, but it drains after the first.
    const second = await postJson(harness.url("/v1/observations"), {
      sourceKey: "second-source",
      content: "The second observation.",
    });
    expect(second.status).toBe(202);

    gate.resolve();
    const searched = await search;
    expect(searched.status).toBe(200);
    await waitFor(async () => {
      const receipt = await requestJson(
        harness.url(
          `/v1/receipts/${String((second.body as { id: string }).id)}`,
        ),
      );
      return (receipt.body as { status: string }).status === "stored";
    }, "the second observation to be stored");

    // Inferences in order: the first insertion's representation, the waiting search query,
    // then the second insertion. Fair admission keeps one insertion from monopolizing the encoder.
    const texts = providers.embedder.texts;
    expect(texts[1]).toBe("query text");
    expect(texts[2]).toContain("The second observation.");
  });

  it("reports overload with 429 and Retry-After instead of holding unbounded work", async () => {
    const providers = new ControlledProviders();
    const scheduler = new FairScheduler({
      limit: 1,
      queueLimit: 1,
      retryAfterMs: 100,
    });
    const harness = await startServiceHarness({
      providers,
      scheduler,
    });
    harnesses.push(harness);
    const gate = providers.model.holdGenerate();

    const accepted = await postJson(harness.url("/v1/observations"), {
      sourceKey: "holding-source",
      content: "An insertion that holds the inference slot.",
    });
    expect(accepted.status).toBe(202);
    await waitFor(
      () => providers.model.requests.length === 1,
      "the held insertion",
    );

    const waiting = postJson(harness.url("/v1/search"), {
      query: "waiting query",
    });
    await waitFor(
      () => scheduler.waiting === 1,
      "the first search to wait for the inference slot",
    );
    const overloaded = await postJson(harness.url("/v1/search"), {
      query: "another query",
    });
    expect(overloaded.status).toBe(429);
    expect(overloaded.headers.get("retry-after")).toBe("1");
    expect(overloaded.body).toEqual({
      error: {
        code: "overloaded",
        message: "The memory service is temporarily overloaded; retry later.",
        retryable: true,
      },
    });

    gate.resolve();
    const served = await waiting;
    expect(served.status).toBe(200);
  });
});
