/**
 * Validation and the "what do we make of what's on disk" rules, all of which are
 * pure. `FormData` is a web standard Node implements, so posting a form can be
 * tested without a router in front of it.
 */
import { describe, expect, it } from "vitest";
import {
  BATTERY_DEFAULTS,
  normalizeBattery,
  parseBattery,
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
    });

    expect(battery.capacityKwh).toBe(10);
    expect(battery.minChargePercent).toBe(5);
    expect(battery.maxChargePercent).toBe(95);
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
    });

    expect(battery.capacityKwh).toBe(0);
    expect(battery.minChargePercent).toBe(BATTERY_DEFAULTS.minChargePercent);
    expect(battery.maxChargePercent).toBe(BATTERY_DEFAULTS.maxChargePercent);
    // An untitled record shows its power entity, which at least tells two apart.
    expect(battery.title).toBe("sensor.battery_power");
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
