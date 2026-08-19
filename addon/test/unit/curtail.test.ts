/**
 * The curtailment strategy is a pure function, so these are plain arithmetic
 * assertions — no Home Assistant, no clock, no disk. Even "how long has the
 * meter been off target" arrives as two numbers, which is what lets the settle
 * rule be checked as directly as the watts.
 */
import { describe, expect, it } from "vitest";
import {
  type CurtailInput,
  NOT_CURTAILABLE_REASON,
  type PvArraySnapshot,
  planCurtailment,
} from "../../app/lib/curtail";
import { DEFAULT_CURTAILMENT_CONFIG } from "../../app/lib/curtailment";

function array(overrides: Partial<PvArraySnapshot> = {}): PvArraySnapshot {
  return {
    id: "a1",
    title: "South roof",
    powerW: 4000,
    ratedPowerW: 5000,
    // Curtailable unless a case says otherwise: these are about the
    // arithmetic, and an array nothing can command sits out of all of it.
    curtailable: true,
    ...overrides,
  };
}

const NOW = 1_000_000;

function input(overrides: Partial<CurtailInput> = {}): CurtailInput {
  return {
    gridPowerW: 0,
    arrays: [array()],
    // Below the default threshold of 0, so the price says "hold back" unless a
    // case is specifically about the price.
    productionPricePerKwh: -0.05,
    currency: "EUR",
    config: { ...DEFAULT_CURTAILMENT_CONFIG, enabled: true },
    nowMs: NOW,
    // Long settled, since most cases are about what is decided rather than
    // about when. The settle rule has cases of its own.
    offTargetSinceMs: 0,
    ...overrides,
  };
}

describe("when the price says nothing needs curtailing", () => {
  it("releases the arrays once injection is at or above the threshold", () => {
    const plan = planCurtailment(
      input({ productionPricePerKwh: 0.04, gridPowerW: -3000 }),
    );

    expect(plan.curtailing).toBe(false);
    expect(plan.decisions[0]).toMatchObject({
      action: "release",
      limitPercent: 100,
      commandPercent: 100,
      released: true,
    });
  });

  it("treats the threshold as exclusive, so exactly zero does not curtail", () => {
    // A kWh that earns nothing is not a kWh that costs something. Curtailing at
    // exactly zero would throw generation away for no gain at all.
    const plan = planCurtailment(
      input({ productionPricePerKwh: 0, gridPowerW: -3000 }),
    );

    expect(plan.curtailing).toBe(false);
  });

  it("honours a threshold above zero, for a contract with an injection fee", () => {
    const plan = planCurtailment(
      input({
        productionPricePerKwh: 0.01,
        gridPowerW: -2000,
        config: {
          ...DEFAULT_CURTAILMENT_CONFIG,
          enabled: true,
          priceThresholdPerKwh: 0.02,
        },
      }),
    );

    expect(plan.curtailing).toBe(true);
    expect(plan.decisions[0].action).toBe("curtail");
  });
});

describe("failing open", () => {
  it("releases the arrays when the price is unknown", () => {
    // A price we cannot read is not a negative price. Treating it as one would
    // throw away generation on the strength of a broken sensor.
    const plan = planCurtailment(
      input({ productionPricePerKwh: null, gridPowerW: -3000 }),
    );

    expect(plan.curtailing).toBe(false);
    expect(plan.decisions[0]).toMatchObject({
      action: "release",
      released: true,
    });
    expect(plan.summary).toMatch(/No injection price/);
  });

  it("releases the arrays when the grid sensor cannot be read", () => {
    // The blind case, and the one place this differs most from battery
    // control: a battery that goes blind should stop, an array that goes blind
    // should generate.
    const plan = planCurtailment(input({ gridPowerW: null }));

    expect(plan.decisions[0]).toMatchObject({
      action: "release",
      commandPercent: 100,
      released: true,
    });
    // Still true, and worth reporting: the price is what it is whether or not
    // we can act on it.
    expect(plan.curtailing).toBe(true);
  });

  it("releases one array whose power reading is missing and keeps the rest correct", () => {
    // Assuming zero would not self-correct: it understates what the curtailable
    // arrays are making, so the limit settles at the floor with the house
    // importing to cover it. Dropping the array out instead makes it one of the
    // arrays that cancel, which leaves the arithmetic right for the others.
    const plan = planCurtailment(
      input({
        gridPowerW: -1000,
        arrays: [
          array({ id: "a1", title: "Blind", powerW: null }),
          array({ id: "a2", title: "South roof", powerW: 3000 }),
        ],
      }),
    );

    expect(plan.decisions[0]).toMatchObject({
      title: "Blind",
      action: "release",
    });
    // 3000 W generating, 1000 W of it exported, so 2000 W is what the house can
    // absorb — 40% of a 5000 W inverter.
    expect(plan.curtailablePvW).toBe(3000);
    expect(plan.combinedAllowedW).toBe(2000);
    expect(plan.decisions[1]).toMatchObject({ limitPercent: 40, limitW: 2000 });
    expect(plan.warnings[0]).toMatch(/power reading unavailable/);
  });

  it("releases everything when no curtailable array has a usable reading", () => {
    const plan = planCurtailment(
      input({ gridPowerW: -1000, arrays: [array({ powerW: null })] }),
    );

    expect(plan.decisions[0].action).toBe("release");
  });
});

