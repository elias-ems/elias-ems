import { describe, expect, it } from "vitest";
import { replay } from "../../app/lib/charge-evening";
import {
  type ChargeInterval,
  type ChargeModel,
  deviceLimit,
  optimizeCharge,
  simulateCharge,
} from "../../app/lib/charge-plan";

const model: ChargeModel = {
  capacityKwh: 1,
  minSoc: 0,
  maxSoc: 100,
  soc: 0,
  minW: 0,
  maxW: 1000,
  stepW: 10,
  dischargeW: 1000,
  efficiency: 1,
  wearPerKwh: 0,
};
const slot = (
  i: number,
  solarW: number,
  loadW: number,
  sell: number,
  buy = 0.4,
): ChargeInterval => ({
  start: i * 3_600_000,
  end: (i + 1) * 3_600_000,
  solarW,
  loadW,
  buy,
  sell,
  estimatedPrice: false,
});

describe("native self-consumption charging plan", () => {
  it("soft ceilings allow export independently of the meter target", () => {
    const result = simulateCharge(
      {
        ...slot(0, 3000, 100, 0.02),
        curtailment: {
          fixedW: 0,
          availableW: 3000,
          floorW: 0,
          ceilingW: 2000,
          gridTargetW: 500,
          exportAllowanceW: 0,
        },
      },
      1,
      0,
      model,
    );
    expect(result.solarW).toBe(2000);
    expect(result.curtailedW).toBe(1000);
    expect(result.cost).toBeCloseTo(-0.038);
  });

  it("applies inverter ceilings separately to asymmetric forecasts", () => {
    const result = simulateCharge(
      {
        ...slot(0, 4100, 100, 0.02),
        curtailment: {
          fixedW: 0,
          availableW: 4100,
          floorW: 0,
          gridTargetW: 0,
          exportAllowanceW: 0,
          modulatingArrays: [
            { availableW: 100, floorW: 0, ceilingW: 2000 },
            { availableW: 4000, floorW: 0, ceilingW: 2000 },
          ],
        },
      },
      1,
      0,
      model,
    );
    expect(result.solarW).toBe(2100);
    expect(result.curtailedW).toBe(2000);
  });

  it("reduces forecast availability before applying a fixed step in evening replay", () => {
    const forecast: ChargeInterval = {
      ...slot(0, 4000, 1500, -0.02),
      curtailment: {
        fixedW: 1000,
        availableW: 0,
        floorW: 0,
        gridTargetW: 0,
        exportAllowanceW: 0,
        fixedArrays: [{ availableW: 4000, ceilingW: 1000 }],
      },
    };
    const result = replay(
      { slots: [forecast], model, terminalReserveKwh: 0 },
      [1000],
      {
        deadline: new Date(forecast.end).toISOString(),
        targetSoc: 100,
        solarHaircut: 0.2,
        switchCost: 0,
        passes: 1,
      },
      0.2,
    );
    expect(result.points[0].generatedSolarW).toBe(1000);
    expect(result.points[0].curtailedW).toBe(2200);
    expect(result.gridImportKwh).toBeCloseTo(0.5);
    expect(result.energyCost).toBeCloseTo(0.2);
  });

  it("keeps forecast inputs intact and replays reported curtailment exactly", async () => {
    const forecast: ChargeInterval = {
      ...slot(0, 2500, 500, -0.1),
      curtailment: {
        fixedW: 0,
        availableW: 2500,
        floorW: 0,
        gridTargetW: 0,
        exportAllowanceW: 0,
      },
    };
    const plan = await optimizeCharge([forecast], model);
    const point = plan.points[0];
    const replayed = simulateCharge(point, 0, point.limitW, model);
    expect(point.solarW).toBe(2500);
    expect(point.generatedSolarW).toBe(replayed.solarW);
    expect(point.curtailedW).toBe(replayed.curtailedW);
    expect(point.soc).toBeCloseTo(replayed.energy * 100);
  });
  it("models threshold curtailment without charging a negative-price export penalty", () => {
    const forecast = {
      ...slot(0, 2000, 500, -0.2),
      curtailment: {
        fixedW: 0,
        availableW: 2000,
        floorW: 0,
        gridTargetW: 0,
        exportAllowanceW: 0,
      },
    };
    const result = simulateCharge(forecast, 1, 0, model);
    expect(result.cost).toBe(0);
    expect(result.energy).toBe(1);
    expect(
      simulateCharge({ ...forecast, curtailment: undefined }, 1, 0, model).cost,
    ).toBeCloseTo(0.3);
    const charging = simulateCharge(forecast, 0, 500, model);
    expect(charging.chargeW).toBe(500);
    expect(charging.energy).toBe(0.5);
  });
  it("models targets, floors, fixed generation and price bands", () => {
    const base = {
      ...slot(0, 3000, 500, 0.01),
      curtailment: {
        fixedW: 300,
        availableW: 2700,
        floorW: 600,
        gridTargetW: 100,
        exportAllowanceW: 0,
      },
    };
    // The floor wins over a positive (importing) meter target.
    expect(simulateCharge(base, 1, 0, model).cost).toBeCloseTo(-0.004);
    // Graded export is added to what may cross the meter.
    expect(
      simulateCharge(
        {
          ...base,
          curtailment: { ...base.curtailment, exportAllowanceW: 1000 },
        },
        1,
        0,
        model,
      ).cost,
    ).toBeCloseTo(-0.009);
    // A soft ceiling binds even when the battery could accept more.
    expect(
      simulateCharge(
        {
          ...base,
          curtailment: { ...base.curtailment, ceilingW: 700 },
        },
        0,
        2000,
        model,
      ).chargeW,
    ).toBe(500);
  });
  it("exports valuable morning solar and stores cheaper midday solar for the evening", async () => {
    const plan = await optimizeCharge(
      [slot(0, 1000, 0, 0.2), slot(1, 1000, 0, 0.01), slot(2, 0, 1000, 0.01)],
      model,
    );
    expect(plan.points[0].chargeW).toBe(0);
    expect(plan.points[1].chargeW).toBe(1000);
    expect(plan.points[2].dischargeW).toBe(1000);
    expect(plan.baselineCost - plan.cost).toBeCloseTo(0.19);
  });
  it("charges early when later surplus cannot cover the evening", async () => {
    const plan = await optimizeCharge(
      [slot(0, 1000, 0, 0.2), slot(1, 250, 0, 0.01), slot(2, 0, 1000, 0.01)],
      model,
    );
    expect(plan.points[0].chargeW).toBeGreaterThanOrEqual(740);
    expect(plan.points[0].chargeW).toBeLessThanOrEqual(800);
    expect(plan.points[2].soc).toBeCloseTo(0);
  });
  it("cannot withhold native discharge or force grid charging, even at negative prices", async () => {
    const plan = await optimizeCharge(
      [slot(0, 0, 1000, -0.1, -0.2), slot(1, 0, 1000, 0.1, 1)],
      { ...model, soc: 100 },
    );
    expect(plan.points[0].dischargeW).toBe(1000);
    expect(plan.points.every((p) => p.chargeW === 0)).toBe(true);
    expect(plan.points[1].dischargeW).toBe(0);
  });
  it("retains energy value beyond the published price horizon", async () => {
    const plan = await optimizeCharge([slot(0, 1000, 0, 0.1)], model, 1);
    expect(plan.points[0].soc).toBe(100);
  });
  it("respects energy balance, efficiency, native SoC limits and device steps", async () => {
    const m = {
      ...model,
      capacityKwh: 2,
      minSoc: 10,
      maxSoc: 90,
      soc: 20,
      efficiency: 0.9,
      minW: 50,
      maxW: 975,
      stepW: 50,
    };
    const slots = [
      slot(0, 3000, 500, -0.1),
      slot(1, 3000, 0, 0),
      slot(2, 0, 3000, 0),
    ];
    const plan = await optimizeCharge(slots, m);
    let energy = (m.capacityKwh * m.soc) / 100;
    for (const p of plan.points) {
      expect((p.limitW - m.minW) % m.stepW).toBe(0);
      expect(p.limitW).toBeLessThanOrEqual(m.maxW);
      expect(p.chargeW * p.dischargeW).toBe(0);
      energy +=
        (p.chargeW / 1000) * m.efficiency - p.dischargeW / 1000 / m.efficiency;
      expect(p.soc).toBeCloseTo((energy / m.capacityKwh) * 100);
      expect(p.soc).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(p.soc).toBeLessThanOrEqual(90 + 1e-9);
    }
    expect(deviceLimit(975, m)).toBe(950);
  });
  it("matches exhaustive enumeration on a small exact problem", async () => {
    const m = { ...model, stepW: 500 };
    const slots = [
      slot(0, 1000, 0, 0.15),
      slot(1, 500, 0, -0.1),
      slot(2, 0, 1000, 0),
    ];
    let best = Infinity;
    for (const a of [0, 500, 1000])
      for (const b of [0, 500, 1000]) {
        let e = 0;
        let cost = 0;
        for (const [i, cap] of [a, b, 1000].entries()) {
          const next = simulateCharge(slots[i], e, cap, m);
          e = next.energy;
          cost += next.cost;
        }
        best = Math.min(best, cost);
      }
    expect((await optimizeCharge(slots, m)).cost).toBeCloseTo(best);
  });
  it("rejects gaps and non-finite battery values", async () => {
    await expect(
      optimizeCharge([slot(0, 1, 0, 0), slot(2, 1, 0, 0)], model),
    ).rejects.toThrow("contiguous");
    await expect(
      optimizeCharge([slot(0, 1, 0, 0)], { ...model, soc: NaN }),
    ).rejects.toThrow("Invalid");
  });
  it("bounds computation for a 48-hour plan", async () => {
    const slots = Array.from({ length: 192 }, (_, i) => ({
      ...slot(i, i % 96 > 30 && i % 96 < 65 ? 3000 : 0, 400, 0.1),
      start: i * 900_000,
      end: (i + 1) * 900_000,
    }));
    const start = performance.now();
    const plan = await optimizeCharge(slots, { ...model, capacityKwh: 5 });
    expect(plan.points).toHaveLength(192);
    expect(performance.now() - start).toBeLessThan(4000);
  });
});
