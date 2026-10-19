import { describe, expect, it } from "vitest";
import {
  type Battery,
  normalizeBattery,
  parseBattery,
  steerableBy,
} from "../../app/lib/batteries";
import { chargeBatteryFixture } from "../charge-forecast-fixture.js";

const CHECKBOXES = [
  "steered",
  "chargeLimitPlanning",
  "dischargeLimitSupported",
  "controlModes",
  "commandContract",
];

function form(overrides: Record<string, string | undefined> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries(chargeBatteryFixture))
    if (!CHECKBOXES.includes(key)) data.set(key, String(value));
  data.set("chargeLimitPlanning", "on");
  for (const [key, value] of Object.entries(overrides))
    if (value !== undefined) data.set(key, value);
  return data;
}

describe("charge-limit settings", () => {
  it.each([false, true])(
    "accepts charge-limit settings with steering %s",
    (steered) => {
      const parsed = parseBattery(
        form({ steered: steered ? "on" : undefined }),
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.fields.steered).toBe(steered);
        expect(parsed.fields.chargeLimitPlanning).toBe(true);
        expect(parsed.fields.commandContract).toBe(1);
        expect(steerableBy(parsed.fields, "charge-limit")).toBe(steered);
      }
    },
  );

  it("reads only the setpoint modes that were ticked, and always balance", () => {
    const data = form();
    data.append("controlModes", "hold");
    const parsed = parseBattery(data);
    expect(parsed.ok && parsed.fields.controlModes).toEqual([
      "balance",
      "hold",
    ]);
    expect(parsed.ok && steerableBy(parsed.fields, "net-zero-energy")).toBe(
      false,
    );
  });

  it("carries a pre-event battery's intent across the upgrade, unsteered", () => {
    const legacy = {
      ...chargeBatteryFixture,
      commandContract: undefined,
      chargeLimitPlanning: undefined,
      dischargeLimitSupported: undefined,
      chargeLimitEntityId: "number.battery_charge_limit",
      dischargeLimitEntityId: "number.ac_output",
      chargeLimitMode: "active",
    } as unknown as Battery;
    const battery = normalizeBattery(legacy);

    // Nothing is listening for the new event yet.
    expect(battery.steered).toBe(false);
    expect(battery.chargeLimitPlanning).toBe(true);
    expect(battery.dischargeLimitSupported).toBe(true);
    expect(battery).not.toHaveProperty("chargeLimitEntityId");
    expect(battery).not.toHaveProperty("chargeLimitMode");
  });

  it.each([
    { maxChargePowerW: "" },
    { maxDischargePowerW: "" },
    { powerStepW: "0" },
    { powerStepW: "abc" },
    { controlModes: "boost" },
    { chargeEfficiencyPercent: "0" },
    { chargeEfficiencyPercent: "NaN" },
  ])("rejects invalid control settings %o", (overrides) => {
    expect(parseBattery(form(overrides)).ok).toBe(false);
  });
});
