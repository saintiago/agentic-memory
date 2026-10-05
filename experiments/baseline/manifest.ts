/**
 * The baseline capture manifest: what the retained journal copy and collection snapshot are, which
 * provider and prompt settings were in force, which declared queries were fixed beforehand and
 * which receipt inventory the copy holds. The manifest is evidence, not runtime metadata.
 *
 * See docs/evaluation.md#quality-maintenance-procedure.
 */
import { z } from "zod";

import { queueBindingSchema } from "../../src/index.js";
import type { ManifestModel } from "../replay/artifacts.js";

const instant = (description: string) =>
  z.iso.datetime({
    offset: true,
    message: `${description} must be an ISO 8601 instant.`,
  });

/** Receipt outcome counts, one key per status the queue contract exports today. */
const statusCounts = z.strictObject({
  queued: z.int().nonnegative(),
  processing: z.int().nonnegative(),
  retrying: z.int().nonnegative(),
  stored: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  blocked: z.int().nonnegative(),
});

/** One retained baseline capture. */
export const baselineManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  capturedAt: instant("The capture time"),
  revision: z.string().min(1, "A revision must be nonempty."),
  journal: z.strictObject({
    file: z.string().min(1),
    sha256: z.string().min(1),
    bytes: z.int().nonnegative(),
    schemaVersion: z.string().min(1),
    representation: z.string().min(1),
    latestSequence: z.int().nonnegative(),
    binding: queueBindingSchema,
  }),
  collection: z.strictObject({
    name: z.string().min(1),
    snapshotFile: z.string().min(1),
    sha256: z.string().min(1),
    bytes: z.int().nonnegative(),
    providerChecksum: z.string().min(1).optional(),
    pointsCount: z.int().nonnegative().nullable(),
    metadata: z.unknown().nullable(),
  }),
  /** True when no receipt state changed while the snapshot was taken. */
  quiescent: z.boolean(),
  receipts: z.strictObject({
    file: z.string().min(1),
    sha256: z.string().min(1),
    bytes: z.int().nonnegative(),
    count: z.int().nonnegative(),
    counts: statusCounts,
    attempts: z.int().nonnegative(),
  }),
  declaredQueries: z.strictObject({
    file: z.string().min(1),
    sha256: z.string().min(1),
    count: z.int().nonnegative(),
  }),
  prompts: z.strictObject({
    construction: z.string().min(1),
    evolution: z.string().min(1),
  }),
  model: z.strictObject({
    endpoint: z.string().min(1).nullable(),
    id: z.string().min(1),
    thinking: z.enum(["disabled-external", "enabled-external", "unspecified"]),
    maxOutputTokens: z.int().positive().nullable(),
    timeoutMs: z.int().positive().nullable(),
    retries: z.int().nonnegative(),
  }),
  encoder: z.unknown(),
  service: z.unknown().nullable(),
  limits: z.array(z.string().min(1)),
});

export type BaselineManifest = z.infer<typeof baselineManifestSchema>;

/** The prompt and model settings one capture records; supplied by the operator, never discovered. */
export interface CapturedSettings {
  prompts: { construction: string; evolution: string };
  model: ManifestModel;
  encoder: unknown;
  service: unknown | null;
}
