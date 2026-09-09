/** Pure model: only the charge ceiling is controllable. Discharge follows load. */
export type ChargeInterval = {
  start: number;
  end: number;
  solarW: number;
  loadW: number;
  buy: number;
  sell: number;
  estimatedPrice: boolean;
  /** Ideal threshold curtailment: surplus above battery acceptance is discarded. */
  curtailExport?: boolean;
};
export type ChargeModel = {
  capacityKwh: number;
  minSoc: number;
  maxSoc: number;
  soc: number;
  minW: number;
  maxW: number;
  stepW: number;
  dischargeW: number;
  efficiency: number;
  wearPerKwh: number;
};
export type ChargePlanPoint = ChargeInterval & {
  limitW: number;
  chargeW: number;
  dischargeW: number;
  soc: number;
  baselineSoc: number;
};
export type ChargePlan = {
  points: ChargePlanPoint[];
  cost: number;
  baselineCost: number;
  terminalReserveKwh: number;
  reason: string;
};

export function deviceLimit(
  watts: number,
  model: Pick<ChargeModel, "minW" | "maxW" | "stepW">,
): number {
  return Math.max(
    model.minW,
    Math.min(
      model.maxW,
      model.minW +
        Math.floor((watts - model.minW + 1e-7) / model.stepW) * model.stepW,
    ),
  );
}

export function simulateCharge(
  slot: ChargeInterval,
  energy: number,
  limitW: number,
  m: ChargeModel,
) {
  const hours = (slot.end - slot.start) / 3_600_000;
  const floor = (m.capacityKwh * m.minSoc) / 100;
  const ceiling = (m.capacityKwh * m.maxSoc) / 100;
  const surplus = ((slot.solarW - slot.loadW) * hours) / 1000;
  const charge = Math.max(
    0,
    Math.min(
      surplus,
      (limitW * hours) / 1000,
      (ceiling - energy) / m.efficiency,
    ),
  );
  const discharge = Math.max(
    0,
    Math.min(
      -surplus,
      (m.dischargeW * hours) / 1000,
      (energy - floor) * m.efficiency,
    ),
  );
  return {
    energy: energy + charge * m.efficiency - discharge / m.efficiency,
    chargeW: (charge * 1000) / hours,
    dischargeW: (discharge * 1000) / hours,
    cost:
      Math.max(0, -surplus - discharge) * slot.buy -
      (slot.curtailExport ? 0 : Math.max(0, surplus - charge)) * slot.sell +
      charge * m.wearPerKwh,
  };
}

/**
 * Backward dynamic programming with interpolated energy states. The forward
 * replay keeps exact energy: discretization never creates energy or power.
 * Yield between time slices so the live control loop is not blocked.
 */
