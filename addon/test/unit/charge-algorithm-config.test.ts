import { describe, expect, it } from "vitest";
import {
  normalizeControlConfig,
  parseControlConfig,
} from "../../app/lib/control";

describe("charge algorithm settings", () => {
  it("ignores retired algorithm choices and round trips evening settings", () => {
    for (const algorithm of ["cost-optimized", "evening-target"]) {
      const form = new FormData();
      Object.entries({
        intervalSeconds: "5",
        strategy: "charge-limit",
        chargeAlgorithm: algorithm,
        eveningHour: "19",
        ceilingSwitchCost: "0.003",
        spikeBufferKwh: "0.54",
      }).forEach(([k, v]) => {
        form.set(k, v);
      });
      const result = parseControlConfig(form);
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(normalizeControlConfig(result.config)).toMatchObject({
          eveningHour: 19,
          ceilingSwitchCost: 0.003,
          spikeBufferKwh: 0.54,
        });
      form.set("eveningHour", "25");
      expect(parseControlConfig(form).ok).toBe(false);
    }
  });
  it("drops the retired selector from saved configuration", () => {
    const legacy = {
      strategy: "charge-limit" as const,
      chargeAlgorithm: "cost-optimized",
    };
    expect(normalizeControlConfig(legacy)).not.toHaveProperty(
      "chargeAlgorithm",
    );
  });
});