describe("the arithmetic", () => {
  it("cuts to what the house can absorb when exporting", () => {
    // 4000 W generated, 2000 W of it going out of the meter, so 2000 W is being
    // used — 40% of a 5000 W inverter.
    const plan = planCurtailment(input({ gridPowerW: -2000 }));

    expect(plan.netW).toBe(-2000);
    expect(plan.curtailablePvW).toBe(4000);
    expect(plan.combinedAllowedW).toBe(2000);
    expect(plan.decisions[0]).toMatchObject({
      action: "curtail",
      limitPercent: 40,
      limitW: 2000,
      commandPercent: 40,
      released: false,
    });
  });

  it("gives generation back when the meter swings to import", () => {
    // The feedback half. An array held at 3000 W with the house importing 500 W
    // is 500 W short of what could be used, and the limit rises by exactly that.
    const plan = planCurtailment(
      input({ gridPowerW: 500, arrays: [array({ powerW: 3000 })] }),
    );

    expect(plan.combinedAllowedW).toBe(3500);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 70 });
  });

  it("leaves an array nobody can command out of the sum entirely", () => {
    // The N-cancellation, and the easiest thing in the whole strategy to get
    // wrong. The house is generating 5000 W and exporting 2000 W, so it is
    // using 3000 W; 1000 W of that comes from the array we cannot touch, so the
    // one we can may make 2000 W — not 3000 W.
    const plan = planCurtailment(
      input({
        gridPowerW: -2000,
        arrays: [
          array({ id: "a1", powerW: 4000 }),
          array({
            id: "a2",
            title: "Shed",
            powerW: 1000,
            ratedPowerW: null,
            curtailable: false,
          }),
        ],
      }),
    );

    expect(plan.curtailablePvW).toBe(4000);
    expect(plan.combinedAllowedW).toBe(2000);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 40 });
    expect(plan.decisions[1]).toMatchObject({
      action: "hold",
      commandPercent: null,
      reason: NOT_CURTAILABLE_REASON,
    });
  });

  it("aims at a grid target other than zero", () => {
    // Aiming to keep 200 W of export as insurance against dipping into import.
    const plan = planCurtailment(
      input({
        gridPowerW: -2000,
        config: {
          ...DEFAULT_CURTAILMENT_CONFIG,
          enabled: true,
          gridTargetW: -200,
        },
      }),
    );

    // 1800 W too far, not 2000 W.
    expect(plan.combinedAllowedW).toBe(2200);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 44 });
  });

  it("releases an array whose limit has come back to full output", () => {
    // Importing more than the array is making: nothing to hold back, and the
    // automation clearing a limit register needs to hear that as a release
    // rather than as a limit that happens to be 100.
    const plan = planCurtailment(input({ gridPowerW: 3000 }));

    expect(plan.decisions[0]).toMatchObject({
      action: "release",
      limitPercent: 100,
      released: true,
    });
  });

  it("quantises the limit to whole percent", () => {
    // 2020 W of a 5000 W inverter is 40.4%, and what goes out is 40 — which is
    // also what makes "the value changed" the same statement as "it moved by at
    // least one step", so `pv-limits.server.ts` needs no deadband of its own.
    const plan = planCurtailment(input({ gridPowerW: -1980 }));

    expect(plan.combinedAllowedW).toBe(2020);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 40, limitW: 2000 });
  });
});

describe("splitting across arrays", () => {
  it("splits in proportion to what each array is generating", () => {
    // 4000 W generated, 1000 W exported, so 3000 W may be made. Proportional to
    // output that is 750 W of the small array and 2250 W of the large one —
    // which are different *percentages*, 38% and 45%, because the two inverters
    // are different sizes.
    const plan = planCurtailment(
      input({
        gridPowerW: -1000,
        arrays: [
          array({ id: "a1", title: "East", powerW: 1000, ratedPowerW: 2000 }),
          array({ id: "a2", title: "South", powerW: 3000, ratedPowerW: 5000 }),
        ],
      }),
    );

    expect(plan.combinedAllowedW).toBe(3000);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 38, limitW: 760 });
    expect(plan.decisions[1]).toMatchObject({ limitPercent: 45, limitW: 2250 });
  });

  it("falls back to the ratings when nothing is generating at all", () => {
    // Night, or every array already pinned at the floor. Splitting by output
    // would be 0/0; splitting by rating gives the same percentage to each,
    // which is a different number of watts for different inverters.
    const plan = planCurtailment(
      input({
        gridPowerW: 700,
        arrays: [
          array({ id: "a1", title: "East", powerW: 0, ratedPowerW: 2000 }),
          array({ id: "a2", title: "South", powerW: 0, ratedPowerW: 5000 }),
        ],
      }),
    );

    expect(plan.decisions[0]).toMatchObject({ limitPercent: 10, limitW: 200 });
    expect(plan.decisions[1]).toMatchObject({ limitPercent: 10, limitW: 500 });
  });
});

