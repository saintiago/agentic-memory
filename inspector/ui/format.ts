/**
 * Small formatting helpers of the inspection dashboard. Every value the UI displays is rendered
 * as text, so these functions never produce markup.
 *
 * See docs/dashboard.md#visual-behavior.
 */

/** Format a capture, request or update timestamp for display, keeping the exact value. */
export const formatTimestamp = (value: string | undefined): string =>
  value === undefined ? "unknown" : value;

/** Format a duration in milliseconds for the responsiveness and status lines. */
export const formatDuration = (durationMs: number): string =>
  durationMs < 1_000
    ? `${String(Math.round(durationMs))} ms`
    : `${(durationMs / 1_000).toFixed(2)} s`;

/** Format a count with thousands separators. */
export const formatCount = (value: number): string =>
  new Intl.NumberFormat("en-US").format(value);

/** Format a retrieval score without inventing precision the host did not measure. */
export const formatScore = (score: number): string => score.toFixed(4);

/**
 * Apply an alpha channel to a `#rrggbb` color so a dimmed node keeps its freshness hue. Colors
 * of any other notation are returned unchanged, which keeps the palette the single source of the
 * displayed hues.
 */
export const withAlpha = (color: string, alpha: number): string => {
  const match =
    /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/iu.exec(
      color,
    );
  const red = match?.groups?.red;
  const green = match?.groups?.green;
  const blue = match?.groups?.blue;
  if (red === undefined || green === undefined || blue === undefined) {
    return color;
  }
  return `rgba(${String(Number.parseInt(red, 16))}, ${String(
    Number.parseInt(green, 16),
  )}, ${String(Number.parseInt(blue, 16))}, ${String(alpha)})`;
};
