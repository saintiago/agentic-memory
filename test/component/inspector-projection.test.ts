import { describe, expect, it } from "vitest";

import {
  minProjectedNotes,
  ProjectionError,
  ProjectionState,
  projectionParameters,
  vectorIdentity,
  type ProjectionArtifact,
  type ProjectionInput,
  type ProjectionRequest,
} from "../../inspector/projection.js";
import { handleProjectionMessage } from "../../inspector/projection-protocol.js";
import { createThreadProjectionRunner } from "../../inspector/projection-runner.js";
import { uuid, vector } from "./support/inspection.js";

/**
 * Component tests for the inspection projection: a real UMAP fit with the pinned parameters, the
 * transform lifecycle, the labeled fallback, the persisted-coordinate reuse and the original-space
 * cosine comparison. The worker thread the host launches is exercised for real.
 *
 * See docs/dashboard.md#vector-projection-and-proximity and docs/testing.md#choosing-scope.
 */

const inputs = (count: number, offset = 0, dimensions = 8): ProjectionInput[] =>
  Array.from({ length: count }, (_, index) => ({
    id: uuid(index + offset),
    vector: vector(index + offset, dimensions),
  }));

const request = (
  list: readonly ProjectionInput[],
  overrides: Partial<ProjectionRequest> = {},
): ProjectionRequest => ({
  collection: "notes",
  embeddingSpaceId: "space-1",
  inputs: list,
  rebuild: false,
  ...overrides,
});

const positions = (
  artifact: ProjectionArtifact,
): Map<string, { x: number; y: number }> =>
  new Map(artifact.coordinates.map(({ id, x, y }) => [id, { x, y }]));

const expectFinite = (artifact: ProjectionArtifact): void => {
  expect(artifact.coordinates.length).toBeGreaterThan(0);
  for (const point of artifact.coordinates) {
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  }
};

