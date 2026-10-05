/**
 * The Qdrant snapshot operations a baseline needs: create and download one consistent collection
 * snapshot, remove the server-side copy, and restore a snapshot into an isolated collection. They
 * use the documented HTTP API with the same URL rules as the evaluation environment, so a request
 * never carries credentials in its URL and a failure names the operation, not private data.
 *
 * See docs/evaluation.md#quality-maintenance-procedure and docs/note-store.md.
 */
import { z } from "zod";

/** One Qdrant endpoint with an optional credential and request timeout. */
export interface QdrantTarget {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
}

/** A failed snapshot or collection operation. */
export class QdrantSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QdrantSnapshotError";
  }
}

const targetSchema = z.strictObject({
  url: z.string().refine((value) => {
    if (!URL.canParse(value)) {
      return false;
    }
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port !== "0" &&
      !/[?#]/.test(value)
    );
  }, "The Qdrant URL must be an http(s) URL with a nonzero port and no credentials, query or fragment."),
  apiKey: z.string().min(1).optional(),
  timeoutMs: z.int().positive().optional(),
});

const baseOf = (target: QdrantTarget): string => {
  const parsed = targetSchema.safeParse(target);
  if (!parsed.success) {
    throw new QdrantSnapshotError(
      parsed.error.issues.map((issue) => issue.message).join(" "),
    );
  }
  return parsed.data.url.replace(/\/+$/, "");
};

const request = async (
  target: QdrantTarget,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: string | FormData,
): Promise<Response> => {
  const base = baseOf(target);
  const headers: Record<string, string> = {};
  if (target.apiKey !== undefined) {
    headers["api-key"] = target.apiKey;
  }
  if (body !== undefined && typeof body === "string") {
    headers["content-type"] = "application/json";
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(target.timeoutMs ?? 120_000),
    });
  } catch (cause) {
    throw new QdrantSnapshotError(
      `The Qdrant request ${method} ${path} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  return response;
};

const failureText = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => "");
  return text === ""
    ? `HTTP ${String(response.status)}`
    : `HTTP ${String(response.status)}: ${text}`;
};

const readResult = async <Value>(
  response: Response,
  schema: z.ZodType<Value>,
  operation: string,
  options: { allowNotFound?: boolean } = {},
): Promise<Value | undefined> => {
  if (options.allowNotFound === true && response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new QdrantSnapshotError(
      `The Qdrant ${operation} failed with ${await failureText(response)}`,
    );
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new QdrantSnapshotError(
      `The Qdrant ${operation} returned a body that is not JSON.`,
    );
  }
  const envelope = z.object({ result: z.unknown() }).safeParse(payload);
  if (!envelope.success) {
    throw new QdrantSnapshotError(
      `The Qdrant ${operation} returned an unexpected body.`,
    );
  }
  const parsed = schema.safeParse(envelope.data.result);
  if (!parsed.success) {
    throw new QdrantSnapshotError(
      `The Qdrant ${operation} result does not satisfy the documented shape.`,
    );
  }
  return parsed.data;
};

const snapshotInfoSchema = z.object({
  name: z.string().min(1),
  creation_time: z.string().optional(),
  size: z.int().nonnegative().optional(),
  checksum: z.string().min(1).optional(),
});

/** The identity and provider-reported integrity of one created collection snapshot. */
export type SnapshotInfo = z.infer<typeof snapshotInfoSchema>;

const collectionInfoSchema = z.object({
  status: z.string().optional(),
  points_count: z.int().nonnegative().nullable().optional(),
  indexed_vectors_count: z.int().nonnegative().nullable().optional(),
  config: z.unknown().optional(),
  metadata: z.unknown().optional(),
});

/** The parts of one collection description a baseline records. */
export type CollectionInfo = z.infer<typeof collectionInfoSchema>;

/** Create one full snapshot of the collection and return its provider-reported identity. */
export const createCollectionSnapshot = async (
  target: QdrantTarget,
  collection: string,
): Promise<SnapshotInfo> => {
  const response = await request(
    target,
    "POST",
    `/collections/${encodeURIComponent(collection)}/snapshots?wait=true`,
  );
  const info = await readResult(
    response,
    snapshotInfoSchema,
    "snapshot creation",
  );
  if (info === undefined) {
    throw new QdrantSnapshotError(
      "The Qdrant snapshot creation returned no snapshot identity.",
    );
  }
  return info;
};

/** Download one collection snapshot's bytes. */
export const downloadCollectionSnapshot = async (
  target: QdrantTarget,
  collection: string,
  snapshotName: string,
): Promise<Uint8Array> => {
  const response = await request(
    target,
    "GET",
    `/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshotName)}`,
  );
  if (!response.ok) {
    throw new QdrantSnapshotError(
      `The Qdrant snapshot download failed with ${await failureText(response)}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
};

/** Remove the server-side snapshot after its bytes are safely retained; a missing file is fine. */
export const deleteCollectionSnapshot = async (
  target: QdrantTarget,
  collection: string,
  snapshotName: string,
): Promise<void> => {
  const response = await request(
    target,
    "DELETE",
    `/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshotName)}`,
  );
  await readResult(response, z.unknown(), "snapshot deletion", {
    allowNotFound: true,
  });
};

/** Restore one full snapshot into a fresh isolated collection. */
export const restoreCollectionSnapshot = async (
  target: QdrantTarget,
  collection: string,
  bytes: Uint8Array,
): Promise<void> => {
  const form = new FormData();
  form.append(
    "snapshot",
    new Blob([bytes], { type: "application/octet-stream" }),
    "snapshot",
  );
  const response = await request(
    target,
    "POST",
    `/collections/${encodeURIComponent(collection)}/snapshots/upload?priority=snapshot&wait=true`,
    form,
  );
  await readResult(response, z.unknown(), "snapshot restore");
};

/** Read one collection's point count, configuration and metadata; `undefined` when it is absent. */
export const collectionInfo = async (
  target: QdrantTarget,
  collection: string,
): Promise<CollectionInfo | undefined> => {
  const response = await request(
    target,
    "GET",
    `/collections/${encodeURIComponent(collection)}`,
  );
  const info = await readResult(
    response,
    collectionInfoSchema,
    "collection lookup",
    { allowNotFound: true },
  );
  return info === undefined
    ? undefined
    : { ...info, metadata: metadataOf(info) };
};

/**
 * Qdrant reports collection metadata under `config.metadata`; a top-level `metadata` field is not
 * part of the documented collection description, but reading it first keeps older recordings
 * usable. The result is `null` when the collection declares no metadata.
 */
const metadataOf = (info: CollectionInfo): unknown => {
  if (info.metadata !== undefined && info.metadata !== null) {
    return info.metadata;
  }
  if (
    typeof info.config === "object" &&
    info.config !== null &&
    !Array.isArray(info.config)
  ) {
    const metadata = (info.config as { metadata?: unknown }).metadata;
    return metadata ?? null;
  }
  return null;
};

/** Remove one isolated collection; a missing collection is already removed. */
export const deleteCollection = async (
  target: QdrantTarget,
  collection: string,
): Promise<void> => {
  const response = await request(
    target,
    "DELETE",
    `/collections/${encodeURIComponent(collection)}`,
  );
  await readResult(response, z.unknown(), "collection deletion", {
    allowNotFound: true,
  });
};
