/**
 * Validation and the "what do we make of what's on disk" rules, all of which are
 * pure. `FormData` is a web standard Node implements, so posting a form can be
 * tested without a router in front of it.
 */
import { describe, expect, it } from "vitest";
import type { Battery } from "../../app/lib/batteries";
import {
  BATTERY_DEFAULTS,
  batterySlug,
  normalizeBattery,
  parseBattery,
  resolvePowerLimits,
  targetEventType,
} from "../../app/lib/batteries";
import {
  DEFAULT_CONTROL_CONFIG,
  MAX_INTERVAL_SECONDS,
  normalizeControlConfig,
  parseControlConfig,
} from "../../app/lib/control";
import {
  DEFAULT_CURTAILMENT_CONFIG,
  MAX_GRID_TARGET_W,
  MAX_SETTLE_SECONDS,
  normalizeCurtailmentConfig,
  parseCurtailmentConfig,
} from "../../app/lib/curtailment";
import { isGridConfigured, normalizeGrid, parseGrid } from "../../app/lib/grid";
import type { PvEntity } from "../../app/lib/pv-entities";
import {
  isCurtailable,
  normalizePvEntity,
  parsePvEntity,
  pvLimitEventType,
  pvSlug,
} from "../../app/lib/pv-entities";
import { slugifyTitle, titleSlugClashes } from "../../app/lib/slug";

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

  it("reads an unticked steering box as watched but not steered", () => {
    // An unchecked checkbox posts nothing at all, so "absent" has to mean off.
    const result = parseBattery(form(validBattery));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.steered).toBe(false);
    expect(result.fields.maxChargePowerW).toBeNull();
    expect(result.fields.maxDischargePowerW).toBeNull();
  });

  it("takes the steering box and the power caps when they are given", () => {
    const result = parseBattery(
      form({
        ...validBattery,
        steered: "on",
        maxChargePowerW: "5000",
        maxDischargePowerW: "3500",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.steered).toBe(true);
    expect(result.fields.maxChargePowerW).toBe(5000);
    expect(result.fields.maxDischargePowerW).toBe(3500);
  });

  it("refuses a title with nothing to build an event name out of", () => {
    // The event type is derived from the title, so a name of pure punctuation
    // leaves nothing to derive. Rejected rather than papered over, since the
    // settings page would otherwise show one name and the automation need
    // another.
    const result = parseBattery(form({ ...validBattery, title: "!!! ⚡" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.title).toBeTruthy();
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
      steered: true,
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
      steered: false,
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

    expect(battery.steered).toBe(false);
    expect(battery.maxChargePowerW).toBeNull();
    expect(battery.maxDischargePowerW).toBeNull();
  });

  it("reads a record that still names a target entity as unsteered too", () => {
    // A batteries.json from the version that wrote targets to an entity.
    // Nothing is written to entities any more, so the honest reading is that
    // this battery is not being steered until the automation that listens for
    // its event exists — claiming otherwise would mean claiming to command
    // hardware that has stopped hearing us.
    const battery = normalizeBattery({
      id: "b1",
      title: "Home battery",
      capacityKwh: 10,
      minChargePercent: 10,
      maxChargePercent: 90,
      energyEntityId: "sensor.e",
      powerEntityId: "sensor.p",
      socEntityId: "sensor.s",
      targetPowerEntityId: "input_number.battery_target",
    } as Battery & { targetPowerEntityId: string });

    expect(battery.steered).toBe(false);
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
      steered: true,
      maxChargePowerW: 0,
      maxDischargePowerW: -5000,
    });

    expect(battery.maxChargePowerW).toBeNull();
    expect(battery.maxDischargePowerW).toBeNull();
  });
});

