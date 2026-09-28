/**
 * Disposable projection artifacts of the inspection host: the recorded projection identity,
 * parameters, input identities and coordinates under the configured artifact directory. The
 * artifact never holds stored vectors, and an artifact that belongs to another collection or
 * embedding space is discarded instead of being presented as current.
 *
 * See docs/dashboard.md#vector-projection-and-proximity.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  projectionArtifactSchema,
  type ProjectionArtifact,
} from "./projection.js";

/** The identity an artifact must carry to belong to the configured collection. */
export interface ProjectionArtifactIdentity {
  readonly collection: string;
  readonly embeddingSpaceId: string;
}

/** Disposable coordinate cache of one configured collection and embedding space. */
export interface ProjectionArtifactStore {
  /** The applicable artifact, or undefined when none exists or the stored one is incompatible. */
  load(
    identity: ProjectionArtifactIdentity,
  ): Promise<ProjectionArtifact | undefined>;
  /** Replace the stored artifact; callers await it but it is never runtime persistence. */
  save(artifact: ProjectionArtifact): Promise<void>;
}

const artifactFile = "projection.json";

/** Read one file, or undefined when it does not exist. */
const readOptionalFile = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw cause;
  }
};

/** Remove a stored artifact that cannot describe the configured collection. */
const discard = async (file: string, reason: string): Promise<void> => {
  console.warn(
    `[inspector] discarding the stored projection artifact: ${reason}`,
  );
  await rm(file, { force: true });
};

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * A file-backed artifact store. Loading rejects nothing: a missing, malformed or foreign artifact
 * yields no cached coordinates, so the host fits a fresh projection from a complete export.
 */
export const createProjectionArtifactStore = (
  directory: string,
): ProjectionArtifactStore => {
  const file = path.join(directory, artifactFile);
  return {
    async load(identity) {
      const text = await readOptionalFile(file);
      if (text === undefined) {
        return undefined;
      }
      let parsed: ProjectionArtifact;
      try {
        const result = projectionArtifactSchema.safeParse(JSON.parse(text));
        if (!result.success) {
          await discard(
            file,
            `it is not a supported projection artifact (${result.error.issues
              .map((issue) => issue.message)
              .join("; ")})`,
          );
          return undefined;
        }
        parsed = result.data;
      } catch (cause) {
        await discard(file, `it is not valid JSON (${describeCause(cause)})`);
        return undefined;
      }
      if (
        parsed.collection !== identity.collection ||
        parsed.embeddingSpaceId !== identity.embeddingSpaceId
      ) {
        await discard(
          file,
          `it belongs to collection "${parsed.collection}" in embedding space ` +
            `"${parsed.embeddingSpaceId}", not "${identity.collection}" in ` +
            `"${identity.embeddingSpaceId}"`,
        );
        return undefined;
      }
      return parsed;
    },

    async save(artifact) {
      await mkdir(directory, { recursive: true });
      const temporary = `${file}.${String(process.pid)}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify(artifact, null, 2)}\n`,
        "utf8",
      );
      await rename(temporary, file);
    },
  };
};