describe("the floor", () => {
  it("never takes an array below the minimum limit", () => {
    // Heavy export with the arrays already dark: the arithmetic asks for less
    // than nothing, and the floor is what it gets instead.
    const plan = planCurtailment(
      input({ gridPowerW: -100, arrays: [array({ powerW: 0 })] }),
    );

    expect(plan.combinedAllowedW).toBe(-100);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 5, limitW: 250 });
    expect(plan.decisions[0].reason).toMatch(/floored at 5%/);
  });

  it("would settle at zero and never recover without it", () => {
    // The fixed point the floor exists to break: with a floor of 0 the same
    // reading pins the array at 0%, which keeps it dark, which keeps the meter
    // where it is. Nothing in the arithmetic ever lifts it out again.
    const plan = planCurtailment(
      input({
        gridPowerW: -100,
        arrays: [array({ powerW: 0 })],
        config: {
          ...DEFAULT_CURTAILMENT_CONFIG,
          enabled: true,
          minLimitPercent: 0,
        },
      }),
    );

    expect(plan.decisions[0]).toMatchObject({ limitPercent: 0 });
  });
});

describe("the deadband and the settle time", () => {
  it("holds when the meter is close enough to the target", () => {
    const plan = planCurtailment(input({ gridPowerW: -30 }));

    expect(plan.offTarget).toBe(false);
    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      commandPercent: null,
    });
    expect(plan.summary).toMatch(/deadband/);
  });

  it("holds while the meter has not been off target for long enough", () => {
    // The gap this covers is battery control ramping: the surplus is on the
    // meter but the battery is about to take it, and cutting now would be
    // undone a few seconds later.
    const plan = planCurtailment(
      input({ gridPowerW: -2000, offTargetSinceMs: NOW - 10_000 }),
    );

    expect(plan.offTarget).toBe(true);
    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      commandPercent: null,
    });
    expect(plan.summary).toMatch(/settling, 10s of 30s/);
  });

  it("holds on the very first tick that finds the meter off target", () => {
    // Nothing has been timed yet, so the wait has not started — the loop sets
    // the timestamp from this plan's own `offTarget`.
    const plan = planCurtailment(
      input({ gridPowerW: -2000, offTargetSinceMs: null }),
    );

    expect(plan.offTarget).toBe(true);
    expect(plan.decisions[0].action).toBe("hold");
  });

  it("acts once the settle time has passed", () => {
    const plan = planCurtailment(
      input({ gridPowerW: -2000, offTargetSinceMs: NOW - 31_000 }),
    );

    expect(plan.decisions[0]).toMatchObject({
      action: "curtail",
      commandPercent: 40,
    });
  });

  it("acts immediately when no settle time is configured", () => {
    const plan = planCurtailment(
      input({
        gridPowerW: -2000,
        offTargetSinceMs: null,
        config: {
          ...DEFAULT_CURTAILMENT_CONFIG,
          enabled: true,
          settleSeconds: 0,
        },
      }),
    );

    expect(plan.decisions[0].action).toBe("curtail");
  });
});

describe("arrays that cannot take part", () => {
  it("holds an array that is not marked curtailable", () => {
    const plan = planCurtailment(
      input({ arrays: [array({ curtailable: false })], gridPowerW: -2000 }),
    );

    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      commandPercent: null,
      reason: NOT_CURTAILABLE_REASON,
    });
    expect(plan.summary).toMatch(/No PV array is curtailable/);
  });

  it("holds an array marked curtailable with no rating filled in", () => {
    // A half-finished form. Commanding a percentage of null is not something to
    // guess at, and the settings page refuses the combination anyway.
    const plan = planCurtailment(
      input({
        gridPowerW: -2000,
        arrays: [
          array({ id: "a1", title: "Unrated", ratedPowerW: null }),
          array({ id: "a2", powerW: 4000 }),
        ],
      }),
    );

    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      reason: "no rated power configured",
    });
    expect(plan.decisions[1].action).toBe("curtail");
  });
});