describe("resolvePowerLimits", () => {
  it("leaves a direction the settings don't cap unbounded", () => {
    // Settings are the only source now. A target that goes out as an event
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
  /** A stored record from before a field existed, as it really appears on disk. */
  const stored = (extra: Record<string, unknown> = {}) =>
    ({
      id: "a",
      title: "Roof",
      powerEntityId: "sensor.p",
      energyEntityId: "sensor.e",
      ...extra,
    }) as PvEntity;

  it("falls back to the power entity id for records saved before titles existed", () => {
    expect(normalizePvEntity(stored({ title: "   " })).title).toBe("sensor.p");
  });

  it("reads a record saved before curtailment as uncurtailable and unrated", () => {
    expect(normalizePvEntity(stored())).toMatchObject({
      ratedPowerW: null,
      curtailable: false,
    });
  });

  it("keeps a configured rating and the curtailable flag", () => {
    expect(
      normalizePvEntity(stored({ ratedPowerW: 5000, curtailable: true })),
    ).toMatchObject({ ratedPowerW: 5000, curtailable: true });
  });

  it("collapses a nonsensical rating to null rather than keeping it", () => {
    // A 0 W rating makes every percentage meaningless, and a negative one is
    // not a rating at all. Both are far more likely to be a hand-edited typo
    // than something anyone meant.
    for (const ratedPowerW of [0, -100, "", "abc", null]) {
      expect(normalizePvEntity(stored({ ratedPowerW })).ratedPowerW).toBeNull();
    }
  });

  it("treats anything but a true flag as not curtailable", () => {
    for (const curtailable of ["yes", 1, null, undefined]) {
      expect(normalizePvEntity(stored({ curtailable })).curtailable).toBe(
        false,
      );
    }
  });
});

describe("isCurtailable", () => {
  it("needs both the flag and a rating", () => {
    expect(isCurtailable({ curtailable: true, ratedPowerW: 5000 })).toBe(true);
    // Ticked but never filled in: a half-finished form, and treating it as
    // steerable would mean dividing by null.
    expect(isCurtailable({ curtailable: true, ratedPowerW: null })).toBe(false);
    expect(isCurtailable({ curtailable: false, ratedPowerW: 5000 })).toBe(
      false,
    );
  });
});

describe("pvSlug and pvLimitEventType", () => {
  it("builds the event type from the title", () => {
    expect(pvLimitEventType(pvSlug({ id: "x", title: "South roof" }))).toBe(
      "elias_ems_south_roof_pv_limit",
    );
  });

  it("falls back to the record id when a title has nothing to slugify", () => {
    expect(pvSlug({ id: "abc-1", title: "⚡" })).toBe("pv_abc_1");
  });
});

describe("parsePvEntity", () => {
  const valid = {
    title: "South roof",
    powerEntityId: "sensor.p",
    energyEntityId: "sensor.e",
  };

  it("accepts an array with no rating while it is not curtailable", () => {
    const parsed = parsePvEntity(form(valid));
    expect(parsed).toMatchObject({
      ok: true,
      fields: { ratedPowerW: null, curtailable: false },
    });
  });

  it("demands a rating once the array is marked curtailable", () => {
    const parsed = parsePvEntity(form({ ...valid, curtailable: "on" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.ratedPowerW).toMatch(/rated power/i);
  });

  it("rejects a rating that is not a positive number", () => {
    for (const ratedPowerW of ["0", "-5", "abc"]) {
      const parsed = parsePvEntity(form({ ...valid, ratedPowerW }));
      expect(parsed.ok).toBe(false);
    }
  });

  it("rejects a title with nothing to build an event type from", () => {
    const parsed = parsePvEntity(form({ ...valid, title: "⚡ !!! ⚡" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.title).toMatch(/letter or digit/);
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

describe("naming a battery on the event bus", () => {
  it("builds a slug a person would have written by hand", () => {
    expect(slugifyTitle("Home battery")).toBe("home_battery");
    // Runs of anything unusable collapse into one underscore, and the ends are
    // trimmed, so the name in an automation is predictable from the one on the
    // settings page rather than merely derived from it.
    expect(slugifyTitle("  Home   Battery! ")).toBe("home_battery");
    expect(slugifyTitle("Garage #2")).toBe("garage_2");
  });

  it("folds accents rather than dropping them", () => {
    // "R_serve" would be a worse name than "reserve", and unrecognisable to
    // whoever typed the title.
    expect(slugifyTitle("Réserve")).toBe("reserve");
  });

  it("has nothing to say about a title with no letters or digits", () => {
    // The form rejects this; the empty string is how it finds out.
    expect(slugifyTitle("⚡ !!! ⚡")).toBe("");
  });

  it("falls back to the record id when a stored title slugifies to nothing", () => {
    // Only reachable through a hand-edited file, and an ugly event name beats
    // publishing to `elias_ems__target_power` or not publishing at all.
    expect(batterySlug({ id: "b1", title: "⚡" })).toBe("battery_b1");
    expect(batterySlug({ id: "b1", title: "Home battery" })).toBe(
      "home_battery",
    );
  });

  it("names one event type per battery", () => {
    expect(targetEventType("home_battery")).toBe(
      "elias_ems_home_battery_target_power",
    );
  });
});

describe("titleSlugClashes", () => {
  const stored = [
    { id: "a", title: "Home battery" },
    { id: "b", title: "Garage" },
  ];

  it("catches two titles that differ on the page and agree on the bus", () => {
    expect(titleSlugClashes(stored, "home-battery", null)).toBe(true);
    expect(titleSlugClashes(stored, "  Home   Battery! ", null)).toBe(true);
  });

  it("lets a genuinely new name through", () => {
    expect(titleSlugClashes(stored, "Shed", null)).toBe(false);
  });

  it("skips the record being edited, so it keeps its own name", () => {
    // Without this, changing a battery's capacity would fail on its own title.
    expect(titleSlugClashes(stored, "Home battery", "a")).toBe(false);
    // Its own id is no licence to take another record's name, though.
    expect(titleSlugClashes(stored, "Garage", "a")).toBe(true);
  });

  it("compares an addition against every stored record", () => {
    // A null id matches nothing, which is what makes "add" check them all.
    expect(titleSlugClashes(stored, "Garage", null)).toBe(true);
  });
});

describe("normalizeCurtailmentConfig", () => {
  it("reads a missing file as the defaults, and off", () => {
    expect(normalizeCurtailmentConfig(null)).toEqual(
      DEFAULT_CURTAILMENT_CONFIG,
    );
  });

  it("defaults the minimum limit above zero", () => {
    // Not a preference. With a floor of 0 the strategy has a fixed point it
    // cannot climb out of: a dark array and a balanced meter compute 0%, which
    // keeps the array dark, which keeps the meter balanced. See curtail.ts.
    expect(DEFAULT_CURTAILMENT_CONFIG.minLimitPercent).toBeGreaterThan(0);
  });

  it("clamps a hand-edited file rather than rejecting it", () => {
    // This runs on a file, not a form. Leaving the feature working at the
    // nearest sane value beats leaving the loop with nothing to run.
    const config = normalizeCurtailmentConfig({
      enabled: true,
      minLimitPercent: 400,
      deadbandW: -50,
      settleSeconds: 99_999,
      gridTargetW: 10_000_000,
    });

    expect(config).toMatchObject({
      enabled: true,
      minLimitPercent: 100,
      deadbandW: 0,
      settleSeconds: MAX_SETTLE_SECONDS,
      gridTargetW: MAX_GRID_TARGET_W,
    });
  });

  it("keeps a negative grid target, which is a meaningful setting", () => {
    // Aiming to keep a little export, as insurance against dipping into import
    // at the consumption price. Clamping this to zero would silently drop it.
    expect(normalizeCurtailmentConfig({ gridTargetW: -200 }).gridTargetW).toBe(
      -200,
    );
  });

  it("keeps a negative price threshold, which is the whole point", () => {
    expect(
      normalizeCurtailmentConfig({ priceThresholdPerKwh: -0.05 })
        .priceThresholdPerKwh,
    ).toBe(-0.05);
  });
});

describe("parseCurtailmentConfig", () => {
  const valid = {
    priceThresholdPerKwh: "0",
    gridTargetW: "0",
    deadbandW: "50",
    minLimitPercent: "5",
    settleSeconds: "30",
  };

  it("accepts a filled-in form, and reads an absent checkbox as off", () => {
    const parsed = parseCurtailmentConfig(form(valid));

    expect(parsed).toMatchObject({
      ok: true,
      config: { enabled: false, deadbandW: 50, minLimitPercent: 5 },
    });
  });

  it("accepts a negative threshold and a negative grid target", () => {
    const parsed = parseCurtailmentConfig(
      form({ ...valid, priceThresholdPerKwh: "-0.05", gridTargetW: "-200" }),
    );

    expect(parsed).toMatchObject({
      ok: true,
      config: { priceThresholdPerKwh: -0.05, gridTargetW: -200 },
    });
  });

  it("rejects a limit outside 0–100", () => {
    for (const minLimitPercent of ["-1", "101", "5.5", "abc", ""]) {
      const parsed = parseCurtailmentConfig(
        form({ ...valid, minLimitPercent }),
      );
      expect(parsed.ok, `minLimitPercent=${minLimitPercent}`).toBe(false);
    }
  });

  it("rejects a settle time outside its range", () => {
    for (const settleSeconds of ["-1", "901", "abc", ""]) {
      const parsed = parseCurtailmentConfig(form({ ...valid, settleSeconds }));
      expect(parsed.ok, `settleSeconds=${settleSeconds}`).toBe(false);
    }
  });

  it("rejects a threshold that is not a number at all", () => {
    // No range on it beyond being a number: it is a price, and how negative a
    // price can get is the market's business rather than ours.
    const parsed = parseCurtailmentConfig(
      form({ ...valid, priceThresholdPerKwh: "cheap" }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.priceThresholdPerKwh).toBeTruthy();
  });
});
