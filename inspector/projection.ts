/**
 * Vector projection and proximity of the local inspection host: fit a two-dimensional UMAP
 * projection over the stored vectors of one embedding space, transform new or changed vectors
 * through the fitted model, and compare original stored vectors by cosine similarity.
 *
 * The projection is disposable inspection state. It never mixes embedding spaces, never becomes
 * part of runtime persistence and never writes a memory. This module is pure CPU work and is
 * executed by the projection worker, not by the HTTP event loop.
 *
 * See docs/dashboard.md#vector-projection-and-proximity.
 */
import { createHash } from "node:crypto";
import { UMAP } from "umap-js";
import { z } from "zod";

/** The projection algorithm recorded with every artifact. */
export const projectionAlgorithm = {
  name: "umap-js",
  version: "1.4.0",
} as const;

/**
 * Fixed fit parameters. They are pinned with the algorithm version so a recorded projection can be
 * reproduced, and they change only with a new recorded algorithm identity.
 */
export const projectionParameters = {
  metric: "cosine",
  nComponents: 2,
  nNeighbors: 15,
  minDist: 0.1,
  seed: 42,
  // umap-js derives the epoch count from the input size; overriding it with a value that is not a
  // multiple of its transform's three-way split leaves its fitting loop without a terminating
  // epoch, so the pinned parameters leave that count to the library.
  nEpochs: "library-default",
} as const;

/** One UMAP fit needs at least one more point than its neighbor count. */
export const minProjectedNotes = projectionParameters.nNeighbors + 1;

/** A note identity and the vector identity its coordinates were computed from. */
const projectionInputIdentitySchema = z.strictObject({
  /** The lowercased note ID; UUID identity is case-insensitive. */
  id: z.string(),
  /** A digest of the exact stored vector values. */
  vectorId: z.string(),
});

/** A projected note with the vector identity behind its coordinates. */
const projectionPointSchema = z.strictObject({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  vectorId: z.string(),
});

/**
 * One completed projection: what was fitted, with which parameters, and where the current export
 * was placed. Coordinates are disposable inspection artifacts; the vectors stay in the process's
 * inspection state only.
 */
export const projectionArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  collection: z.string(),
  embeddingSpaceId: z.string(),
  layout: z.enum(["umap", "non-semantic"]),
  projectionId: z.string(),
  algorithm: z.strictObject({
    name: z.literal(projectionAlgorithm.name),
    version: z.literal(projectionAlgorithm.version),
  }),
  parameters: z.strictObject({
    metric: z.literal(projectionParameters.metric),
    nComponents: z.literal(projectionParameters.nComponents),
    nNeighbors: z.literal(projectionParameters.nNeighbors),
    minDist: z.literal(projectionParameters.minDist),
    seed: z.literal(projectionParameters.seed),
    nEpochs: z.literal(projectionParameters.nEpochs),
  }),
  builtAt: z.string(),
  fitInputs: z.array(projectionInputIdentitySchema),
  coordinates: z.array(projectionPointSchema),
});

export type ProjectionArtifact = z.infer<typeof projectionArtifactSchema>;
export type ProjectionInputIdentity = z.infer<
  typeof projectionInputIdentitySchema
>;
export type ProjectionPoint = z.infer<typeof projectionPointSchema>;

/** One note offered to the projection: its identity and its exact stored vector. */
export interface ProjectionInput {
  readonly id: string;
  readonly vector: readonly number[];
}

/** One projection or rebuild request of the host. */
export interface ProjectionRequest {
  readonly collection: string;
  readonly embeddingSpaceId: string;
  readonly inputs: readonly ProjectionInput[];
  /** Request a full fit instead of transforming into the fitted model. */
  readonly rebuild: boolean;
  /** A persisted projection that may replace the initial fit when it matches the export. */
  readonly cached?: ProjectionArtifact;
}

/** Why a projection or comparison request could not be served. */
export type ProjectionErrorCode =
  "invalid-request" | "unknown-note" | "projection-failed";

/** A failed projection or comparison request, classified for the HTTP boundary. */
export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;

  constructor(
    code: ProjectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectionError";
    this.code = code;
  }
}

