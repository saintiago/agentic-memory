/**
 * The reviewed link-correction contract exchanged between Memory and a maintenance owner. A
 * proposal carries one complete inspected source note and the distinct outgoing target identities
 * a review proved incorrect; preparation reads the current record together with its stored vector,
 * rejects a stale or unreadable proposal and returns a one-record plan the existing application
 * path writes unchanged.
 *
 * See docs/memory.md#existing-link-correction.
 */
import { z } from "zod";

import { noteIdSchema, noteSchema } from "../note-store/index.js";
import type { InsertionPlan } from "./insertion-plan.js";

/**
 * One complete inspected source note and the outgoing targets to remove. Targets are matched to
 * the inspected links by UUID identity; an empty removal set, a repeated target or a target that
 * is not an outgoing link of the inspected note is invalid rather than a silent no-op.
 */
export const linkCorrectionInputSchema = z
  .strictObject({
    expected: noteSchema,
    removeTargetIds: z.array(noteIdSchema),
  })
  .superRefine((input, context) => {
    if (input.removeTargetIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["removeTargetIds"],
        message: "A link correction must remove at least one outgoing target.",
      });
    }
    const links = new Set(
      input.expected.links.map((link) => link.toLowerCase()),
    );
    const seen = new Set<string>();
    input.removeTargetIds.forEach((target, index) => {
      const identity = target.toLowerCase();
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["removeTargetIds", index],
          message: "Removal targets must be distinct.",
        });
      }
      seen.add(identity);
      if (!links.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["removeTargetIds", index],
          message:
            "A removal target must be an outgoing link of the inspected note.",
        });
      }
    });
  });

export type LinkCorrectionInput = z.infer<typeof linkCorrectionInputSchema>;

/** The focused read-only link-correction capability a maintenance owner supplies to the queue. */
export interface LinkCorrectionPreparer {
  prepareLinkCorrection(input: LinkCorrectionInput): Promise<InsertionPlan>;
}
