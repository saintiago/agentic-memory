/**
 * Validation and interpretation of model responses. Memory owns these schemas: the transport
 * returns untrusted JSON and a structurally valid response may still be rejected when it
 * references anything outside the supplied candidate set.
 *
 * See docs/prompts.md#validation and docs/memory.md#insertion-decisions.
 */
import { z } from "zod";

import {
  attributesSchema,
  noteIdSchema,
  type Attributes,
} from "../note-store/index.js";
import type { ModelRequest } from "../language-model/index.js";

/**
 * A construction response is exactly the semantic attributes of a new note, so it reuses the
 * NoteStore attribute contract. Missing or extra fields, nulls, non-string elements and coerced
 * values are rejected; empty keyword and tag arrays stay structurally valid.
 */
export const constructionResponseSchema: z.ZodType<Attributes> =
  attributesSchema;

export type ConstructionResponse = z.infer<typeof constructionResponseSchema>;

/** One proposed neighbor revision: exactly the candidate ID and its complete attributes. */
export const evolutionUpdateSchema = z.strictObject({
  id: noteIdSchema,
  ...attributesSchema.shape,
});

export type EvolutionUpdate = z.infer<typeof evolutionUpdateSchema>;

/**
 * An evolution response: links from the incoming note to supplied candidates, the incoming note's
 * complete tag list and the complete attributes of each changed candidate. Extra fields are
 * rejected instead of being accepted as an attempt to change source content, links or metadata.
 */
export const evolutionResponseSchema = z.strictObject({
  links: z.array(noteIdSchema),
  newTags: attributesSchema.shape.tags,
  updates: z.array(evolutionUpdateSchema),
});

export type EvolutionResponse = z.infer<typeof evolutionResponseSchema>;

/** Raised when a model response does not satisfy the documented prompt contract. */
export class ModelResponseError extends Error {
  readonly stage: ModelRequest["stage"];

  constructor(stage: ModelRequest["stage"], reason: string) {
    super(
      `The ${stage} response does not satisfy the documented contract: ${reason}.`,
    );
    this.name = "ModelResponseError";
    this.stage = stage;
  }
}

/** One message per issue, in path order; shared with input validation in this component. */
export const issueSummary = (
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): string =>
  issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join(".")}: ${issue.message}`,
    )
    .join("; ");

/** Validate a construction response and return its detached attributes. */
export const readConstructionResponse = (
  response: unknown,
): ConstructionResponse => {
  const parsed = constructionResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new ModelResponseError(
      "construct",
      issueSummary(parsed.error.issues),
    );
  }
  return parsed.data;
};

/**
 * Validate an evolution response against the supplied candidate IDs and return the accepted
 * decision: links deduplicated in first occurrence order and every reference replaced by the
 * supplied candidate's own ID, so stored links agree with stored identities. Note IDs are UUIDs,
 * compared case-insensitively like NoteStore does.
 *
 * The entire response is validated before anything is returned, so a malformed entry never permits
 * a partial application of its siblings.
 */
export const readEvolutionResponse = (
  response: unknown,
  candidateIds: readonly string[],
): EvolutionResponse => {
  const parsed = evolutionResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new ModelResponseError("evolve", issueSummary(parsed.error.issues));
  }

  const candidates = new Map<string, string>();
  for (const id of candidateIds) {
    candidates.set(id.toLowerCase(), id);
  }

  const issues: string[] = [];
  const links: string[] = [];
  const seenLinks = new Set<string>();
  parsed.data.links.forEach((link, index) => {
    const candidate = candidates.get(link.toLowerCase());
    if (candidate === undefined) {
      issues.push(`links[${index}]: ${link} is not a supplied candidate ID`);
      return;
    }
    if (!seenLinks.has(candidate.toLowerCase())) {
      seenLinks.add(candidate.toLowerCase());
      links.push(candidate);
    }
  });

  const updates: EvolutionUpdate[] = [];
  const seenUpdates = new Set<string>();
  parsed.data.updates.forEach((update, index) => {
    const candidate = candidates.get(update.id.toLowerCase());
    if (candidate === undefined) {
      issues.push(
        `updates[${index}].id: ${update.id} is not a supplied candidate ID`,
      );
      return;
    }
    if (seenUpdates.has(candidate.toLowerCase())) {
      issues.push(
        `updates[${index}].id: ${update.id} repeats an updated candidate ID`,
      );
      return;
    }
    seenUpdates.add(candidate.toLowerCase());
    updates.push({ ...update, id: candidate });
  });

  if (issues.length > 0) {
    throw new ModelResponseError("evolve", issues.join("; "));
  }
  return { links, newTags: parsed.data.newTags, updates };
};
