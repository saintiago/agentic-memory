/**
 * Freshness of one displayed memory: a fixed, labeled sequential palette over the persisted
 * update time. The ranges and colors are fixed so two captures are comparable, and an unknown
 * update time keeps its own neutral color instead of borrowing the observation time.
 *
 * See docs/dashboard.md#visual-behavior.
 */

/** One fixed age range of the freshness palette. */
export interface FreshnessBand {
  readonly key: string;
  /** The labeled range the legend and the details panel show. */
  readonly label: string;
  /** Exclusive upper bound of the band in milliseconds; `null` marks the oldest band. */
  readonly upperBoundMs: number | null;
  readonly color: string;
}

/** The neutral color of a memory whose historical update time is unknown. */
export const unknownFreshnessColor = "#9aa4ad";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** The fixed age ranges, freshest first. */
export const freshnessBands: readonly FreshnessBand[] = [
  {
    key: "under-hour",
    label: "under 1 hour",
    upperBoundMs: hour,
    color: "#08306b",
  },
  {
    key: "under-day",
    label: "1–24 hours",
    upperBoundMs: day,
    color: "#2c6fb5",
  },
  {
    key: "under-week",
    label: "1–7 days",
    upperBoundMs: 7 * day,
    color: "#5b9bd5",
  },
  {
    key: "under-month",
    label: "7–30 days",
    upperBoundMs: 30 * day,
    color: "#9ecae1",
  },
  {
    key: "older",
    label: "30 days or older",
    upperBoundMs: null,
    color: "#cfe3f3",
  },
];

/** One resolved freshness classification of a displayed memory. */
export interface Freshness {
  /** The matched band, or `undefined` when the update time is unknown. */
  readonly band: FreshnessBand | undefined;
  readonly color: string;
  /** The labeled age range, or `unknown`. */
  readonly label: string;
  /** The exact persisted update time, when known. */
  readonly updatedAt: string | undefined;
  /** The age in milliseconds, clamped at zero for a clock skew into the future. */
  readonly ageMs: number | undefined;
  /** A short human age, or `unknown`. */
  readonly ageLabel: string;
}

/** Format an age in milliseconds as minutes, hours, days or months. */
export const formatAge = (ageMs: number): string => {
  const minutes = Math.floor(ageMs / minute);
  if (minutes < 1) {
    return "under a minute";
  }
  if (minutes < 60) {
    return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${String(days)} day${days === 1 ? "" : "s"}`;
  }
  const months = Math.floor(days / 30);
  return `${String(months)} month${months === 1 ? "" : "s"}`;
};

/** Classify one memory by its persisted update time at the supplied observation time. */
export const freshnessOf = (
  updatedAt: string | undefined,
  nowMs: number,
): Freshness => {
  const parsed = updatedAt === undefined ? Number.NaN : Date.parse(updatedAt);
  if (updatedAt === undefined || Number.isNaN(parsed)) {
    return {
      band: undefined,
      color: unknownFreshnessColor,
      label: "unknown",
      updatedAt: undefined,
      ageMs: undefined,
      ageLabel: "unknown",
    };
  }
  const ageMs = Math.max(0, nowMs - parsed);
  const band =
    freshnessBands.find(
      (candidate) =>
        candidate.upperBoundMs === null || ageMs < candidate.upperBoundMs,
    ) ?? freshnessBands[freshnessBands.length - 1];
  if (band === undefined) {
    throw new Error("The freshness palette must declare at least one band.");
  }
  return {
    band,
    color: band.color,
    label: band.label,
    updatedAt,
    ageMs,
    ageLabel: formatAge(ageMs),
  };
};

/** The legend rows of the palette, including the unknown-update neutral. */
export const freshnessLegend: ReadonlyArray<{
  readonly label: string;
  readonly color: string;
}> = [
  ...freshnessBands.map((band) => ({
    label: band.label,
    color: band.color,
  })),
  { label: "update time unknown", color: unknownFreshnessColor },
];
