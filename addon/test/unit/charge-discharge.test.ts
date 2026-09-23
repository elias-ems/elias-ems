import { describe, expect, it } from "vitest";
import {
  type EveningData,
  evening,
  replay,
} from "../../app/lib/charge-evening";
import { simulateCharge } from "../../app/lib/charge-plan";

const start = Date.parse("2026-09-22T00:00:00Z");
const hour = 3_600_000;
const data: EveningData = {
  model: {
    capacityKwh: 3.6,
    minSoc: 5,
    maxSoc: 95,
    soc: 80,
    minW: 0,
    maxW: 2000,
    stepW: 100,
    dischargeW: 2000,
    dischargeMinW: 0,
    dischargeStepW: 100,
    efficiency: 0.95,
    wearPerKwh: 0,
  },
  terminalReserveKwh: 0,
  slots: Array.from({ length: 18 }, (_, i) => ({
    start: start + i * hour,
    end: start + (i + 1) * hour,
    solarW: i >= 9 && i < 17 ? 3000 : 0,
    loadW: i >= 6 && i < 9 ? 900 : 400,
    buy: i >= 6 && i < 9 ? 0.5 : 0.08,
    sell: 0.02,
    estimatedPrice: false,
  })),
};
const settings = {
  deadline: new Date(start + 18 * hour).toISOString(),
  targetSoc: 95,
  solarHaircut: 0.2,
  switchCost: 0.002,
  passes: 4,
  spikeBufferKwh: 0,
};

describe("AC output planning", () => {
  it("saves a small battery overnight and spends it during the expensive morning", async () => {
    const plan = await evening(data, settings);
    const native = replay(
      data,
      data.slots.map(() => 2000),
      settings,
    );
    expect(plan.points[5].soc).toBeGreaterThan(native.points[5].soc + 20);
    expect(
      plan.points.slice(6, 9).reduce((s, p) => s + p.dischargeW, 0),
    ).toBeGreaterThan(
      native.points.slice(6, 9).reduce((s, p) => s + p.dischargeW, 0),
    );
    expect(plan.cost).toBeLessThan(plan.baselineCost);
    for (const haircut of [0, 0.2]) {
      const run = replay(
        data,
        plan.points.map((p) => p.limitW),
        settings,
        haircut,
        plan.points.map((p) => p.dischargeLimitW ?? NaN),
      );
      expect(run.deadlineSoc).toBeCloseTo(95);
      expect(
        run.points.every((p) => p.soc >= 5 - 1e-7 && p.soc <= 95 + 1e-7),
      ).toBe(true);
    }
  });
  it("respects nonzero minima and device steps in both directions", async () => {
    const plan = await evening(
      {
        ...data,
        model: {
          ...data.model,
          dischargeMinW: 75,
          dischargeStepW: 125,
          dischargeW: 1020,
        },
      },
      settings,
    );
    for (const point of plan.points) {
      expect(point.dischargeLimitW).toBeGreaterThanOrEqual(75);
      expect(point.dischargeLimitW).toBeLessThanOrEqual(1020);
      expect(((point.dischargeLimitW ?? NaN) - 75) % 125).toBe(0);
      expect(point.dischargeW).toBeLessThanOrEqual(
        (point.dischargeLimitW ?? NaN) + 1e-7,
      );
    }
  });
  it("does not invent discharge control for existing configurations", async () => {
    const { dischargeMinW: _min, dischargeStepW: _step, ...model } = data.model;
    const plan = await evening({ ...data, model }, settings);
    expect(plan.points.every((p) => p.dischargeLimitW === undefined)).toBe(
      true,
    );
  });
  it("bounds native discharge by demand, output power and the protective floor", () => {
    const slot = { ...data.slots[0], loadW: 1000 };
    expect(
      simulateCharge(slot, 2, 2000, data.model, false, 100).dischargeW,
    ).toBeCloseTo(100);
    expect(
      simulateCharge(slot, 0.18, 2000, data.model, false, 2000).dischargeW,
    ).toBeCloseTo(0);
    expect(
      simulateCharge(
        { ...slot, solarW: 2000 },
        2,
        2000,
        data.model,
        false,
        2000,
      ).dischargeW,
    ).toBe(0);
  });
});
