/**
 * Validation and the "what do we make of what's on disk" rules, all of which are
 * pure. `FormData` is a web standard Node implements, so posting a form can be
 * tested without a router in front of it.
 */
import { describe, expect, it } from "vitest";
import type { Battery } from "../../app/lib/batteries";
import {
  BATTERY_DEFAULTS,
  normalizeBattery,
  parseBattery,
  resolvePowerLimits,
} from "../../app/lib/batteries";
import {
  DEFAULT_CONTROL_CONFIG,
  MAX_INTERVAL_SECONDS,
  normalizeControlConfig,
  parseControlConfig,
} from "../../app/lib/control";
import { isGridConfigured, normalizeGrid, parseGrid } from "../../app/lib/grid";
import { normalizePvEntity } from "../../app/lib/pv-entities";

function form(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    formData.append(name, value);
  }
  return formData;
}

const validBattery = {
  title: "Home battery",
  capacityKwh: "10",
  minChargePercent: "10",
  maxChargePercent: "90",
  energyEntityId: "sensor.battery_energy_total",
  powerEntityId: "sensor.battery_power",
  socEntityId: "sensor.battery_state_of_charge",
};

describe("parseGrid", () => {
  it("accepts the signed power sensor", () => {
    const result = parseGrid(form({ powerEntityId: " sensor.grid_power " }));

    expect(result).toEqual({
      ok: true,
      grid: { powerEntityId: "sensor.grid_power" },
    });
  });

  it("asks for the sensor, since there is no net exchange without it", () => {
    const result = parseGrid(form({}));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.powerEntityId).toBeTruthy();
  });
});

describe("normalizeGrid", () => {
  it("treats an absent file as nothing configured", () => {
    const grid = normalizeGrid(null);

    expect(grid).toEqual({ powerEntityId: "" });
    expect(isGridConfigured(grid)).toBe(false);
  });

  it("counts as configured once the sensor is set", () => {
    expect(isGridConfigured(normalizeGrid({}))).toBe(false);
    expect(
      isGridConfigured(normalizeGrid({ powerEntityId: "sensor.grid_power" })),
    ).toBe(true);
  });
});

