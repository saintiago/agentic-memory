import { describe, expect, it } from "vitest";

import {
  fitProjectionModel,
  minProjectedNotes,
  placeVector,
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

  it("removes notes without refitting or moving the surviving coordinates", () => {
    const state = new ProjectionState();
    const fitted = state.project(request(inputs(20)));
    const before = positions(fitted);

    // A refresh that only removes notes transforms nothing: the survivors keep their coordinates
    // and the fitted model stays available.
    const removed = state.project(request(inputs(20).slice(0, 19)));
    expect(removed.layout).toBe("umap");
    expect(removed.projectionId).toBe(fitted.projectionId);
    expect(removed.coordinates).toHaveLength(19);
    for (const input of inputs(20).slice(0, 19)) {
      expect(positions(removed).get(input.id)).toEqual(before.get(input.id));
    }

    // The model survived: the next addition is transformed into the same projection.
    const grown = state.project(
      request([...inputs(20).slice(0, 19), ...inputs(1, 500)]),
    );
    expect(grown.projectionId).toBe(fitted.projectionId);
    expect(grown.coordinates).toHaveLength(20);
    expectFinite(grown);

    // Removing every note keeps the projection identity and its fitted model as well.
    const emptied = state.project(request([]));
    expect(emptied.coordinates).toEqual([]);
    expect(emptied.projectionId).toBe(fitted.projectionId);
    const revived = state.project(request(inputs(1, 700)));
    expect(revived.projectionId).toBe(fitted.projectionId);
    expectFinite(revived);
  });

  it("keeps the fitted anchors fixed when a refresh transforms as many vectors as the fit", () => {
    const model = fitProjectionModel(
      inputs(20).map((input) => [...input.vector]),
    );
    const anchors = model.getEmbedding().map((row) => [...row]);

    // umap-js 1.4.0 moves its training coordinates when a transform batch is exactly as long as
    // the training set; the integration places one vector per call, so the anchors cannot move.
    const placed = inputs(20, 100).map((input) =>
      placeVector(model, [...input.vector]),
    );
    expect(model.getEmbedding()).toEqual(anchors);
    for (const point of placed) {
      expect(point).not.toBeUndefined();
      expect(Number.isFinite(point?.x)).toBe(true);
      expect(Number.isFinite(point?.y)).toBe(true);
    }

    // An equal-sized batch of new vectors leaves the published anchors alone too.
    const state = new ProjectionState();
    const fitted = state.project(request(inputs(20)));
    const before = positions(fitted);
    const grown = state.project(request([...inputs(20), ...inputs(20, 100)]));
    expect(grown.projectionId).toBe(fitted.projectionId);
    expect(grown.coordinates).toHaveLength(40);
    for (const input of inputs(20)) {
      expect(positions(grown).get(input.id)).toEqual(before.get(input.id));
    }
  });

  it("places repeated equivalent vectors in the existing projection", () => {
    // Distinct notes may hold identical stored content; the shared vector is a realistic
    // float32-rounded, normalized embedding-space vector.
    const shared = (() => {
      const values = Array.from({ length: 1_024 }, (_, index) =>
        Math.sin(index * 0.37),
      );
      const norm = Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0),
      );
      return Array.from(values, (value) => Math.fround(value / norm));
    })();
    const repeated = (count: number): ProjectionInput[] =>
      Array.from({ length: count }, (_, index) => ({
        id: uuid(index),
        vector: [...shared],
      }));

    const state = new ProjectionState();
    const fitted = state.project(request(repeated(20)));
    expect(fitted.layout).toBe("umap");
    const before = positions(fitted);

    // The twenty-first equivalent vector is placed through the existing projection instead of
    // failing the refresh, and it keeps the position of its nearest committed memory.
    for (let extra = 1; extra <= 3; extra += 1) {
      const grown = state.project(request(repeated(20 + extra)));
      expect(grown.projectionId).toBe(fitted.projectionId);
      expect(grown.coordinates).toHaveLength(20 + extra);
      expectFinite(grown);
      expect(positions(grown).get(uuid(20 + extra - 1))).toEqual(
        before.get(uuid(0)),
      );
      for (const input of repeated(20)) {
        expect(positions(grown).get(input.id)).toEqual(before.get(input.id));
      }
    }
  });

  it("retains degenerate fitted anchors across empty exports and replaces them on rebuild", async () => {
    const values = vector(7, 1_024);
    const norm = Math.sqrt(
      values.reduce((sum, value) => sum + value * value, 0),
    );
    const shared = values.map((value) => Math.fround(value / norm));
    const repeated = (offset: number, count: number): ProjectionInput[] =>
      Array.from({ length: count }, (_, index) => ({
        id: uuid(offset + index),
        vector: shared,
      }));
    const runner = createThreadProjectionRunner();
    try {
      const fitted = await runner.project(request(repeated(0, 20)));
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const empty = await runner.project(request([]));
        expect(empty.coordinates).toEqual([]);
        expect(empty.projectionId).toBe(fitted.projectionId);
        await expect(runner.compare(uuid(0), uuid(0))).rejects.toThrow(
          /does not hold a vector/,
        );
        const revived = await runner.project(request(repeated(cycle * 100, 1)));
        expect(revived.projectionId).toBe(fitted.projectionId);
        expect(revived.fitInputs).toEqual(fitted.fitInputs);
        expectFinite(revived);
        expect(positions(revived).get(uuid(cycle * 100))).toEqual(
          positions(fitted).get(uuid(0)),
        );
      }
      const rebuilt = await runner.project(
        request(repeated(500, 24), { rebuild: true }),
      );
      expect(rebuilt.projectionId).not.toBe(fitted.projectionId);
      await runner.project(request([]));
      const revived = await runner.project(request(repeated(900, 1)));
      expect(revived.projectionId).toBe(rebuilt.projectionId);
      expect(positions(revived).get(uuid(900))).toEqual(
        positions(rebuilt).get(uuid(500)),
      );
    } finally {
      await runner.close();
    }
  }, 60_000);

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

  it("rebuilds instead of reusing live coordinates after the service identity changes", () => {
    const state = new ProjectionState();
    const fitted = state.project(request(inputs(20)));

    // The export is unchanged, but a reconfigured service owns another collection: the previous
    // artifact, its fitted model and its coordinates never answer for the new identity.
    const otherCollection = state.project(
      request(inputs(20), { collection: "reconfigured-notes" }),
    );
    expect(otherCollection.collection).toBe("reconfigured-notes");
    expect(otherCollection.embeddingSpaceId).toBe("space-1");
    expect(otherCollection.coordinates).toHaveLength(20);
    expectFinite(otherCollection);

    // The same applies to another embedding space with unchanged vectors.
    const otherSpace = state.project(
      request(inputs(20), {
        collection: "reconfigured-notes",
        embeddingSpaceId: "space-2",
      }),
    );
    expect(otherSpace.embeddingSpaceId).toBe("space-2");
    expect(otherSpace.projectionId).not.toBe(fitted.projectionId);
    expect(otherSpace.coordinates).toHaveLength(20);
    expectFinite(otherSpace);
  });

  it("fits a changed export for the new identity instead of transforming through the old model", () => {
    const state = new ProjectionState();
    const fitted = state.project(request(inputs(20)));
    const changed = [...inputs(20, 300), ...inputs(3, 900)];

    const projected = state.project(
      request(changed, { embeddingSpaceId: "space-2" }),
    );

    // A transformed export would keep the previous fit inputs and embedding space.
    expect(projected.embeddingSpaceId).toBe("space-2");
    expect(projected.fitInputs).toHaveLength(changed.length);
    expect(projected.fitInputs.map(({ id }) => id).sort()).toEqual(
      changed.map(({ id }) => id.toLowerCase()).sort(),
    );
    expect(projected.coordinates).toHaveLength(changed.length);
    expect(projected.projectionId).not.toBe(fitted.projectionId);
    expectFinite(projected);
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
