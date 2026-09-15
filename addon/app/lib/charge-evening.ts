import type { ChargeInterval, ChargeModel } from "./charge-plan.ts";
export type EveningData = {
  slots: ChargeInterval[];
  model: ChargeModel;
  terminalReserveKwh: number;
};
export type EveningSettings = {
  deadline: string;
  targetSoc: number;
  solarHaircut: number;
  switchCost: number;
  passes: number;
  spikeBufferKwh?: number;
};

import { deviceLimit, simulateCharge } from "./charge-plan.ts";

export function replay(
  data: EveningData,
  limits: number[],
  settings: EveningSettings,
  haircut = 0,
) {
  let energy = (data.model.capacityKwh * data.model.soc) / 100;
  let cost = 0;
  let deadlineEnergy: number | undefined;
  let switches = 0;
  let gridImportKwh = 0;
  let stepped = false;
  const points = data.slots.map((original, i) => {
    const slot = {
      ...original,
      solarW: original.solarW * (1 - haircut),
      curtailment: original.curtailment
        ? {
            ...original.curtailment,
            fixedW: original.curtailment.fixedW * (1 - haircut),
            fixedArrays: original.curtailment.fixedArrays?.map((array) => ({
              ...array,
              availableW: array.availableW * (1 - haircut),
            })),
            modulatingArrays: original.curtailment.modulatingArrays?.map(
              (array) => ({
                ...array,
                availableW: array.availableW * (1 - haircut),
              }),
            ),
            availableW: original.curtailment.availableW * (1 - haircut),
          }
        : undefined,
    };
    const next = simulateCharge(slot, energy, limits[i], data.model, stepped);
    stepped = next.stepped;
    energy = next.energy;
    cost += next.cost;
    if (i && limits[i] !== limits[i - 1]) switches++;
    gridImportKwh +=
      (Math.max(0, slot.loadW - next.solarW - next.dischargeW) *
        (slot.end - slot.start)) /
      3600000 /
      1000;
    if (slot.end === Date.parse(settings.deadline)) deadlineEnergy = energy;
    return {
      ...original,
      generatedSolarW: next.solarW,
      curtailedW: next.curtailedW,
      limitW: limits[i],
      chargeW: next.chargeW,
      dischargeW: next.dischargeW,
      soc: (energy / data.model.capacityKwh) * 100,
    };
  });
  if (deadlineEnergy === undefined)
    throw new Error("Deadline must match an interval end inside the dataset");
  return {
    points,
    energyCost: cost,
    switches,
    gridImportKwh,
    deadlineEnergy,
    deadlineSoc: (deadlineEnergy / data.model.capacityKwh) * 100,
    endSoc: (energy / data.model.capacityKwh) * 100,
  };
}

export function validateSettings(data: EveningData, s: EveningSettings) {
  if (
    !Number.isFinite(s.spikeBufferKwh ?? 0.54) ||
    (s.spikeBufferKwh ?? 0.54) < 0 ||
    !Number.isFinite(s.targetSoc) ||
    s.targetSoc < data.model.minSoc ||
    s.targetSoc > data.model.maxSoc ||
    !Number.isFinite(s.solarHaircut) ||
    s.solarHaircut < 0 ||
    s.solarHaircut >= 1 ||
    !Number.isFinite(s.switchCost) ||
    s.switchCost < 0 ||
    !Number.isInteger(s.passes) ||
    s.passes < 1 ||
    s.passes > 20
  )
    throw new Error("Invalid evening experiment settings");
  if (!data.slots.some((slot) => slot.end === Date.parse(s.deadline)))
    throw new Error("Deadline must match an interval end inside the dataset");
}

