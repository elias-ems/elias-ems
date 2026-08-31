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
  type PvBatterySnapshot,
  planCurtailment,
} from "../../app/lib/curtail";
import {
  type CurtailmentConfig,
  DEFAULT_CURTAILMENT_CONFIG,
} from "../../app/lib/curtailment";

function array(overrides: Partial<PvArraySnapshot> = {}): PvArraySnapshot {
  return {
    id: "a1",
    title: "South roof",
    powerW: 4000,
    ratedPowerW: 5000,
    // Curtailable unless a case says otherwise: these are about the
    // arithmetic, and an array nothing can command sits out of all of it.
    curtailable: true,
    // Modulating unless a case says otherwise: stepped arrays leave the
    // feedback law entirely and have a describe block of their own.
    controlMode: "modulating",
    stepLimitPercent: null,
    ...overrides,
  };
}

/** Idle unless a case says otherwise — most of these are not about batteries. */
function battery(
  overrides: Partial<PvBatterySnapshot> = {},
): PvBatterySnapshot {
  return { title: "Home battery", powerW: 0, ...overrides };
}

const NOW = 1_000_000;

function input(overrides: Partial<CurtailInput> = {}): CurtailInput {
  return {
    gridPowerW: 0,
    arrays: [array()],
    // No battery unless a case brings one: panels and no battery is an
    // ordinary house, and it is the shape every case that predates the battery
    // term was written against.
    batteries: [],
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

describe("a battery that is discharging", () => {
  it("asks the arrays for what the battery is delivering", () => {
    // 2000 W generated, the meter balanced, and 1500 W of the house being
    // covered by the battery. The arrays may make 3500 W — the 1500 W is a
    // shortfall the meter cannot show, because the battery is already filling
    // it.
    const plan = planCurtailment(
      input({
        gridPowerW: 0,
        arrays: [array({ powerW: 2000 })],
        batteries: [battery({ powerW: -1500 })],
      }),
    );

    expect(plan.batteryDischargeW).toBe(1500);
    expect(plan.combinedAllowedW).toBe(3500);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 70 });
  });

  it("would otherwise leave the arrays pinned while the battery emptied", () => {
    // The failure this term exists for, and it is a fixed point rather than a
    // slow drift: net-zero discharges to cover the import curtailment created,
    // the meter comes back to zero, and curtailment reads its own suppression
    // as balance. Every level of PV is an equilibrium once something else is
    // holding the meter.
    const held = {
      gridPowerW: -9,
      arrays: [array({ powerW: 424, ratedPowerW: 10_000 })],
    };

    const withoutBattery = planCurtailment(input(held));
    expect(withoutBattery.offTarget).toBe(false);

    const withBattery = planCurtailment(
      input({ ...held, batteries: [battery({ powerW: -1959 })] }),
    );

    expect(withBattery.offTarget).toBe(true);
    expect(withBattery.combinedAllowedW).toBe(2374);
    expect(withBattery.decisions[0]).toMatchObject({
      action: "curtail",
      limitPercent: 24,
    });
  });

  it("leaves a charging battery exactly where it was", () => {
    // The case the feature was written around, and it must not move: a battery
    // soaking up the surplus drives the meter towards zero on its own, and
    // whatever it is drawing is already inside the reading.
    const plan = planCurtailment(
      input({ gridPowerW: -2000, batteries: [battery({ powerW: 1500 })] }),
    );

    expect(plan.batteryDischargeW).toBe(0);
    expect(plan.combinedAllowedW).toBe(2000);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 40 });
  });

  it("nets the batteries against each other rather than summing discharges", () => {
    // One charging at 2000 W beside one discharging at 1500 W is taking 500 W
    // out of the house between them, not giving it 1500 W. Summing the
    // discharges alone would ask the arrays to cover the charge twice.
    const plan = planCurtailment(
      input({
        gridPowerW: 0,
        arrays: [array({ powerW: 2000 })],
        batteries: [
          battery({ title: "Cellar", powerW: -1500 }),
          battery({ title: "Garage", powerW: 2000 }),
        ],
      }),
    );

    expect(plan.batteryDischargeW).toBe(0);
    expect(plan.combinedAllowedW).toBe(2000);
  });

  it("adds up several batteries carrying the house together", () => {
    const plan = planCurtailment(
      input({
        gridPowerW: 0,
        arrays: [array({ powerW: 2000 })],
        batteries: [
          battery({ title: "Cellar", powerW: -800 }),
          battery({ title: "Garage", powerW: -700 }),
        ],
      }),
    );

    expect(plan.batteryDischargeW).toBe(1500);
    expect(plan.combinedAllowedW).toBe(3500);
  });

  it("assumes a battery with no reading is not discharging, and says so", () => {
    // Under-crediting rather than over-crediting: an allowance built on an
    // invented number would be handed to the arrays as though it were measured.
    const plan = planCurtailment(
      input({
        gridPowerW: 0,
        arrays: [array({ powerW: 2000 })],
        batteries: [battery({ powerW: null })],
      }),
    );

    expect(plan.batteryDischargeW).toBe(0);
    expect(plan.combinedAllowedW).toBe(2000);
    expect(plan.warnings).toContainEqual(
      expect.stringMatching(/Home battery: power reading unavailable/),
    );
  });

  it("names the battery in the summary while it is discharging", () => {
    // The meter alone stops being the whole story the moment a battery is in
    // the way: -1500 W beside a battery discharging 1500 W is a house its
    // arrays are covering exactly, and the same reading on its own is a house
    // exporting at a price it is paying.
    const plan = planCurtailment(
      input({
        gridPowerW: -3000,
        arrays: [array({ powerW: 4000 })],
        batteries: [battery({ powerW: -500 })],
      }),
    );

    expect(plan.summary).toMatch(/while the battery discharges 500 W/);
  });

  it("holds, and warns, when the export is the battery's own discharge", () => {
    // The one case the term cannot fix. Cutting the arrays back would stop the
    // export — by draining the battery to displace free generation, which is
    // the trade the term exists to refuse — so it is reported instead.
    const plan = planCurtailment(
      input({
        gridPowerW: -1500,
        arrays: [array({ powerW: 2000 })],
        batteries: [battery({ powerW: -1500 })],
      }),
    );

    expect(plan.offTarget).toBe(false);
    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      commandPercent: null,
    });
    expect(plan.warnings).toContainEqual(
      expect.stringMatching(/discharging 1500 W into a house the arrays/),
    );
  });

  it("still cuts an export the discharge does not account for", () => {
    // 3000 W going out with only 500 W of it coming from the battery: 2500 W
    // is being sold at a loss and is the arrays' to give up.
    const plan = planCurtailment(
      input({
        gridPowerW: -3000,
        arrays: [array({ powerW: 4000 })],
        batteries: [battery({ powerW: -500 })],
      }),
    );

    expect(plan.combinedAllowedW).toBe(1500);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 30 });
    expect(plan.warnings).toEqual([]);
  });

  it("counts the discharge against a moved target under graded export", () => {
    // The band moves the target and nothing else, so the battery term rides on
    // it untouched: 33% of a 5000 W rating is 1650 W of allowed export, the
    // meter is 1000 W short of that, and the battery is covering 500 W more.
    const plan = planCurtailment(
      input({
        gridPowerW: -650,
        arrays: [array({ powerW: 2000 })],
        batteries: [battery({ powerW: -500 })],
        productionPricePerKwh: 0.005,
        config: {
          ...DEFAULT_CURTAILMENT_CONFIG,
          enabled: true,
          strategy: "graded-export",
        },
      }),
    );

    expect(plan.combinedAllowedW).toBe(3500);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 70 });
  });

  it("does not disturb a soft ceiling, which never reads the meter", () => {
    // Reported, since it is a fact about the house, but not acted on: there is
    // no feedback term here for it to be added back to.
    const plan = planCurtailment(
      input({
        gridPowerW: 0,
        productionPricePerKwh: 0.005,
        batteries: [battery({ powerW: -1500 })],
        config: {
          ...DEFAULT_CURTAILMENT_CONFIG,
          enabled: true,
          strategy: "soft-ceiling",
        },
      }),
    );

    expect(plan.batteryDischargeW).toBe(1500);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 70 });
  });

  it("still releases everything once the price recovers", () => {
    // Nothing about a battery makes a kWh worth less than the threshold says.
    const plan = planCurtailment(
      input({
        productionPricePerKwh: 0.04,
        gridPowerW: 0,
        batteries: [battery({ powerW: -1500 })],
      }),
    );

    expect(plan.curtailing).toBe(false);
    expect(plan.decisions[0]).toMatchObject({ action: "release" });
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

/**
 * The marginal region: prices above the threshold, where a kWh still earns
 * something but not much. `threshold` has nothing to say there and releases;
 * the other two each hold something back, by different means.
 *
 * The defaults are the bands under test throughout — 0.01/0.02/0.03 above the
 * threshold, capping at 70/80/90% or letting 33/67/100% of the rating out.
 */
describe("the strategies above the threshold", () => {
  const withStrategy = (
    strategy: CurtailmentConfig["strategy"],
    overrides: Partial<CurtailmentConfig> = {},
  ): CurtailmentConfig => ({
    ...DEFAULT_CURTAILMENT_CONFIG,
    enabled: true,
    strategy,
    // Acting at once: these cases are about which rule applies, not about when
    // it is allowed to. The settle rule has cases of its own above.
    settleSeconds: 0,
    ...overrides,
  });

  it("releases in the marginal region under the threshold strategy", () => {
    // The regression guard for every existing installation: a price sitting
    // squarely inside band one must still be released, because nobody asked
    // for anything else.
    const plan = planCurtailment(
      input({
        productionPricePerKwh: 0.005,
        gridPowerW: -3000,
        config: withStrategy("threshold"),
      }),
    );

    expect(plan.curtailing).toBe(false);
    expect(plan.decisions[0]).toMatchObject({
      action: "release",
      commandPercent: 100,
      released: true,
    });
  });

  describe("soft ceiling", () => {
    it("caps at the band the price falls in", () => {
      for (const [productionPricePerKwh, expected] of [
        [0.005, 70],
        [0.015, 80],
        [0.025, 90],
      ] as const) {
        const plan = planCurtailment(
          input({
            productionPricePerKwh,
            gridPowerW: -3000,
            config: withStrategy("soft-ceiling"),
          }),
        );

        expect(plan.decisions[0], `at ${productionPricePerKwh}`).toMatchObject({
          action: "curtail",
          limitPercent: expected,
          commandPercent: expected,
          limitW: expected * 50,
          released: false,
        });
      }
    });

    it("puts a price sitting exactly on an edge in the band above it", () => {
      // A band reaches *up to* its edge. Were the edge inclusive, the two
      // neighbouring bands would both claim it and the first would always win,
      // which is a coin toss dressed up as a rule.
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.01,
          config: withStrategy("soft-ceiling"),
        }),
      );

      expect(plan.decisions[0].limitPercent).toBe(80);
    });

    it("releases once the price is clear of the top band", () => {
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.035,
          gridPowerW: -3000,
          config: withStrategy("soft-ceiling"),
        }),
      );

      expect(plan.curtailing).toBe(false);
      expect(plan.decisions[0]).toMatchObject({
        commandPercent: 100,
        released: true,
      });
    });

    it("ignores the meter entirely, including an unreadable one", () => {
      // The character of the strategy, and the one thing it has over graded
      // export: with nothing to balance against, there is nothing that can go
      // wrong with the balancing.
      for (const gridPowerW of [-9000, 0, 9000, null]) {
        const plan = planCurtailment(
          input({
            productionPricePerKwh: 0.005,
            gridPowerW,
            config: withStrategy("soft-ceiling"),
          }),
        );

        expect(plan.decisions[0], `grid ${gridPowerW}`).toMatchObject({
          limitPercent: 70,
        });
        expect(plan.offTarget, `grid ${gridPowerW}`).toBe(false);
      }
    });

    it("still honours the floor when a band is set below it", () => {
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.005,
          config: withStrategy("soft-ceiling", { minLimitPercent: 80 }),
        }),
      );

      expect(plan.decisions[0].limitPercent).toBe(80);
    });

    it("releases an array whose own power reading is missing", () => {
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.005,
          arrays: [array({ powerW: null })],
          config: withStrategy("soft-ceiling"),
        }),
      );

      expect(plan.decisions[0]).toMatchObject({
        action: "release",
        reason: "power reading unavailable",
      });
    });

    it("leaves what happens below the threshold exactly as it was", () => {
      const plan = planCurtailment(
        input({
          gridPowerW: -2000,
          config: withStrategy("soft-ceiling"),
        }),
      );

      // 4000 W generated, 2000 W exported, so 2000 W is what the house can
      // take — the feedback law, untouched by the strategy above it.
      expect(plan.decisions[0]).toMatchObject({
        action: "curtail",
        commandPercent: 40,
      });
    });
  });

  describe("graded export", () => {
    it("lets the band's share of the rating cross the meter", () => {
      // Band one allows 33% of the 5000 W rating out, so the target moves to
      // -1650 W. The meter is 1350 W past it, and 4000 - 1350 is 2650 W — 53%.
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.005,
          gridPowerW: -3000,
          config: withStrategy("graded-export"),
        }),
      );

      expect(plan.decisions[0]).toMatchObject({
        action: "curtail",
        commandPercent: 53,
      });
      expect(plan.summary).toMatch(/up to 1650 W may cross the meter/);
    });

    it("holds nothing back when the whole rating may be exported", () => {
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.025,
          gridPowerW: -3000,
          config: withStrategy("graded-export"),
        }),
      );

      expect(plan.decisions[0]).toMatchObject({
        commandPercent: 100,
        released: true,
      });
    });

    it("shares the allowance over the combined rating, and splits by output", () => {
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.005,
          gridPowerW: -4000,
          arrays: [
            array({ powerW: 4000, ratedPowerW: 5000 }),
            array({
              id: "a2",
              title: "Garage",
              powerW: 2000,
              ratedPowerW: 5000,
            }),
          ],
          config: withStrategy("graded-export"),
        }),
      );

      // 33% of the combined 10 kW is 3300 W, leaving the meter 700 W past the
      // target, so 6000 - 700 = 5300 W is shared out — and shared in proportion
      // to what each array is making, not to what it is rated for.
      expect(plan.decisions[0].commandPercent).toBe(71);
      expect(plan.decisions[1].commandPercent).toBe(35);
    });

    it("counts the meter as balanced once it sits on the allowance", () => {
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.005,
          gridPowerW: -1650,
          config: withStrategy("graded-export"),
        }),
      );

      // Exporting 1650 W is exactly what this band permits, so there is nothing
      // to correct — the deadband applies to the moved target, not to zero.
      expect(plan.offTarget).toBe(false);
      expect(plan.decisions[0]).toMatchObject({
        action: "hold",
        commandPercent: null,
      });
    });

    it("still floors an array the allowance cannot save", () => {
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.005,
          gridPowerW: -9000,
          config: withStrategy("graded-export"),
        }),
      );

      expect(plan.decisions[0].commandPercent).toBe(
        DEFAULT_CURTAILMENT_CONFIG.minLimitPercent,
      );
    });

    it("releases once the price is clear of the top band", () => {
      const plan = planCurtailment(
        input({
          productionPricePerKwh: 0.035,
          gridPowerW: -3000,
          config: withStrategy("graded-export"),
        }),
      );

      expect(plan.curtailing).toBe(false);
      expect(plan.decisions[0]).toMatchObject({ released: true });
    });

    it("leaves what happens below the threshold exactly as it was", () => {
      const plan = planCurtailment(
        input({
          gridPowerW: -2000,
          config: withStrategy("graded-export"),
        }),
      );

      expect(plan.decisions[0]).toMatchObject({
        action: "curtail",
        commandPercent: 40,
      });
    });
  });
});

