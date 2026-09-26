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
  dischargeLimits?: number[],
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
    const next = simulateCharge(
      slot,
      energy,
      limits[i],
      data.model,
      stepped,
      dischargeLimits?.[i],
    );
    stepped = next.stepped;
    energy = next.energy;
    cost += next.cost;
    if (i && limits[i] !== limits[i - 1]) switches++;
    if (i && dischargeLimits && dischargeLimits[i] !== dischargeLimits[i - 1])
      switches++;
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
      ...(dischargeLimits ? { dischargeLimitW: dischargeLimits[i] } : {}),
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
  const dischargeModel =
    m.dischargeStepW === undefined
      ? null
      : {
          minW: m.dischargeMinW ?? 0,
          maxW: m.dischargeW,
          stepW: m.dischargeStepW,
        };
  if (
    dischargeModel &&
    (!Object.values(dischargeModel).every(Number.isFinite) ||
      dischargeModel.minW < 0 ||
      dischargeModel.maxW < dischargeModel.minW ||
      dischargeModel.stepW <= 0)
  )
    throw new Error("Invalid discharge device steps");
  // Start with the largest reachable reserve. Allocate discharge to the most
  // expensive intervals first, before optimizing solar acceptance.
  const dischargeLimits = dischargeModel
    ? data.slots.map(() => dischargeModel.minW)
    : undefined;
  const nativeOutput = dischargeModel
    ? data.slots.map(() => deviceLimit(dischargeModel.maxW, dischargeModel))
    : undefined;
  const haircuts = [0, settings.solarHaircut];
  const target = (m.capacityKwh * settings.targetSoc) / 100;
  const required = haircuts.map((h) =>
    Math.min(
      target,
      replay(data, limits, settings, h, dischargeLimits).deadlineEnergy,
    ),
  );
  const buffer = Math.min(
    settings.spikeBufferKwh ?? 0.54,
    (m.capacityKwh * (m.maxSoc - m.minSoc)) / 100,
  );
  const bufferTarget = (m.capacityKwh * m.minSoc) / 100 + buffer;
  // Prefer earlier replenishment of the spike buffer, priced per missing kWh
  // per hour. Evaluate it with unrestricted discharge: an output restriction
  // must not earn a better buffer score by preventing use of that same buffer.
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
  // Output moves share a charging schedule. Cache its reference scores so we
  // do not double the simulation work for every candidate output ceiling.
  let bufferReference: { limits: number[]; penalties: number[] } | undefined;
  const chargingBufferPenalties = (candidate: number[]) => {
    if (buffer === 0) return haircuts.map(() => 0);
    if (
      !bufferReference ||
      candidate.some((w, i) => w !== bufferReference?.limits[i])
    ) {
      bufferReference = {
        limits: candidate.slice(),
        penalties: haircuts.map((h) =>
          bufferPenalty(
            replay(data, candidate, settings, h, nativeOutput).points,
          ),
        ),
      };
    }
    return bufferReference.penalties;
  };
  const evaluate = (candidate: number[], output = dischargeLimits) => {
    const runs = haircuts.map((h) =>
      replay(data, candidate, settings, h, output),
    );
    if (runs.some((r, i) => r.deadlineEnergy < required[i] - 1e-8))
      return Infinity;
    const bufferPenalties = output
      ? chargingBufferPenalties(candidate)
      : runs.map((r) => bufferPenalty(r.points));
    // Import costs price expected household demand along the way. The terminal
    // reserve evaluator remains in the gym report for comparison with reference.
    return (
      runs.reduce(
        (sum, r, i) =>
          sum +
          r.energyCost +
          bufferPenalties[i] +
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
    if (dischargeModel && dischargeLimits) {
      const count = Math.min(
        40,
        Math.ceil(
          (dischargeModel.maxW - dischargeModel.minW) / dischargeModel.stepW,
        ),
      );
      const outputChoices = [
        ...new Set(
          Array.from({ length: count + 1 }, (_, i) =>
            deviceLimit(
              dischargeModel.minW +
                ((dischargeModel.maxW - dischargeModel.minW) * i) /
                  Math.max(1, count),
              dischargeModel,
            ),
          ),
        ),
      ];
      for (const size of [1, 4]) {
        const starts = Array.from(
          { length: Math.ceil(limits.length / size) },
          (_, i) => i * size,
        ).sort((a, b) => data.slots[b].buy - data.slots[a].buy);
        for (const start of starts) {
          let selected = dischargeLimits.slice();
          // Prefer headroom when two ceilings have the same objective.
          for (const w of outputChoices.slice().reverse()) {
            const candidate = dischargeLimits.slice();
            candidate.fill(w, start, Math.min(start + size, limits.length));
            const value = evaluate(limits, candidate);
            if (
              value < best - 1e-9 ||
              (Number.isFinite(value) &&
                Math.abs(value - best) <= 1e-9 &&
                candidate.some((v, i) => v > selected[i]) &&
                candidate.every((v, i) => v >= selected[i]))
            ) {
              best = value;
              selected = candidate;
              changed = true;
            }
          }
          dischargeLimits.splice(0, dischargeLimits.length, ...selected);
          if (start % 8 === 0)
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      // A restriction can span several local blocks. Opening only part adds
      // switches, trapping the search even when opening the whole run wins.
      // Try unrestricted output and each constant run against the same costs
      // and both deadline constraints; equal scores favour spike headroom.
      const ranges: [number, number][] = [[0, dischargeLimits.length]];
      for (let start = 0; start < dischargeLimits.length; ) {
        let end = start + 1;
        while (
          end < dischargeLimits.length &&
          dischargeLimits[end] === dischargeLimits[start]
        )
          end++;
        ranges.push([start, end]);
        start = end;
      }
      const maximumOutput = deviceLimit(dischargeModel.maxW, dischargeModel);
      for (const [start, end] of ranges) {
        if (dischargeLimits.slice(start, end).every((w) => w === maximumOutput))
          continue;
        const candidate = dischargeLimits.slice();
        candidate.fill(maximumOutput, start, end);
        const value = evaluate(limits, candidate);
        if (Number.isFinite(value) && value <= best + 1e-9) {
          best = value;
          dischargeLimits.splice(0, dischargeLimits.length, ...candidate);
          changed = true;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
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
  const run = replay(data, limits, settings, 0, dischargeLimits);
  const baseline = replay(
    data,
    data.slots.map(() => max),
    settings,
    0,
    nativeOutput,
  );
  return {
    points: run.points.map((p, i) => ({
      ...p,
      baselineSoc: baseline.points[i].soc,
    })),
    cost: run.energyCost,
    baselineCost: baseline.energyCost,
    terminalReserveKwh: data.terminalReserveKwh,
    reason: dischargeLimits
      ? "Evening target with charge and AC output limits, reserving energy for higher-priced demand"
      : "Evening target with reduced-solar feasibility and switching cost",
    target: {
      requestedSoc: settings.targetSoc,
      reachableSoc: required.map((e) => (e / m.capacityKwh) * 100),
      deadline: settings.deadline,
    },
    searchObjective: best,
    spikeBufferKwh: buffer,
    bufferTargetSoc: (bufferTarget / m.capacityKwh) * 100,
    bufferPenalty: dischargeLimits
      ? chargingBufferPenalties(limits)[0]
      : bufferPenalty(run.points),
  };
}
