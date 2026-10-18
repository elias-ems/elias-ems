import { type Algebra, numeric } from "./algebra.ts";
import type { ChargeInterval, Command, Input } from "./types.ts";
import { validateCommands } from "./validate.ts";

export type Controls<T> = {
  balance: T;
  charge: T;
  discharge: T;
  chargeLimit: T;
  dischargeLimit: T;
  chargeRequest: T;
  dischargeRequest: T;
};

/** AC kW, DC kWh. One interval is a constant forecast, with average power
 * reduced by native SoC protection. Direct control permissions are enforced
 * by a hypothetical local adapter, including when forecasts change. */
export function step<T>(
  a: Algebra<T>,
  input: Input,
  slot: ChargeInterval,
  energy: T,
  stepped: T,
  u: Controls<T>,
  haircut: number,
) {
  const c = (n: number) => a.constant(n);
  const sub = (x: T, y: T) => a.add(x, a.scale(y, -1));
  const positive = (x: T) => a.max(c(0), x);
  const min = (...xs: T[]) => xs.reduce((x, y) => a.min(x, y));
  const m = input.model;
  const h = (slot.end - slot.start) / 3600000;
  const floor = (m.capacityKwh * m.minSoc) / 100;
  const ceiling = (m.capacityKwh * m.maxSoc) / 100;
  const solar = (slot.solarW * (1 - haircut)) / 1000;
  const load = slot.loadW / 1000;
  const room = positive(
    a.scale(sub(c(ceiling), energy), 1 / (h * m.efficiency)),
  );
  const available = positive(a.scale(sub(energy, c(floor)), m.efficiency / h));
  const initialCharge = min(
    u.chargeLimit,
    room,
    a.select(
      u.balance,
      c(Math.max(0, solar - load)),
      a.select(u.charge, u.chargeRequest, c(0)),
    ),
    c(
      input.capabilities.gridCharging
        ? m.maxW / 1000
        : Math.max(0, solar - load),
    ),
  );
  const directDischarge = min(
    u.dischargeLimit,
    available,
    a.select(u.discharge, u.dischargeRequest, c(0)),
    c(
      input.capabilities.batteryExport
        ? m.dischargeW / 1000
        : Math.max(0, load - solar),
    ),
  );
  let generated = c(solar);
  let nextStepped = c(0);
  const pv = slot.curtailment;
  if (pv) {
    const hasSteps = pv.fixedArrays?.some((x) => x.stepW !== undefined);
    if (hasSteps) {
      const trigger = a.threshold(
        a.add(
          c(solar - load + pv.gridTargetW / 1000),
          a.scale(initialCharge, -1),
          directDischarge,
        ),
        Math.max(1e-9, (pv.deadbandW ?? 0) / 1000),
      );
      nextStepped = a.max(stepped, trigger);
    }
    const fixed = pv.fixedArrays
      ? a.add(
          ...pv.fixedArrays.map((x) => {
            const normal = c(
              Math.min(x.availableW * (1 - haircut), x.ceilingW) / 1000,
            );
            return x.stepW === undefined
              ? normal
              : a.select(
                  x.initiallyStepped ? c(1) : nextStepped,
                  c(Math.min(x.availableW * (1 - haircut), x.stepW) / 1000),
                  normal,
                );
          }),
        )
      : c((pv.fixedW * (1 - haircut)) / 1000);
    const wanted = a.add(
      c(load - pv.gridTargetW / 1000 + pv.exportAllowanceW / 1000),
      initialCharge,
      a.scale(directDischarge, -1),
      a.scale(fixed, -1),
    );
    const modulating = pv.modulatingArrays
      ? a.add(
          ...pv.modulatingArrays.map((x) =>
            a.min(
              c((x.availableW * (1 - haircut)) / 1000),
              x.ceilingW !== undefined
                ? c(x.ceilingW / 1000)
                : a.max(
                    c(x.floorW / 1000),
                    a.scale(
                      positive(wanted),
                      pv.availableW > 0 ? x.availableW / pv.availableW : 0,
                    ),
                  ),
            ),
          ),
        )
      : a.min(
          c((pv.availableW * (1 - haircut)) / 1000),
          pv.ceilingW !== undefined
            ? c(pv.ceilingW / 1000)
            : a.max(c(pv.floorW / 1000), wanted),
        );
    generated = a.add(fixed, modulating);
  }
  const surplus = sub(generated, c(load));
  const charge = min(
    u.chargeLimit,
    room,
    a.select(
      u.balance,
      positive(surplus),
      a.select(u.charge, u.chargeRequest, c(0)),
    ),
    input.capabilities.gridCharging ? c(m.maxW / 1000) : positive(surplus),
  );
  const discharge = min(
    u.dischargeLimit,
    available,
    a.select(
      u.balance,
      positive(a.scale(surplus, -1)),
      a.select(u.discharge, u.dischargeRequest, c(0)),
    ),
    input.capabilities.batteryExport
      ? c(m.dischargeW / 1000)
      : positive(a.scale(surplus, -1)),
  );
  const grid = a.add(
    c(load),
    charge,
    a.scale(discharge, -1),
    a.scale(generated, -1),
  );
  const imported = positive(grid);
  const exported = positive(a.scale(grid, -1));
  return {
    energy: a.add(
      energy,
      a.scale(charge, h * m.efficiency),
      a.scale(discharge, -h / m.efficiency),
    ),
    charge,
    discharge,
    generated,
    imported,
    exported,
    stepped: nextStepped,
    cost: a.add(
      a.scale(imported, h * slot.buy),
      a.scale(exported, -h * slot.sell),
      a.scale(charge, h * m.wearPerKwh),
    ),
  };
}
export function evaluate(input: Input, commands: Command[], haircut = 0) {
  if (!Number.isFinite(haircut) || haircut < 0 || haircut >= 1)
    throw new Error("Invalid solar scenario reduction");
  validateCommands(input, commands);
  let energy = (input.model.capacityKwh * input.model.soc) / 100;
  let stepped = 0;
  let cost = 0;
  const points = input.slots.map((slot, i) => {
    const u = commands[i];
    const next = step(
      numeric,
      input,
      slot,
      energy,
      stepped,
      {
        balance: Number(u.mode === "balance"),
        charge: Number(u.mode === "charge"),
        discharge: Number(u.mode === "discharge"),
        chargeLimit: u.chargeLimitW / 1000,
        dischargeLimit: u.dischargeLimitW / 1000,
        chargeRequest: Math.max(0, u.setpointW ?? 0) / 1000,
        dischargeRequest: Math.max(0, -(u.setpointW ?? 0)) / 1000,
      },
      haircut,
    );
    energy = next.energy;
    stepped = next.stepped;
    cost += next.cost;
    const soc = (energy / input.model.capacityKwh) * 100;
    return {
      ...u,
      soc,
      batteryW: (next.charge - next.discharge) * 1000,
      chargeW: next.charge * 1000,
      dischargeW: next.discharge * 1000,
      generatedSolarW: next.generated * 1000,
      curtailedW: Math.max(
        0,
        slot.solarW * (1 - haircut) - next.generated * 1000,
      ),
      importW: next.imported * 1000,
      exportW: next.exported * 1000,
      cost: next.cost,
    };
  });
  return {
    points,
    generatedKwh: points.reduce(
      (sum, p) => sum + (p.generatedSolarW * (p.end - p.start)) / 3_600_000_000,
      0,
    ),
    curtailedKwh: points.reduce(
      (sum, p) => sum + (p.curtailedW * (p.end - p.start)) / 3_600_000_000,
      0,
    ),
    cost,
    finalSoc: (energy / input.model.capacityKwh) * 100,
  };
}
