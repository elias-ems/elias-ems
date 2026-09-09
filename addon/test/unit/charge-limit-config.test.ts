import { describe, expect, it } from "vitest";
import {
  type Battery,
  normalizeBattery,
  parseBattery,
} from "../../app/lib/batteries";
import { chargeBatteryFixture } from "../charge-forecast-fixture.js";

function form(overrides: Record<string, string | undefined> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries(chargeBatteryFixture))
    if (key !== "steered") data.set(key, String(value));
  for (const [key, value] of Object.entries(overrides))
    if (value !== undefined) data.set(key, value);
  return data;
}
describe("charge-limit settings", () => {
  it("accepts a generic number entity independently of target steering", () => {
    const parsed = parseBattery(
      form({
        chargeLimitEntityId: "number.indevolt_cms_sf2000_feed_in_power_limit",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.fields.steered).toBe(false);
      expect(parsed.fields.chargeLimitMode).toBe("preview");
    }
  });
  it("does not activate migrated batteries", () => {
    const {
      chargeLimitMode: _mode,
      chargeLimitEntityId: _id,
      ...legacy
    } = chargeBatteryFixture;
    expect(normalizeBattery(legacy as Battery).chargeLimitMode).toBe("off");
  });
  it.each([
    { steered: "on" },
    { chargeLimitEntityId: "sensor.power" },
    { chargeLimitEntityId: "" },
    { maxChargePowerW: "" },
    { maxDischargePowerW: "" },
    { chargeEfficiencyPercent: "0" },
    { chargeEfficiencyPercent: "NaN" },
    { solarMarginPercent: "81" },
    { chargeWearPerKwh: "-1" },
  ])("rejects invalid control settings %o", (overrides) => {
    expect(parseBattery(form(overrides)).ok).toBe(false);
  });
});