describe("stepped inverters", () => {
  /** A Huawei-shaped array: written to permanently, so held at one number. */
  const stepped = (overrides: Partial<PvArraySnapshot> = {}) =>
    array({
      id: "huawei",
      title: "Huawei",
      ratedPowerW: 5000,
      controlMode: "stepped",
      stepLimitPercent: 20,
      ...overrides,
    });

  it("takes its step once there is export to prevent", () => {
    const plan = planCurtailment(
      input({ gridPowerW: -2000, arrays: [stepped({ powerW: 4000 })] }),
    );

    // No arithmetic — 20% of 5000 W is the number that was typed in, and it is
    // the same number whatever the meter says.
    expect(plan.decisions[0]).toMatchObject({
      action: "curtail",
      limitPercent: 20,
      limitW: 1000,
      commandPercent: 20,
    });
  });

  it("does not spend a write on an export its own battery accounts for", () => {
    // 1000 W going out of the meter while the battery gives out 2000 W: the
    // export is the battery's, and so is stopping it. Holding this array down
    // so the battery can empty in its place would spend one of a finite number
    // of writes making that trade twice over.
    const plan = planCurtailment(
      input({
        gridPowerW: -1000,
        arrays: [stepped({ powerW: 2000 })],
        batteries: [battery({ powerW: -2000 })],
      }),
    );

    expect(plan.offTarget).toBe(true);
    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      commandPercent: null,
    });
    expect(plan.decisions[0].reason).toMatch(/no export to prevent/);
  });

  it("still steps when the export outruns the discharge", () => {
    const plan = planCurtailment(
      input({
        gridPowerW: -2000,
        arrays: [stepped({ powerW: 4000 })],
        batteries: [battery({ powerW: -500 })],
      }),
    );

    expect(plan.decisions[0]).toMatchObject({
      action: "curtail",
      commandPercent: 20,
    });
  });

  it("stays where it is when the house swallows everything", () => {
    // An EV starts charging mid-episode. Handing the array back would cost a
    // write, and taking it away again when the EV stops would cost another.
    const plan = planCurtailment(
      input({ gridPowerW: 3000, arrays: [stepped({ powerW: 1000 })] }),
    );

    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      commandPercent: null,
    });
    expect(plan.decisions[0].reason).toMatch(/no export to prevent/);
  });

  it("leaves the modulating arrays to balance the house around it", () => {
    // The Huawei is already stepped to 1000 W. The house is using 2500 W, so
    // the SMA should make the remaining 1500 W — not 2500 W, which is what
    // counting the Huawei into the feedback law would ask for.
    const plan = planCurtailment(
      input({
        gridPowerW: -1500,
        arrays: [
          stepped({ powerW: 1000 }),
          array({
            id: "sma",
            title: "SMA",
            powerW: 3000,
            ratedPowerW: 4000,
          }),
        ],
      }),
    );

    expect(plan.curtailablePvW).toBe(3000);
    expect(plan.combinedAllowedW).toBe(1500);
    expect(plan.decisions[0]).toMatchObject({ limitPercent: 20 });
    expect(plan.decisions[1]).toMatchObject({ limitPercent: 38, limitW: 1520 });
  });

  it("is commanded even when its own power sensor is quiet", () => {
    // A modulating array is released on a missing reading, because assuming a
    // number would corrupt the feedback law. A stepped array is commanded with
    // a number that was typed in, so the reading is not in the way — and
    // releasing it over a sensor blip would spend a write on the very hardware
    // this mode exists to protect.
    const plan = planCurtailment(
      input({ gridPowerW: -2000, arrays: [stepped({ powerW: null })] }),
    );

    expect(plan.decisions[0]).toMatchObject({
      action: "curtail",
      commandPercent: 20,
    });
  });

  it("is never modulated when no step has been configured", () => {
    // A hand-edited file. Falling back to the feedback law would do the one
    // thing the mode exists to prevent.
    const plan = planCurtailment(
      input({
        gridPowerW: -2000,
        arrays: [stepped({ powerW: 4000, stepLimitPercent: null })],
      }),
    );

    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      commandPercent: null,
    });
    expect(plan.decisions[0].reason).toMatch(/no fixed limit configured/);
  });

  it("still steps when it is the only curtailable array", () => {
    // Nothing to modulate is not the same as nothing to do — a house whose one
    // curtailable inverter is stepped has no feedback loop and still has a step.
    const plan = planCurtailment(
      input({ gridPowerW: -3000, arrays: [stepped({ powerW: 4000 })] }),
    );

    expect(plan.decisions[0]).toMatchObject({ commandPercent: 20 });
    expect(plan.summary).not.toMatch(/releasing/);
  });

  it("is not raised to the minimum limit", () => {
    // `minLimitPercent` keeps the feedback law out of its fixed point at zero,
    // and a stepped array is not in that loop. Somebody asking for 0% means it.
    const plan = planCurtailment(
      input({
        gridPowerW: -2000,
        arrays: [stepped({ powerW: 4000, stepLimitPercent: 0 })],
      }),
    );

    expect(plan.decisions[0]).toMatchObject({ limitPercent: 0, limitW: 0 });
  });

  it("generates freely in the marginal region above the threshold", () => {
    // A band is a gradation and a stepped inverter has none to offer, so
    // holding it back for a kWh that still earns something is the worse trade.
    const plan = planCurtailment(
      input({
        gridPowerW: -3000,
        productionPricePerKwh: 0.005,
        arrays: [
          stepped({ powerW: 4000 }),
          array({ id: "sma", title: "SMA", powerW: 3000, ratedPowerW: 4000 }),
        ],
        config: {
          ...DEFAULT_CURTAILMENT_CONFIG,
          enabled: true,
          strategy: "soft-ceiling",
        },
      }),
    );

    expect(plan.decisions[0]).toMatchObject({
      action: "release",
      commandPercent: 100,
    });
    // The modulating array still takes the band's ceiling.
    expect(plan.decisions[1]).toMatchObject({ limitPercent: 70 });
  });
});
