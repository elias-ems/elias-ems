import { describe, expect, it } from "vitest";
import {
  normalizeControlConfig,
  parseControlConfig,
} from "../../app/lib/control";

describe("charge algorithm settings", () => {
  it("round trips both algorithms with evening settings", () => {
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
          chargeAlgorithm: algorithm,
          eveningHour: 19,
          ceilingSwitchCost: 0.003,
          spikeBufferKwh: 0.54,
        });
      form.set("eveningHour", "25");
      expect(parseControlConfig(form).ok).toBe(false);
    }
  });
  it("does not opt existing configurations into evening planning", () => {
    expect(
      normalizeControlConfig({ strategy: "charge-limit" }).chargeAlgorithm,
    ).not.toBe("evening-target");
  });
});
