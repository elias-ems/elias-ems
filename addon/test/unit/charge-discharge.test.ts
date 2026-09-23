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
  it("keeps a low morning battery available for spikes while replenishing its buffer", {
    timeout: 30_000,
  }, async () => {
    // Screenshot-shaped forecast: nominal solar exceeds demand at 08:35,
    // but the reduced-solar scenario has a small deficit. Cheap solar follows.
    const morning = Date.parse("2026-09-23T08:35:00Z");
    const end = Date.parse("2026-09-23T18:00:00Z");
    const slots: EveningData["slots"] = [];
    for (let t = morning; t < end; ) {
      const next = Math.min(Math.ceil((t + 1) / 900_000) * 900_000, end);
      const hour = new Date(t).getUTCHours();
      const solarW =
        hour === 8 ? 436 : hour === 9 ? 999 : hour === 10 ? 1845 : 4000;
      const loadW =
        hour === 8 ? 386 : hour === 9 ? 632 : hour === 10 ? 1222 : 1300;
      const buy =
        hour === 8 ? 0.3773 : hour === 9 ? 0.32 : hour === 10 ? 0.28 : 0.2;
      slots.push({
        start: t,
        end: next,
        solarW,
        loadW,
        buy,
        sell: buy - 0.17,
        estimatedPrice: false,
      });
      t = next;
    }
    const sample = { ...data, model: { ...data.model, soc: 7 }, slots };
    const config = { ...settings, deadline: new Date(end).toISOString() };
    const without = await evening(sample, config);
    const withBuffer = await evening(sample, {
      ...config,
      spikeBufferKwh: 0.54,
    });
    expect(withBuffer.bufferTargetSoc).toBe(20);
    expect(withBuffer.points[0].dischargeLimitW).toBe(2000);
    expect(withBuffer.points[0].dischargeW).toBe(0);
    expect(withBuffer.points[5].soc).toBeGreaterThan(without.points[5].soc);

    const current = withBuffer.points[0];
    const energy = (sample.model.capacityKwh * sample.model.soc) / 100;
    const spike = simulateCharge(
      { ...current, end: morning + 60_000, loadW: current.loadW + 2000 },
      energy,
      current.limitW,
      sample.model,
      false,
      current.dischargeLimitW,
    );
    expect(spike.dischargeW).toBeCloseTo(1950);
    expect(spike.energy).toBeLessThan(energy);
    expect(spike.energy).toBeGreaterThanOrEqual(
      (sample.model.capacityKwh * sample.model.minSoc) / 100,
    );

    // The buffer penalty is measured on the unrestricted reference, so it
    // cannot reward a plan for holding back discharge. The actual schedule
    // still has to meet the evening target under reduced solar.
    const reduced = replay(
      sample,
      withBuffer.points.map((p) => p.limitW),
      config,
      0.2,
      withBuffer.points.map((p) => p.dischargeLimitW ?? NaN),
    );
    expect(reduced.points[0].dischargeW).toBeGreaterThan(0);
    expect(reduced.deadlineSoc).toBeCloseTo(95);
    expect(reduced.points.every((p) => p.soc >= 5 - 1e-7)).toBe(true);
  });
  it("saves a small battery overnight and spends it during the expensive morning", async () => {
    // Keep the default daytime buffer enabled: it must not defeat economical
    // overnight withholding or morning discharge.
    const plan = await evening(data, { ...settings, spikeBufferKwh: 0.54 });
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