/**
 * A digest of the exact stored vector values, used to detect new or changed vectors without
 * keeping a second copy of the collection. Values are hashed in a fixed byte order, so the
 * identity does not depend on the platform's native endianness.
 */
export const vectorIdentity = (vector: readonly number[]): string => {
  const bytes = new Uint8Array(vector.length * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  vector.forEach((component, index) => {
    view.setFloat64(index * Float64Array.BYTES_PER_ELEMENT, component, true);
  });
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
};

/** The canonical identity key of one set of export identities, in sorted lowercased ID order. */
const identityKey = (identities: readonly ProjectionInputIdentity[]): string =>
  identities.map(({ id, vectorId }) => `${id}\u0000${vectorId}`).join("\u0001");

/** Order values by their lowercased ID so an identity does not depend on the export's page order. */
const canonicalOrder = <Value extends { readonly id: string }>(
  values: readonly Value[],
): Value[] =>
  [...values].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

/**
 * The projection identity. It identifies the fitted transform and its parameters, so transforming
 * a new vector keeps it, while a full fit or a layout change produces a new one.
 */
const projectionIdentity = (
  embeddingSpaceId: string,
  layout: ProjectionArtifact["layout"],
  fitInputs: readonly ProjectionInputIdentity[],
): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        embeddingSpaceId,
        layout,
        algorithm: projectionAlgorithm,
        parameters: projectionParameters,
        inputs: fitInputs,
      }),
    )
    .digest("hex")}`;

/** A small deterministic PRNG, so a fit with the recorded seed is reproducible. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Cosine distance in the original stored-vector space; lower means closer. */
const cosineDistance = (
  left: readonly number[],
  right: readonly number[],
): number => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = left[index] ?? 0;
    const rightComponent = right[index] ?? 0;
    dot += leftComponent * rightComponent;
    leftNorm += leftComponent * leftComponent;
    rightNorm += rightComponent * rightComponent;
  }
  const norm = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return norm === 0 ? 0 : 1 - dot / norm;
};

/** Cosine similarity of two original stored vectors: the host's explicit comparison, not a score. */
export const cosineSimilarity = (
  left: readonly number[],
  right: readonly number[],
): number => 1 - cosineDistance(left, right);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Fit the pinned UMAP model over one export; the fitted anchors must not move afterwards. */
export const fitProjectionModel = (vectors: readonly number[][]): UMAP => {
  const model = new UMAP({
    nComponents: projectionParameters.nComponents,
    nNeighbors: projectionParameters.nNeighbors,
    minDist: projectionParameters.minDist,
    random: mulberry32(projectionParameters.seed),
    distanceFn: cosineDistance,
  });
  model.fit([...vectors]);
  return model;
};

/**
 * Place one vector through a fitted model. umap-js 1.4.0 moves its training coordinates when a
 * transform batch is exactly as long as the training set, so vectors are placed one call at a
 * time: a single-vector batch of a model fitted over `minProjectedNotes` or more points can never
 * match the training length, and the fitted coordinate system stays fixed for any batch size. A
 * vector the library cannot place (its neighbors are all at zero distance, as for repeated
 * equivalent memories) yields no usable coordinate instead of a position.
 */
export const placeVector = (
  model: UMAP,
  vector: number[],
): { readonly x: number; readonly y: number } | undefined => {
  const [x, y] = model.transform([vector])[0] ?? [];
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    return undefined;
  }
  return { x, y };
};

/** The exported vectors as canonical, validated projection input: unique sorted lowercased IDs. */
const canonicalInputs = (
  inputs: readonly ProjectionInput[],
): ReadonlyArray<{ readonly id: string; readonly vector: number[] }> => {
  const dimensions = inputs[0]?.vector.length ?? 0;
  const seen = new Set<string>();
  const canonical = inputs.map((input) => {
    const id = input.id.toLowerCase();
    if (seen.has(id)) {
      throw new ProjectionError(
        "invalid-request",
        "An inspection export must not contain one note ID twice.",
      );
    }
    seen.add(id);
    if (
      input.vector.length !== dimensions ||
      !input.vector.every((component) => isFiniteNumber(component))
    ) {
      throw new ProjectionError(
        "invalid-request",
        "Every exported vector must hold the same number of finite values.",
      );
    }
    return { id, vector: [...input.vector] };
  });
  return canonicalOrder(canonical);
};

const identityOf = (input: {
  readonly id: string;
  readonly vector: readonly number[];
}): ProjectionInputIdentity => ({
  id: input.id,
  vectorId: vectorIdentity(input.vector),
});

/** A deterministic ring, used only while there are too few notes to fit a projection. */
const ringCoordinates = (
  inputs: readonly { readonly id: string }[],
  identities: readonly ProjectionInputIdentity[],
): Map<string, ProjectionPoint> =>
  new Map(
    inputs.map((input, index) => {
      const identity = identities[index];
      const angle = (2 * Math.PI * index) / Math.max(inputs.length, 1);
      return [
        input.id,
        {
          id: input.id,
          x: Math.cos(angle),
          y: Math.sin(angle),
          vectorId: identity?.vectorId ?? "",
        },
      ];
    }),
  );

/** Current coordinates for every exported note, in the export's canonical order. */
const toCoordinates = (
  inputs: readonly { readonly id: string }[],
  identities: readonly ProjectionInputIdentity[],
  positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
): ProjectionPoint[] =>
  inputs.map((input, index) => {
    const identity = identities[index];
    const position = positions.get(input.id);
    if (identity === undefined || position === undefined) {
      throw new ProjectionError(
        "projection-failed",
        "The projection did not produce coordinates for every exported note.",
      );
    }
    return {
      id: input.id,
      x: position.x,
      y: position.y,
      vectorId: identity.vectorId,
    };
  });

interface ProjectionCandidate {
  readonly artifact: ProjectionArtifact;
  readonly model: UMAP | undefined;
  readonly coordinates: Map<string, ProjectionPoint>;
  readonly vectors: Map<string, readonly number[]>;
}

/**
 * The disposable projection state of one host process: the vectors of the latest completed
 * export, the fitted model, the coordinates and the recorded artifact. A failed request never
 * commits a partial state, and a request for another collection or embedding space discards the
 * state instead of projecting through the previous identity's fitted model.
 */
export class ProjectionState {
  #vectors = new Map<string, readonly number[]>();
  #coordinates = new Map<string, ProjectionPoint>();
  // Anchors belong to the fitted model, not the latest export. Keep them through removals and
  // replace them only with the model; this stays bounded by the training set, not refresh history.
  #anchors: {
    id: string;
    vector: readonly number[];
    position: ProjectionPoint;
  }[] = [];
  #model: UMAP | undefined;
  #artifact: ProjectionArtifact | undefined;

  /**
   * Project a complete export. An unchanged export reuses the stored coordinates, new or changed
   * vectors are transformed through the fitted model, and an explicit rebuild or a missing fitted
   * model fits fresh (or reuses a matching persisted projection at startup).
   */
  project(request: ProjectionRequest): ProjectionArtifact {
    const inputs = canonicalInputs(request.inputs);
    const identities = inputs.map(identityOf);
    const key = identityKey(identities);

    // A reconfigured service is another collection or embedding space: an artifact, model or
    // coordinate set fitted for the previous identity is never reused or transformed.
    this.#alignToIdentity(request);
    if (
      !request.rebuild &&
      this.#artifact !== undefined &&
      key === this.#key()
    ) {
      return this.#artifact;
    }
    if (!request.rebuild && this.#model !== undefined) {
      return this.#transform(inputs, identities);
    }
    if (!request.rebuild) {
      const cached = this.#matchingCache(request, key);
      if (cached !== undefined) {
        return this.#adopt(cached, inputs, identities);
      }
    }
    return this.#fit(request, inputs, identities);
  }

  /** Drop live state that belongs to another collection or embedding space than the request. */
  #alignToIdentity(request: ProjectionRequest): void {
    const artifact = this.#artifact;
    if (
      artifact === undefined ||
      (artifact.collection === request.collection &&
        artifact.embeddingSpaceId === request.embeddingSpaceId)
    ) {
      return;
    }
    this.#vectors = new Map();
    this.#coordinates = new Map();
    this.#anchors = [];
    this.#model = undefined;
    this.#artifact = undefined;
  }

  /** Cosine similarity of two stored vectors of the latest completed export. */
  compare(leftId: string, rightId: string): number {
    const left = this.#vectors.get(leftId.toLowerCase());
    const right = this.#vectors.get(rightId.toLowerCase());
    if (left === undefined || right === undefined) {
      throw new ProjectionError(
        "unknown-note",
        "The latest completed graph view does not hold a vector for that note.",
      );
    }
    return cosineSimilarity(left, right);
  }

  /** The identity key of the coordinates currently committed. */
  #key(): string {
    return identityKey(
      canonicalOrder(
        [...this.#coordinates.values()].map(({ id, vectorId }) => ({
          id: id.toLowerCase(),
          vectorId,
        })),
      ),
    );
  }

  /**
   * A persisted projection is reusable only when it belongs to this collection and embedding
   * space, was built by the pinned algorithm and parameters, is internally consistent and covers
   * exactly the current export.
   */
  #matchingCache(
    request: ProjectionRequest,
    key: string,
  ): ProjectionArtifact | undefined {
    const cached = request.cached;
    if (
      cached === undefined ||
      cached.collection !== request.collection ||
      cached.embeddingSpaceId !== request.embeddingSpaceId ||
      cached.algorithm.name !== projectionAlgorithm.name ||
      cached.algorithm.version !== projectionAlgorithm.version ||
      cached.parameters.metric !== projectionParameters.metric ||
      cached.parameters.nComponents !== projectionParameters.nComponents ||
      cached.parameters.nNeighbors !== projectionParameters.nNeighbors ||
      cached.parameters.minDist !== projectionParameters.minDist ||
      cached.parameters.seed !== projectionParameters.seed ||
      cached.projectionId !==
        projectionIdentity(
          request.embeddingSpaceId,
          cached.layout,
          cached.fitInputs,
        )
    ) {
      return undefined;
    }
    const cachedKey = identityKey(
      canonicalOrder(
        cached.coordinates.map(({ id, vectorId }) => ({
          id: id.toLowerCase(),
          vectorId,
        })),
      ),
    );
    return cachedKey === key ? cached : undefined;
  }

  /** Reuse a matching persisted projection instead of fitting the same export again. */
  #adopt(
    cached: ProjectionArtifact,
    inputs: readonly { readonly id: string; readonly vector: number[] }[],
    identities: readonly ProjectionInputIdentity[],
  ): ProjectionArtifact {
    const positions = new Map(
      cached.coordinates.map(({ id, x, y }) => [id.toLowerCase(), { x, y }]),
    );
    const coordinates = new Map(
      toCoordinates(inputs, identities, positions).map((point) => [
        point.id,
        point,
      ]),
    );
    return this.#commit({
      artifact: { ...cached, coordinates: [...coordinates.values()] },
      model: undefined,
      coordinates,
      vectors: new Map(inputs.map((input) => [input.id, input.vector])),
    });
  }

  /**
   * Place new or changed vectors through the fitted model, keeping every other coordinate. An
   * export without any new or changed vector, such as a refresh that only removes notes, commits
   * the surviving coordinates and vectors and keeps the fitted model instead of transforming an
   * empty batch.
   */
  #transform(
    inputs: readonly { readonly id: string; readonly vector: number[] }[],
    identities: readonly ProjectionInputIdentity[],
  ): ProjectionArtifact {
    const artifact = this.#artifact;
    const model = this.#model;
    if (artifact === undefined || model === undefined) {
      throw new ProjectionError(
        "projection-failed",
        "The fitted projection is not available.",
      );
    }
    const positions = new Map<string, { x: number; y: number }>();
    const toPlace: { readonly id: string; readonly vector: number[] }[] = [];
    inputs.forEach((input, index) => {
      const identity = identities[index];
      const existing = this.#coordinates.get(input.id);
      if (
        identity !== undefined &&
        existing !== undefined &&
        existing.vectorId === identity.vectorId
      ) {
        positions.set(input.id, { x: existing.x, y: existing.y });
        return;
      }
      toPlace.push({ id: input.id, vector: input.vector });
    });
    for (const { id, vector } of toPlace) {
      positions.set(
        id,
        placeVector(model, vector) ?? this.#nearestPosition(vector),
      );
    }
    const coordinates = new Map(
      toCoordinates(inputs, identities, positions).map((point) => [
        point.id,
        point,
      ]),
    );
    return this.#commit({
      artifact: { ...artifact, coordinates: [...coordinates.values()] },
      model,
      coordinates,
      vectors: new Map(inputs.map((input) => [input.id, input.vector])),
    });
  }

  /**
   * The fitted anchor closest to `vector` in original space. umap-js
   * cannot place a query whose neighbors are all at zero cosine distance, which is exactly the
   * case for a memory that repeats an equivalent stored vector; such a vector shares the position
   * of its nearest fitted anchor even after every displayed note disappears, and the coordinate
   * system stays untouched.
   */
  #nearestPosition(vector: readonly number[]): {
    readonly x: number;
    readonly y: number;
  } {
    let nearestId: string | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let nearestPosition: { readonly x: number; readonly y: number } | undefined;
    for (const { id, vector: stored, position } of this.#anchors) {
      const distance = cosineDistance(vector, stored);
      if (
        nearestId === undefined ||
        distance < nearestDistance ||
        (distance === nearestDistance && id < nearestId)
      ) {
        nearestId = id;
        nearestDistance = distance;
        nearestPosition = { x: position.x, y: position.y };
      }
    }
    if (nearestPosition === undefined) {
      throw new ProjectionError(
        "projection-failed",
        "The fitted projection holds no anchor to place the changed vector from.",
      );
    }
    return nearestPosition;
  }

  /** Fit a fresh projection, or fall back to the labeled ring while the export is too small. */
  #fit(
    request: ProjectionRequest,
    inputs: readonly { readonly id: string; readonly vector: number[] }[],
    identities: readonly ProjectionInputIdentity[],
  ): ProjectionArtifact {
    let coordinates: Map<string, ProjectionPoint>;
    let model: UMAP | undefined;
    let layout: ProjectionArtifact["layout"];
    if (inputs.length < minProjectedNotes) {
      layout = "non-semantic";
      coordinates = ringCoordinates(inputs, identities);
    } else {
      layout = "umap";
      const fittedVectors = inputs.map(({ vector }) => vector);
      let fitted: UMAP;
      let embedding: number[][];
      try {
        fitted = fitProjectionModel(fittedVectors);
        embedding = fitted.getEmbedding();
      } catch (cause) {
        throw new ProjectionError(
          "projection-failed",
          "The projection fit failed.",
          {
            cause,
          },
        );
      }
      coordinates = new Map();
      inputs.forEach((input, index) => {
        const point = embedding[index];
        const identity = identities[index];
        if (
          point === undefined ||
          identity === undefined ||
          !isFiniteNumber(point[0]) ||
          !isFiniteNumber(point[1])
        ) {
          throw new ProjectionError(
            "projection-failed",
            "The projection fit returned an unusable coordinate.",
          );
        }
        coordinates.set(input.id, {
          id: input.id,
          x: point[0],
          y: point[1],
          vectorId: identity.vectorId,
        });
      });
      model = fitted;
    }
    const artifact: ProjectionArtifact = {
      schemaVersion: 1,
      collection: request.collection,
      embeddingSpaceId: request.embeddingSpaceId,
      layout,
      projectionId: projectionIdentity(
        request.embeddingSpaceId,
        layout,
        identities,
      ),
      algorithm: { ...projectionAlgorithm },
      parameters: { ...projectionParameters },
      builtAt: new Date().toISOString(),
      fitInputs: [...identities],
      coordinates: [...coordinates.values()],
    };
    return this.#commit({
      artifact,
      model,
      coordinates,
      vectors: new Map(inputs.map((input) => [input.id, input.vector])),
    });
  }

  /** Commit a completed projection; only a successful candidate reaches this point. */
  #commit(candidate: ProjectionCandidate): ProjectionArtifact {
    if (candidate.model !== this.#model) {
      this.#anchors =
        candidate.model === undefined
          ? []
          : [...candidate.vectors].map(([id, vector]) => ({
              id,
              vector,
              position: candidate.coordinates.get(id)!,
            }));
    }
    this.#vectors = candidate.vectors;
    this.#coordinates = candidate.coordinates;
    this.#model = candidate.model;
    this.#artifact = candidate.artifact;
    return candidate.artifact;
  }
}
