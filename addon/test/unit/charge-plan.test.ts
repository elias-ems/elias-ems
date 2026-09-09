import { describe, expect, it } from "vitest";
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
