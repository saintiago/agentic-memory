/**
 * The freshness palette: fixed age ranges, the neutral unknown color and an age that is never
 * substituted with an observation time.
 *
 * See docs/dashboard.md#visual-behavior and docs/dashboard.md#acceptance-checks.
 */
import { describe, expect, it } from "vitest";

import {
  formatAge,
  freshnessBands,
  freshnessOf,
  unknownFreshnessColor,
} from "../freshness.js";

const now = Date.parse("2026-09-28T12:00:00.000Z");
const before = (milliseconds: number): string =>
  new Date(now - milliseconds).toISOString();

describe("freshness palette", () => {
  it("keeps fixed, labeled, comparable age ranges", () => {
    expect(freshnessBands.map((band) => band.label)).toEqual([
      "under 1 hour",
      "1–24 hours",
      "1–7 days",
      "7–30 days",
      "30 days or older",
    ]);
    expect(new Set(freshnessBands.map((band) => band.color)).size).toBe(
      freshnessBands.length,
    );
  });

  it("classifies known update times into the expected bands", () => {
    expect(freshnessOf(before(5 * 60_000), now).label).toBe("under 1 hour");
    expect(freshnessOf(before(2 * 3_600_000), now).label).toBe("1–24 hours");
    expect(freshnessOf(before(3 * 86_400_000), now).label).toBe("1–7 days");
    expect(freshnessOf(before(10 * 86_400_000), now).label).toBe("7–30 days");
    expect(freshnessOf(before(120 * 86_400_000), now).label).toBe(
      "30 days or older",
    );
  });

  it("keeps the exact update time and formats the age", () => {
    const freshness = freshnessOf(before(90 * 60_000), now);
    expect(freshness.updatedAt).toBe(before(90 * 60_000));
    expect(freshness.ageLabel).toBe("1 hour");
    expect(freshness.ageMs).toBe(90 * 60_000);
  });

  it("keeps an unknown update time unknown instead of using the observation time", () => {
    const freshness = freshnessOf(undefined, now);
    expect(freshness.label).toBe("unknown");
    expect(freshness.color).toBe(unknownFreshnessColor);
    expect(freshness.updatedAt).toBeUndefined();
    expect(freshness.ageMs).toBeUndefined();
    expect(freshness.ageLabel).toBe("unknown");
    expect(freshness.band).toBeUndefined();
  });

  it("clamps a future update time into a clock skew and stays fresh", () => {
    const freshness = freshnessOf(before(-60_000), now);
    expect(freshness.ageMs).toBe(0);
    expect(freshness.label).toBe("under 1 hour");
  });

  it("formats ages as minutes, hours, days and months", () => {
    expect(formatAge(30_000)).toBe("under a minute");
    expect(formatAge(60_000)).toBe("1 minute");
    expect(formatAge(5 * 60_000)).toBe("5 minutes");
    expect(formatAge(3_600_000)).toBe("1 hour");
    expect(formatAge(2 * 86_400_000)).toBe("2 days");
    expect(formatAge(65 * 86_400_000)).toBe("2 months");
  });
});