// Feasible coordinate search, not a claim of global optimality. Start with
// maximum acceptance; every accepted move preserves reachable evening energy
// in both nominal and reduced-solar scenarios. Exact simulation avoids SoC bins.
export async function evening(data: EveningData, settings: EveningSettings) {
  validateSettings(data, settings);
  const m = data.model;
  if (
    !Number.isFinite(m.stepW) ||
    m.stepW <= 0 ||
    !Number.isFinite(m.minW) ||
    !Number.isFinite(m.maxW) ||
    m.minW < 0 ||
    m.maxW < m.minW
  )
    throw new Error("Invalid or excessive device steps");
  const max = deviceLimit(m.maxW, m);
  const limits = data.slots.map(() => max);
  const haircuts = [0, settings.solarHaircut];
  const target = (m.capacityKwh * settings.targetSoc) / 100;
  const required = haircuts.map((h) =>
    Math.min(target, replay(data, limits, settings, h).deadlineEnergy),
  );
  const buffer = Math.min(
    settings.spikeBufferKwh ?? 0.54,
    (m.capacityKwh * (m.maxSoc - m.minSoc)) / 100,
  );
  const bufferTarget = (m.capacityKwh * m.minSoc) / 100 + buffer;
  // Soft holding cost: price each kWh of missing daytime buffer per hour at
  // the import tariff. This is an explicit reserve preference, not energy cost
  // or a calibrated probability of a spike. Never restrict native discharge.
  const bufferPenalty = (points: ReturnType<typeof replay>["points"]) =>
    points.reduce(
      (sum, p) =>
        sum +
        (p.solarW > 0 && p.end <= Date.parse(settings.deadline)
          ? (Math.max(0, bufferTarget - (p.soc * m.capacityKwh) / 100) *
              Math.max(0, p.buy) *
              (p.end - p.start)) /
            3600000
          : 0),
      0,
    );
  const evaluate = (candidate: number[]) => {
    const runs = haircuts.map((h) => replay(data, candidate, settings, h));
    if (runs.some((r, i) => r.deadlineEnergy < required[i] - 1e-8))
      return Infinity;
    // Import costs price expected household demand along the way. The terminal
    // reserve evaluator remains in the gym report for comparison with reference.
    return (
      runs.reduce(
        (sum, r) =>
          sum +
          r.energyCost +
          bufferPenalty(r.points) +
          Math.max(
            0,
            (m.capacityKwh * m.minSoc) / 100 +
              Math.min(
                data.terminalReserveKwh,
                (m.capacityKwh * (m.maxSoc - m.minSoc)) / 100,
              ) -
              (r.endSoc * m.capacityKwh) / 100,
          ) *
            Math.max(0, ...data.slots.map((s) => s.buy)) *
            m.efficiency,
        0,
      ) /
        runs.length +
      settings.switchCost * runs[0].switches
    );
  };
  let best = evaluate(limits);
  const steps = Math.min(40, Math.ceil((max - m.minW) / m.stepW));
  const choices = [
    ...new Set(
      Array.from({ length: steps + 1 }, (_, i) =>
        deviceLimit(m.minW + ((max - m.minW) * i) / Math.max(1, steps), m),
      ),
    ),
  ];
  if (choices.length > 2001)
    throw new Error("Too many device steps for evening search");
  for (let pass = 0; pass < settings.passes; pass++) {
    let changed = false;
    // Block moves let equally priced adjacent slots adopt one stable ceiling.
    for (const size of [4, 1]) {
      for (let start = 0; start < limits.length; start += size) {
        let selected = limits.slice();
        for (const w of choices) {
          const candidate = limits.slice();
          candidate.fill(w, start, Math.min(start + size, limits.length));
          const value = evaluate(candidate);
          if (value < best - 1e-9) {
            best = value;
            selected = candidate;
            changed = true;
          }
        }
        limits.splice(0, limits.length, ...selected);
        if (start % 8 === 0)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!changed) break;
  }
  const run = replay(data, limits, settings);
  const baseline = replay(
    data,
    data.slots.map(() => max),
    settings,
  );
  return {
    points: run.points.map((p, i) => ({
      ...p,
      baselineSoc: baseline.points[i].soc,
    })),
    cost: run.energyCost,
    baselineCost: baseline.energyCost,
    terminalReserveKwh: data.terminalReserveKwh,
    reason: "Evening target with reduced-solar feasibility and switching cost",
    target: {
      requestedSoc: settings.targetSoc,
      reachableSoc: required.map((e) => (e / m.capacityKwh) * 100),
      deadline: settings.deadline,
    },
    searchObjective: best,
    spikeBufferKwh: buffer,
    bufferTargetSoc: (bufferTarget / m.capacityKwh) * 100,
    bufferPenalty: bufferPenalty(run.points),
  };
}
