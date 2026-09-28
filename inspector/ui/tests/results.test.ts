/**
 * The memory-request evidence: the exact returned order, direct scores only for direct matches,
 * a later request winning over an earlier one, a failed request staying an error and results the
 * map does not contain yet.
 *
 * See docs/dashboard.md#memory-requests and docs/dashboard.md#acceptance-checks.
 */
import { describe, expect, it } from "vitest";

import { SearchResults } from "../results.js";
import { nodeId, note, searchOutcome } from "./support.js";

const matched = (index: number, score: number) =>
  ({ note: note(index), via: "match", score }) as const;
const linked = (index: number) => ({ note: note(index), via: "link" }) as const;

describe("search results", () => {
  it("keeps the returned order, classification and direct scores", () => {
    const results = new SearchResults();
    const id = results.begin({ query: "memory" });
    results.accept(
      id,
      searchOutcome([matched(2, 0.8123), linked(0), matched(1, 0.5)]),
    );

    expect(results.resultIds()).toEqual([nodeId(2), nodeId(0), nodeId(1)]);
    expect(results.retrievalKind(nodeId(2))).toBe("match");
    expect(results.retrievalKind(nodeId(0))).toBe("link");
    expect([...results.highlightIds].sort()).toEqual(
      [nodeId(0), nodeId(1), nodeId(2)].sort(),
    );
    expect(results.state().outcome?.results[0]).toEqual(matched(2, 0.8123));
    expect(results.noteFor(nodeId(0))).toEqual(note(0));
  });

  it("keeps a zero-result response as a successful empty result", () => {
    const results = new SearchResults();
    const id = results.begin({ query: "nothing" });
    expect(results.accept(id, searchOutcome([]))).toBe(true);

    expect(results.state().outcome?.results).toEqual([]);
    expect(results.state().error).toBeUndefined();
    expect(results.highlightIds.size).toBe(0);
  });

  it("ignores an older response that finishes after a newer request", () => {
    const results = new SearchResults();
    const first = results.begin({ query: "first" });
    const second = results.begin({ query: "second" });

    expect(results.accept(first, searchOutcome([matched(0, 0.9)]))).toBe(false);
    expect(results.accept(second, searchOutcome([matched(1, 0.4)]))).toBe(true);

    expect(results.resultIds()).toEqual([nodeId(1)]);
    expect(results.state().request?.query).toBe("second");
  });

  it("keeps a failure an error and never an empty result", () => {
    const results = new SearchResults();
    const id = results.begin({ query: "broken" });
    expect(results.fail(id, "The search failed.")).toBe(true);

    expect(results.state().error).toBe("The search failed.");
    expect(results.state().outcome).toBeUndefined();
    expect(results.resultIds()).toEqual([]);
    expect(results.highlightIds.size).toBe(0);
  });

  it("reports the returned memories the display does not contain", () => {
    const results = new SearchResults();
    const id = results.begin({ query: "memory" });
    results.accept(id, searchOutcome([matched(0, 0.9), linked(5)]));

    expect(
      results.unmappedIds((nodeIdValue) => nodeIdValue === nodeId(0)),
    ).toEqual([nodeId(5)]);
    expect(results.unmappedIds(() => true)).toEqual([]);
  });

  it("clears the request, its evidence and any pending answer", () => {
    const results = new SearchResults();
    const id = results.begin({ query: "memory" });
    results.accept(id, searchOutcome([matched(0, 0.9)]));

    results.clear();
    expect(results.accept(id, searchOutcome([matched(1, 0.1)]))).toBe(false);
    expect(results.state().request).toBeUndefined();
    expect(results.state().outcome).toBeUndefined();
    expect(results.highlightIds.size).toBe(0);
  });

  it("changes its revision whenever the returned evidence changes", () => {
    const results = new SearchResults();
    const initial = results.revision();
    const id = results.begin({ query: "memory" });
    expect(results.revision()).toBeGreaterThan(initial);
    results.accept(id, searchOutcome([matched(0, 0.9)]));
    expect(results.revision()).toBeGreaterThan(initial);
  });
});