export async function optimizeCharge(
  slots: ChargeInterval[],
  m: ChargeModel,
  terminalReserveKwh = 0,
): Promise<ChargePlan> {
  const numbers = Object.values(m);
  if (
    !slots.length ||
    slots.length > 384 ||
    numbers.some((v) => !Number.isFinite(v)) ||
    m.capacityKwh <= 0 ||
    m.minSoc < 0 ||
    m.maxSoc > 100 ||
    m.maxSoc <= m.minSoc ||
    m.soc < 0 ||
    m.soc > 100 ||
    m.minW < 0 ||
    m.maxW < m.minW ||
    m.stepW <= 0 ||
    m.dischargeW <= 0 ||
    m.efficiency <= 0 ||
    m.efficiency > 1 ||
    m.wearPerKwh < 0 ||
    !Number.isFinite(terminalReserveKwh) ||
    terminalReserveKwh < 0
  )
    throw new Error("Invalid battery planning inputs.");
  slots.forEach((s, i) => {
    if (
      [s.start, s.end, s.solarW, s.loadW, s.buy, s.sell].some(
        (v) => !Number.isFinite(v),
      ) ||
      s.end <= s.start ||
      s.solarW < 0 ||
      s.loadW < 0 ||
      (i > 0 && s.start !== slots[i - 1].end)
    )
      throw new Error("Planning intervals must be finite and contiguous.");
  });
  const floor = (m.capacityKwh * m.minSoc) / 100;
  const ceiling = (m.capacityKwh * m.maxSoc) / 100;
  // Include out-of-window live SoC without inventing a charge/discharge to the boundary.
  const low = Math.min(floor, (m.capacityKwh * m.soc) / 100);
  const high = Math.max(ceiling, (m.capacityKwh * m.soc) / 100);
  const count = 240;
  const width = (high - low) / count;
  const limits = [
    ...new Set(
      Array.from({ length: 25 }, (_, i) =>
        deviceLimit(m.minW + ((m.maxW - m.minW) * i) / 24, m),
      ),
    ),
  ].reverse();
  const reserve = Math.min(ceiling - floor, terminalReserveKwh);
  const reservePrice = Math.max(0, ...slots.map((s) => s.buy)) * m.efficiency;
  const values: Float64Array[] = new Array(slots.length + 1);
  values[slots.length] = Float64Array.from(
    { length: count + 1 },
    (_, j) => Math.max(0, floor + reserve - (low + j * width)) * reservePrice,
  );
  const future = (row: Float64Array, energy: number) => {
    const position = Math.max(0, Math.min(count, (energy - low) / width));
    const j = Math.min(count - 1, Math.floor(position));
    return row[j] + (row[j + 1] - row[j]) * (position - j);
  };
  const choose = (slot: ChargeInterval, energy: number, row: Float64Array) => {
    let best = Infinity;
    let selected = limits[0];
    for (const limit of limits) {
      const next = simulateCharge(slot, energy, limit, m);
      const score = next.cost + future(row, next.energy);
      if (score < best - 1e-9) {
        best = score;
        selected = limit;
      }
    }
    return { best, selected };
  };
  for (let i = slots.length - 1; i >= 0; i--) {
    values[i] = Float64Array.from(
      { length: count + 1 },
      (_, j) => choose(slots[i], low + j * width, values[i + 1]).best,
    );
    if (i % 8 === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  let energy = (m.capacityKwh * m.soc) / 100;
  let baseline = energy;
  let cost = 0;
  let baselineCost = 0;
  const points = slots.map((slot, i) => {
    const { selected } = choose(slot, energy, values[i + 1]);
    const next = simulateCharge(slot, energy, selected, m);
    const original = simulateCharge(slot, baseline, limits[0], m);
    energy = next.energy;
    baseline = original.energy;
    cost += next.cost;
    baselineCost += original.cost;
    return {
      ...slot,
      limitW: selected,
      chargeW: next.chargeW,
      dischargeW: next.dischargeW,
      soc: (energy / m.capacityKwh) * 100,
      baselineSoc: (baseline / m.capacityKwh) * 100,
    };
  });
  // A coarse value grid can slightly mis-rank a policy near an energy boundary.
  // Keep the unrestricted baseline if its exact replay has a lower objective.
  const terminalCost = (stored: number) =>
    Math.max(0, floor + reserve - stored) * reservePrice;
  if (
    cost + terminalCost(energy) >
    baselineCost + terminalCost(baseline) + 1e-9
  ) {
    let stored = (m.capacityKwh * m.soc) / 100;
    for (const point of points) {
      const next = simulateCharge(point, stored, limits[0], m);
      stored = next.energy;
      point.limitW = limits[0];
      point.chargeW = next.chargeW;
      point.dischargeW = next.dischargeW;
      point.soc = point.baselineSoc;
    }
    cost = baselineCost;
  }
  const cheaperSurplusLater = slots
    .slice(1)
    .some((s) => s.solarW > s.loadW && s.sell < slots[0].sell);
  return {
    points,
    cost,
    baselineCost,
    terminalReserveKwh: reserve,
    reason:
      points[0].limitW < limits[0]
        ? cheaperSurplusLater
          ? "Slowing charging to leave room for solar with a lower export value later."
          : "Limiting charging based on export value, battery wear and upcoming household demand."
        : "Allowing available surplus to charge the battery for upcoming household use.",
  };
}
