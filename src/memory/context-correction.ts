/**
 * The reviewed context-correction contract exchanged between Memory and a maintenance owner. A
 * proposal carries one complete inspected note and the operator's replacement semantic attributes;
 * preparation reads the current note, rejects a stale proposal and returns the current note or a
 * one-record plan the existing application path writes unchanged.
 *
 * See docs/memory.md#existing-context-correction.
 */
import { z } from "zod";

import {
  attributesSchema,
  noteSchema,
  type Note,
} from "../note-store/index.js";
import type { InsertionPlan } from "./insertion-plan.js";

/**
 * One complete inspected note and the reviewed replacement attributes for its semantic fields.
 * Both values are validated and detached through the owning NoteStore schemas.
 */
export const contextCorrectionInputSchema = z.strictObject({
  expected: noteSchema,
  attributes: attributesSchema,
});

export type ContextCorrectionInput = z.infer<
  typeof contextCorrectionInputSchema
>;

/**
 * The current note and, only for a real change, the one-record version-1 plan that applies the
 * reviewed replacement. A no-op preparation omits the plan.
 */
export interface ContextCorrectionPreparation {
  readonly note: Note;
  readonly plan?: InsertionPlan;
}

/** The focused read-only correction capability a maintenance owner supplies to the queue. */
export interface ContextCorrectionPreparer {
  prepareContextCorrection(
    input: ContextCorrectionInput,
  ): Promise<ContextCorrectionPreparation>;
}