describe("parseBattery", () => {
  it("returns numbers, not the strings the form posted", () => {
    const result = parseBattery(form(validBattery));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.capacityKwh).toBe(10);
    expect(result.fields.minChargePercent).toBe(10);
    expect(result.fields.maxChargePercent).toBe(90);
  });

  it("rejects a capacity of zero, which would make every share meaningless", () => {
    const result = parseBattery(form({ ...validBattery, capacityKwh: "0" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.capacityKwh).toBeTruthy();
  });

  it("rejects a charge window outside 0–100", () => {
    const result = parseBattery(
      form({
        ...validBattery,
        minChargePercent: "-5",
        maxChargePercent: "140",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.minChargePercent).toBeTruthy();
    expect(result.errors.maxChargePercent).toBeTruthy();
  });

  it("rejects a window with no room in it", () => {
    const result = parseBattery(
      form({ ...validBattery, minChargePercent: "80", maxChargePercent: "80" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.maxChargePercent).toContain("above the minimum");
  });

  it("says which entity is missing rather than failing as a whole", () => {
    const result = parseBattery(form({ ...validBattery, socEntityId: "" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors)).toEqual(["socEntityId"]);
  });

  it("accepts a battery with no control key, which is watched but not steered", () => {
    const result = parseBattery(form(validBattery));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.controlKey).toBe("");
    expect(result.fields.maxChargePowerW).toBeNull();
    expect(result.fields.maxDischargePowerW).toBeNull();
  });

  it("takes the control key and the power caps when they are given", () => {
    const result = parseBattery(
      form({
        ...validBattery,
        controlKey: " home_battery ",
        maxChargePowerW: "5000",
        maxDischargePowerW: "3500",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Trimmed, because it is matched against verbatim in an automation's event
    // trigger and a trailing space there is invisible and fatal.
    expect(result.fields.controlKey).toBe("home_battery");
    expect(result.fields.maxChargePowerW).toBe(5000);
    expect(result.fields.maxDischargePowerW).toBe(3500);
  });

  it("rejects a mistyped power cap instead of reading it as no cap", () => {
    // Blank means "no cap", which is the least constrained reading there is.
    // Silently giving a typo the same meaning would turn a fat-fingered limit
    // into an unlimited one.
    for (const value of ["nonsense", "0", "-5000"]) {
      const result = parseBattery(
        form({ ...validBattery, maxChargePowerW: value }),
      );

      expect(result.ok, `cap ${value}`).toBe(false);
      if (result.ok) return;
      expect(result.errors.maxChargePowerW).toBeTruthy();
    }
  });
});

describe("normalizeBattery", () => {
  it("coerces the numbers a hand-edited file may have left as strings", () => {
    // A string where a number belongs turns the strategy's arithmetic into
    // string concatenation, which would be wrong without being obviously wrong.
    const battery = normalizeBattery({
      id: "b1",
      title: "Home battery",
      capacityKwh: "10" as unknown as number,
      minChargePercent: "5" as unknown as number,
      maxChargePercent: "95" as unknown as number,
      energyEntityId: "sensor.e",
      powerEntityId: "sensor.p",
      socEntityId: "sensor.s",
      controlKey: "home_battery",
      maxChargePowerW: "5000" as unknown as number,
      maxDischargePowerW: "3000" as unknown as number,
    });

    expect(battery.capacityKwh).toBe(10);
    expect(battery.minChargePercent).toBe(5);
    expect(battery.maxChargePercent).toBe(95);
    expect(battery.maxChargePowerW).toBe(5000);
    expect(battery.maxDischargePowerW).toBe(3000);
  });

  it("falls back to the defaults for an unparseable charge window", () => {
    const battery = normalizeBattery({
      id: "b1",
      title: "",
      capacityKwh: Number.NaN,
      minChargePercent: "oops" as unknown as number,
      maxChargePercent: "" as unknown as number,
      energyEntityId: "sensor.e",
      powerEntityId: "sensor.battery_power",
      socEntityId: "sensor.s",
      controlKey: "",
      maxChargePowerW: null,
      maxDischargePowerW: null,
    });

    expect(battery.capacityKwh).toBe(0);
    expect(battery.minChargePercent).toBe(BATTERY_DEFAULTS.minChargePercent);
    expect(battery.maxChargePercent).toBe(BATTERY_DEFAULTS.maxChargePercent);
    // An untitled record shows its power entity, which at least tells two apart.
    expect(battery.title).toBe("sensor.battery_power");
  });

  it("reads a record saved before the control fields existed as unsteered", () => {
    // The cast is the point: this is a batteries.json written by an older
    // version, where the three fields below are simply absent. Anything other
    // than "not configured" here would start steering an installation that had
    // never been asked whether it wanted to be.
    const battery = normalizeBattery({
      id: "b1",
      title: "Home battery",
      capacityKwh: 10,
      minChargePercent: 10,
      maxChargePercent: 90,
      energyEntityId: "sensor.e",
      powerEntityId: "sensor.p",
      socEntityId: "sensor.s",
    } as Battery);

    expect(battery.controlKey).toBe("");
    expect(battery.maxChargePowerW).toBeNull();
    expect(battery.maxDischargePowerW).toBeNull();
  });

  it("reads a record that still names a target entity as unsteered too", () => {
    // A batteries.json from the version that wrote setpoints to an entity.
    // Nothing is written to entities any more, so the honest reading is that
    // this battery is not being steered until a control key and the automation
    // that listens for it both exist — claiming otherwise would mean claiming
    // to command hardware that has stopped hearing us.
    const battery = normalizeBattery({
      id: "b1",
      title: "Home battery",
      capacityKwh: 10,
      minChargePercent: 10,
      maxChargePercent: 90,
      energyEntityId: "sensor.e",
      powerEntityId: "sensor.p",
      socEntityId: "sensor.s",
      targetPowerEntityId: "input_number.battery_setpoint",
    } as Battery & { targetPowerEntityId: string });

    expect(battery.controlKey).toBe("");
  });

  it("drops a power cap of zero rather than freezing the battery at 0 W", () => {
    // Far more likely to be a stray keystroke in a hand-edited file than a
    // deliberate "never let this battery do anything".
    const battery = normalizeBattery({
      id: "b1",
      title: "Home battery",
      capacityKwh: 10,
      minChargePercent: 10,
      maxChargePercent: 90,
      energyEntityId: "sensor.e",
      powerEntityId: "sensor.p",
      socEntityId: "sensor.s",
      controlKey: "home_battery",
      maxChargePowerW: 0,
      maxDischargePowerW: -5000,
    });

    expect(battery.maxChargePowerW).toBeNull();
    expect(battery.maxDischargePowerW).toBeNull();
  });
});

describe("resolvePowerLimits", () => {
  it("leaves a direction the settings don't cap unbounded", () => {
    // Settings are the only source now. A setpoint that goes out as an event
    // has no min/max to fall back on, and inventing one from the battery's
    // capacity would be a guess about hardware — so an empty field means
    // uncapped, and it is the SoC window that keeps the battery safe.
    expect(
      resolvePowerLimits({ maxChargePowerW: null, maxDischargePowerW: null }),
    ).toEqual({ maxChargeW: null, maxDischargeW: null });
  });

  it("takes each direction's cap from its own field", () => {
    expect(
      resolvePowerLimits({ maxChargePowerW: 5000, maxDischargePowerW: 4000 }),
    ).toEqual({ maxChargeW: 5000, maxDischargeW: 4000 });
  });
});

describe("normalizePvEntity", () => {
  it("falls back to the power entity id for records saved before titles existed", () => {
    expect(
      normalizePvEntity({
        id: "a",
        title: "   ",
        powerEntityId: "sensor.p",
        energyEntityId: "sensor.e",
      }).title,
    ).toBe("sensor.p");
  });
});

describe("parseControlConfig", () => {
  it("reads an absent checkbox as off, because that is all a browser sends", () => {
    const off = parseControlConfig(
      form({ strategy: "net-zero-energy", intervalSeconds: "5" }),
    );
    const on = parseControlConfig(
      form({
        enabled: "on",
        strategy: "net-zero-energy",
        intervalSeconds: "5",
      }),
    );

    expect(off.ok && off.config.enabled).toBe(false);
    expect(on.ok && on.config.enabled).toBe(true);
  });

  it("rejects an interval outside the allowed range", () => {
    for (const intervalSeconds of [
      "0",
      String(MAX_INTERVAL_SECONDS + 1),
      "2.5",
      "",
    ]) {
      const result = parseControlConfig(
        form({ strategy: "net-zero-energy", intervalSeconds }),
      );
      expect(result.ok, `interval ${intervalSeconds}`).toBe(false);
    }
  });

  it("falls back to the default strategy rather than storing an unknown id", () => {
    const result = parseControlConfig(
      form({ strategy: "does-not-exist", intervalSeconds: "5" }),
    );

    expect(result.ok && result.config.strategy).toBe(
      DEFAULT_CONTROL_CONFIG.strategy,
    );
  });
});

describe("normalizeControlConfig", () => {
  it("defaults to a stopped loop on a five-second interval", () => {
    expect(normalizeControlConfig(null)).toEqual(DEFAULT_CONTROL_CONFIG);
  });

  it("clamps an interval that is out of range on disk", () => {
    expect(normalizeControlConfig({ intervalSeconds: 0 }).intervalSeconds).toBe(
      1,
    );
    expect(
      normalizeControlConfig({ intervalSeconds: 99_999 }).intervalSeconds,
    ).toBe(MAX_INTERVAL_SECONDS);
  });

  it("keeps a downgrade runnable by falling back to a known strategy", () => {
    const config = normalizeControlConfig({
      enabled: true,
      strategy: "from-a-later-version" as never,
      intervalSeconds: 10,
    });

    expect(config.strategy).toBe(DEFAULT_CONTROL_CONFIG.strategy);
    expect(config.enabled).toBe(true);
  });
});
