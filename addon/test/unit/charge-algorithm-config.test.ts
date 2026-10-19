import { describe, expect, it } from "vitest";
import {
  normalizeControlConfig,
  parseControlConfig,
} from "../../app/lib/control";

describe("charge algorithm settings", () => {
  it("ignores retired algorithm choices and planning fields when posted", () => {
    for (const algorithm of ["cost-optimized", "evening-target"]) {
      const form = new FormData();
      Object.entries({
        intervalSeconds: "5",
        strategy: "charge-limit",
        chargeAlgorithm: algorithm,
        eveningHour: "25",
        ceilingSwitchCost: "-1",
        spikeBufferKwh: "0.54",
        solarMarginPercent: "81",
        chargeWearPerKwh: "-1",
      }).forEach(([k, v]) => {
        form.set(k, v);
      });
      const result = parseControlConfig(form);
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(Object.keys(result.config).sort()).toEqual([
          "enabled",
          "intervalSeconds",
          "strategy",
        ]);
    }
  });
  it("drops retired selectors and planning settings from saved configuration", () => {
    const legacy = {
      strategy: "charge-limit" as const,
      chargeAlgorithm: "cost-optimized",
      eveningHour: 19,
      ceilingSwitchCost: 0.003,
      spikeBufferKwh: 1,
      solarMarginPercent: 30,
      chargeWearPerKwh: 0.1,
    };
    expect(Object.keys(normalizeControlConfig(legacy)).sort()).toEqual([
      "enabled",
      "intervalSeconds",
      "strategy",
    ]);
  });
});