describe("inspection projection", () => {
  it("fits a reproducible projection from the recorded parameters, independent of export order", () => {
    const fitted = new ProjectionState().project(request(inputs(24)));

    expect(fitted.layout).toBe("umap");
    expect(fitted.projectionId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fitted.parameters).toEqual(projectionParameters);
    expect(fitted.algorithm).toEqual({ name: "umap-js", version: "1.4.0" });
    expect(fitted.fitInputs).toHaveLength(24);
    expect(fitted.coordinates).toHaveLength(24);
    expectFinite(fitted);

    // The same export in the reverse page order projects to the same coordinates and identity.
    const again = new ProjectionState().project(
      request([...inputs(24)].reverse()),
    );
    expect(again.coordinates).toEqual(fitted.coordinates);
    expect(again.projectionId).toBe(fitted.projectionId);
  });

  it("transforms new or changed vectors through the fitted projection, keeping the rest", () => {
    const state = new ProjectionState();
    const fitted = state.project(request(inputs(20)));
    const before = positions(fitted);
    const addition = inputs(3, 100);
    const changed = {
      id: uuid(0),
      vector: vector(0, 8).map((value) => value + 0.75),
    };
    const grown = [
      ...inputs(20).map((input) => (input.id === changed.id ? changed : input)),
      ...addition,
    ];

    const refreshed = state.project(request(grown));

    expect(refreshed.layout).toBe("umap");
    expect(refreshed.projectionId).toBe(fitted.projectionId);
    expect(refreshed.coordinates).toHaveLength(23);
    expectFinite(refreshed);
    const after = positions(refreshed);
    for (const input of inputs(20)) {
      if (input.id !== changed.id) {
        expect(after.get(input.id)).toEqual(before.get(input.id));
      }
    }
    expect(after.get(changed.id)).not.toEqual(before.get(changed.id));
    for (const input of addition) {
      expect(after.get(input.id)).not.toBeUndefined();
    }
  });

  it("refits only for an explicit rebuild", () => {
    const state = new ProjectionState();
    const fitted = state.project(request(inputs(20)));
    const grown = [...inputs(20), ...inputs(2, 200)];
    const transformed = state.project(request(grown));

    expect(transformed.projectionId).toBe(fitted.projectionId);

    const rebuilt = state.project(request(grown, { rebuild: true }));
    expect(rebuilt.projectionId).not.toBe(fitted.projectionId);
    expect(rebuilt.layout).toBe("umap");
    expect(rebuilt.fitInputs).toHaveLength(22);
    expectFinite(rebuilt);

    const repeated = new ProjectionState().project(
      request(grown, { rebuild: true }),
    );
    expect(repeated.coordinates).toEqual(rebuilt.coordinates);
    expect(repeated.projectionId).toBe(rebuilt.projectionId);
  });

  it("labels a tiny export as a non-semantic layout until a projection can be fitted", () => {
    const state = new ProjectionState();
    const tiny = state.project(request(inputs(minProjectedNotes - 1)));

    expect(tiny.layout).toBe("non-semantic");
    expectFinite(tiny);

    const grown = state.project(request(inputs(minProjectedNotes)));
    expect(grown.layout).toBe("umap");
    expect(grown.projectionId).not.toBe(tiny.projectionId);
    expectFinite(grown);
  });

  it("projects an empty export without inventing coordinates", () => {
    const empty = new ProjectionState().project(request([]));

    expect(empty.layout).toBe("non-semantic");
    expect(empty.coordinates).toEqual([]);
    expect(empty.fitInputs).toEqual([]);
    expect(() => new ProjectionState().compare(uuid(0), uuid(1))).toThrow(
      /latest completed graph view/,
    );
  });

  it("reuses a matching persisted projection after a restart and ignores a mismatched one", () => {
    const base = request(inputs(20));
    const fitted = new ProjectionState().project(base);
    // A distinctive build time distinguishes reuse from a fresh fit.
    const persisted: ProjectionArtifact = {
      ...fitted,
      builtAt: "2020-01-01T00:00:00.000Z",
    };

    const restarted = new ProjectionState().project({
      ...base,
      cached: persisted,
    });
    expect(restarted.builtAt).toBe(persisted.builtAt);
    expect(restarted.coordinates).toEqual(fitted.coordinates);
    expect(restarted.projectionId).toBe(fitted.projectionId);

    const changedInputs = inputs(20).map((input, index) =>
      index === 0 ? { ...input, vector: vector(500, 8) } : input,
    );
    const changed = new ProjectionState().project({
      ...base,
      inputs: changedInputs,
      cached: persisted,
    });
    expect(changed.builtAt).not.toBe(persisted.builtAt);
    expect(changed.projectionId).not.toBe(fitted.projectionId);

    const foreign = new ProjectionState().project({
      ...base,
      embeddingSpaceId: "space-2",
      cached: persisted,
    });
    expect(foreign.builtAt).not.toBe(persisted.builtAt);
    expect(foreign.embeddingSpaceId).toBe("space-2");
  });

  it("compares original stored vectors and rejects an unknown note without changing state", () => {
    const state = new ProjectionState();
    state.project(
      request([
        { id: uuid(1), vector: [1, 0, 0] },
        { id: uuid(2), vector: [0, 1, 0] },
        { id: uuid(3), vector: [1, 0, 0] },
      ]),
    );

    expect(state.compare(uuid(1), uuid(3))).toBeCloseTo(1, 12);
    expect(state.compare(uuid(1), uuid(2))).toBeCloseTo(0, 12);
    // UUID identity is case-insensitive, so a differently spelled identity still compares.
    expect(state.compare(uuid(1).toUpperCase(), uuid(2))).toBeCloseTo(0, 12);
    expect(() => state.compare(uuid(1), uuid(99))).toThrow(ProjectionError);
    expect(state.compare(uuid(1), uuid(2))).toBeCloseTo(0, 12);
  });

  it("identifies exact stored vector values", () => {
    expect(vectorIdentity([1, 2, 3])).toBe(vectorIdentity([1, 2, 3]));
    expect(vectorIdentity([1, 2, 3])).not.toBe(vectorIdentity([1, 2, 4]));
    expect(vectorIdentity([1, 2, 3])).not.toBe(vectorIdentity([3, 2, 1]));
    expect(vectorIdentity([1, 2, 3])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects exports with duplicate identities or unusable vectors", () => {
    const state = new ProjectionState();
    const base = request([]);

    expect(() =>
      state.project({
        ...base,
        inputs: [
          { id: uuid(1), vector: [1, 0] },
          { id: uuid(1).toUpperCase(), vector: [0, 1] },
        ],
      }),
    ).toThrow(ProjectionError);
    expect(() =>
      state.project({
        ...base,
        inputs: [
          { id: uuid(1), vector: [1, 0] },
          { id: uuid(2), vector: [0, 1, 2] },
        ],
      }),
    ).toThrow(ProjectionError);
    expect(() =>
      state.project({
        ...base,
        inputs: [{ id: uuid(1), vector: [1, Number.NaN] }],
      }),
    ).toThrow(ProjectionError);
  });

  it("classifies worker protocol outcomes", () => {
    const state = new ProjectionState();
    const projected = handleProjectionMessage(state, {
      type: "project",
      requestId: 7,
      request: request([
        { id: uuid(1), vector: [1, 0] },
        { id: uuid(2), vector: [0, 1] },
      ]),
    });
    expect(projected).toMatchObject({ type: "projected", requestId: 7 });

    const compared = handleProjectionMessage(state, {
      type: "compare",
      requestId: 8,
      leftId: uuid(1),
      rightId: uuid(1),
    });
    expect(compared).toMatchObject({ type: "compared", requestId: 8 });

    const failed = handleProjectionMessage(state, {
      type: "compare",
      requestId: 9,
      leftId: uuid(1),
      rightId: uuid(99),
    });
    expect(failed).toMatchObject({
      type: "failed",
      requestId: 9,
      code: "unknown-note",
    });
  });

  it("projects and compares through the worker thread the host launches", async () => {
    const runner = createThreadProjectionRunner();
    try {
      const artifact = await runner.project(request(inputs(24)));
      expect(artifact.coordinates).toHaveLength(24);
      expectFinite(artifact);
      await expect(runner.compare(uuid(0), uuid(0))).resolves.toBeCloseTo(
        1,
        12,
      );
      await expect(runner.compare(uuid(0), uuid(90))).rejects.toThrow(
        /latest completed graph view/,
      );
    } finally {
      await runner.close();
    }
  }, 60_000);
});
