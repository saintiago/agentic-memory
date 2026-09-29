/**
 * Opaque URL-safe pagination cursors of the `/v1` API. A cursor preserves the underlying
 * NoteStore value — a string or a number — exactly, so clients only need to hand the token back
 * unchanged. Encoding belongs to the service; the store's own cursor semantics stay untouched.
 *
 * See docs/service.md#api.
 */
import { cursorSchema, type Cursor } from "../src/index.js";

/** A cursor token is base64url without padding, so it needs no query escaping. */
const tokenPattern = /^[A-Za-z0-9_-]+$/;

/** Encode one store cursor as an opaque URL-safe token. */
export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

/** A cursor token that does not carry a store cursor this API could have issued. */
export class InvalidCursorError extends Error {
  constructor() {
    super("The cursor is not a valid pagination token.");
    this.name = "InvalidCursorError";
  }
}

/** Decode one opaque token back into the exact store cursor it was issued for. */
export const decodeCursor = (token: string): Cursor => {
  if (!tokenPattern.test(token)) {
    throw new InvalidCursorError();
  }
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = cursorSchema.safeParse(value);
  // Re-encoding must reproduce the token, so trailing bytes cannot smuggle another value.
  if (!parsed.success || encodeCursor(parsed.data) !== token) {
    throw new InvalidCursorError();
  }
  return parsed.data;
};
