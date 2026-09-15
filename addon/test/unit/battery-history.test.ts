import { describe, expect, it } from "vitest";
import { historyRange, historySamples } from "../../app/lib/battery-history";

describe("battery history", () => {
  it("accepts only the ranges offered by the page", () => {
    expect(historyRange(null)).toBe(24);
    expect(historyRange("72")).toBe(72);
    expect(historyRange("168")).toBe(168);
    expect(historyRange("999")).toBe(24);
  });

  it("keeps finite recorder values and orders them", () => {
    expect(
      historySamples([
        { state: "unknown", last_changed: "2026-09-15T09:00:00Z" },
        { state: "45.5", last_changed: "2026-09-15T08:00:00Z" },
        { state: "46", last_changed: "2026-09-15T10:00:00Z" },
      ]),
    ).toEqual([
      { at: Date.parse("2026-09-15T08:00:00Z"), value: 45.5 },
      { at: Date.parse("2026-09-15T10:00:00Z"), value: 46 },
    ]);
  });
});
