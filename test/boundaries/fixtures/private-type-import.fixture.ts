/**
 * Test fixture: a type-only import of a component's internal module. The boundaries check must
 * reject it as well, because dependency directions apply to types too.
 */
import type { Note } from "../../../src/note-store/note-record.js";

export type FixtureUsesPrivateType = Note;
