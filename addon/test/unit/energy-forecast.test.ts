import { describe, expect, it } from "vitest";
import {
  buildLoadProfile,
  combineSolar,
  consumptionCounters,
  type EnergyPreferences,
  type EnergyStatistics,
  localHour,
  selectedForecasts,
} from "../../app/lib/energy-forecast";

const prefs: EnergyPreferences = {
  energy_sources: [
    {
      type: "solar",
      stat_energy_from: "pv",
      config_entry_solar_forecast: ["east", "west"],
    },
    { type: "grid", stat_energy_from: "import", stat_energy_to: "export" },
    {
      type: "battery",
      stat_energy_from: "discharge",
      stat_energy_to: "charge",
    },
  ],
};
describe("Energy dashboard forecast and demand", () => {
  it("sums every grid source using configured import and export directions", () => {
    const withAccounting = {
      energy_sources: [
        ...prefs.energy_sources,
        { type: "grid", stat_energy_from: "daily_fee" },
        {
          type: "grid",
          flow_from: [{ stat_energy_from: "tariff2" }],
          flow_to: [
            { stat_energy_to: "return2" },
            { stat_energy_to: "reimbursement" },
          ],
        },
      ],
    };
    const counters = consumptionCounters(withAccounting);
    expect(Object.fromEntries(counters)).toEqual({
      pv: 1,
      import: 1,
      export: -1,
      discharge: 1,
      charge: -1,
      daily_fee: 1,
      tariff2: 1,
      return2: -1,
      reimbursement: -1,
    });
    const values = {
      pv: 2,
      import: 1,
      export: 0.5,
      discharge: 0.1,
      charge: 1,
      daily_fee: 0.002,
      tariff2: 0.5,
      return2: 0.1,
      reimbursement: 0.001,
    };
    const stats: EnergyStatistics = Object.fromEntries(
      Object.entries(values).map(([id, change]) => [
        id,
        Array.from({ length: 96 }, (_, i) => ({
          start: i * 3_600_000,
          change,
        })),
      ]),
    );
    const profile = buildLoadProfile(counters, stats, "UTC");
    expect(profile.watts.every((w) => Math.abs(w - 2001) < 1e-6)).toBe(true);
  });
  it("follows selected providers, deduplicates and intersects complete hourly coverage", () => {
    const ids = selectedForecasts({
      energy_sources: [
        ...prefs.energy_sources,
        { type: "solar", config_entry_solar_forecast: ["east"] },
      ],
    });
    expect(ids).toEqual(["east", "west"]);
    const at = "2026-09-09T12:00:00Z";
    const rows = combineSolar(ids, {
      east: { wh_hours: { [at]: 1000, "2026-09-09T13:00:00Z": 500 } },
      west: { wh_hours: { [at]: 2000 } },
    });
    expect(rows).toEqual([{ start: Date.parse(at), wh: 3000 }]);
    expect(() => combineSolar(ids, { east: { wh_hours: {} } })).toThrow(
      "unavailable",
    );
  });
  it("rejects unconfigured arrays, malformed data and overlapping counters", () => {
    expect(() =>
      selectedForecasts({ energy_sources: [{ type: "solar" }] }),
    ).toThrow("every solar");
    expect(() =>
      combineSolar(["a"], { a: { wh_hours: { invalid: 3 } } }),
    ).toThrow("invalid");
    expect(() =>
      consumptionCounters({
        energy_sources: [...prefs.energy_sources, prefs.energy_sources[0]],
      }),
    ).toThrow("overlap");
  });
  it("subtracts battery charging from household consumption and requires complete history", () => {
    const stats: EnergyStatistics = {};
    const values = { pv: 2, import: 1, export: 0.5, discharge: 0.1, charge: 1 };
    for (const [id, change] of Object.entries(values))
      stats[id] = Array.from({ length: 96 }, (_, i) => ({
        start: i * 3_600_000,
        end: (i + 1) * 3_600_000,
        change,
      }));
    const profile = buildLoadProfile(consumptionCounters(prefs), stats, "UTC");
    expect(profile.watts.every((w) => Math.abs(w - 1600) < 1e-6)).toBe(true);
    // Recorder may return only start/change for hourly change requests.
    const withoutEnd = Object.fromEntries(
      Object.entries(stats).map(([id, rows]) => [
        id,
        rows.map(({ start, change }) => ({ start, change })),
      ]),
    );
    expect(
      buildLoadProfile(consumptionCounters(prefs), withoutEnd, "UTC"),
    ).toEqual(profile);
    stats.charge = [];
    expect(() =>
      buildLoadProfile(consumptionCounters(prefs), stats, "UTC"),
    ).toThrow("complete days");
  });
  it("uses the HA timezone across DST, including the repeated hour", () => {
    expect(
      localHour(Date.parse("2026-10-25T00:30:00Z"), "Europe/Brussels"),
    ).toBe(2);
    expect(
      localHour(Date.parse("2026-10-25T01:30:00Z"), "Europe/Brussels"),
    ).toBe(2);
    expect(
      localHour(Date.parse("2026-03-29T01:30:00Z"), "Europe/Brussels"),
    ).toBe(3);
  });
});
