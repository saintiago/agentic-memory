/**
 * Test fixture: this import is exactly what the boundaries check must reject. It reaches into a
 * component's internal module instead of its public `index.ts`.
 */
import { noteSchema } from "../../../src/note-store/note-record.js";

export const fixtureUsesPrivateModule = noteSchema;
