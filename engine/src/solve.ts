import loadHighs from "highs";
import { type Expr, Milp } from "./algebra.ts";
import { evaluate, step } from "./physics.ts";
import { preferBalance, widenBoundaries } from "./relabel.ts";
import { inspectSolution } from "./solver-result.ts";
import type { Command, Input, Mode } from "./types.ts";
import { validate } from "./validate.ts";

/** Internal entry: model construction and synchronous solve belong in a worker. */
export async function solve(input: Input, wasmUrl?: string) {
  validate(input);
  const started = performance.now();
  const highs = await loadHighs(wasmUrl ? { locateFile: () => wasmUrl } : {});
  const a = new Milp();
  const c = (n: number) => a.constant(n);
  const dummy = a.variable(0, 1);
  a.constrain(dummy, "=", 0);
  const m = input.model;
  const discrete = (min: number, max: number, step: number) =>
    a.add(
      c(min / 1000),
      a.scale(
        a.variable(0, Math.floor((max - min + 1e-7) / step), true),
        step / 1000,
      ),
    );
  const controls = input.slots.map(() => {
    const modes = Object.fromEntries(
      (["balance", "hold", "charge", "discharge"] as Mode[]).map((mode) => [
        mode,
        input.capabilities.modes.includes(mode) ? a.variable(0, 1, true) : c(0),
      ]),
    ) as Record<Mode, Expr>;
    a.constrain(a.add(...Object.values(modes)), "=", 1);
    const chargeLimit = discrete(m.minW, m.maxW, m.stepW);
    const dischargeLimit =
      m.dischargeStepW === undefined
        ? c(m.dischargeW / 1000)
        : discrete(m.dischargeMinW ?? 0, m.dischargeW, m.dischargeStepW);
    const increment = input.capabilities.setpointStepW ?? 1;
    const chargeRequest = modes.charge.hi
      ? discrete(0, m.maxW, increment)
      : c(0);
    const dischargeRequest = modes.discharge.hi
      ? discrete(0, m.dischargeW, increment)
      : c(0);
    for (const [request, flag, limit, max] of [
      [chargeRequest, modes.charge, chargeLimit, m.maxW],
      [dischargeRequest, modes.discharge, dischargeLimit, m.dischargeW],
    ] as const) {
      a.constrain(a.add(request, a.scale(flag, -max / 1000)), "<=", 0);
      a.constrain(a.add(request, a.scale(flag, -increment / 1000)), ">=", 0);
      a.constrain(a.add(request, a.scale(limit, -1)), "<=", 0);
    }
    return {
      ...modes,
      chargeLimit,
      dischargeLimit,
      chargeRequest,
      dischargeRequest,
    };
  });
  const floor = (m.capacityKwh * m.minSoc) / 100;
  const ceiling = (m.capacityKwh * m.maxSoc) / 100;
  const energies: Expr[][] = [],
    costs: Expr[] = [];
  const predictions: ReturnType<typeof step<Expr>>[][] = [];
  for (const haircut of [0, input.solarHaircut]) {
    let energy = c((m.capacityKwh * m.soc) / 100),
      stepped = c(0);
    const scenarioEnergies: Expr[] = [];
    const predicted: ReturnType<typeof step<Expr>>[] = [];
    for (let i = 0; i < input.slots.length; i++) {
      const result = step(
        a,
        input,
        input.slots[i],
        energy,
        stepped,
        controls[i],
        haircut,
      );
      energy = a.variable(floor, ceiling);
      a.constrain(a.add(energy, a.scale(result.energy, -1)), "=", 0);
      stepped = result.stepped;
      predicted.push(result);
      costs.push(a.scale(result.cost, 0.5));
      scenarioEnergies.push(energy);
    }
    energies.push(scenarioEnergies);
    predictions.push(predicted);
  }
  const objective = a.add(...costs);
  const statuses: string[] = [];
  const run = (objective: Expr) => {
    const remaining =
      input.timeLimitSeconds - (performance.now() - started) / 1000;
    if (remaining <= 0) return undefined;
    const result = highs.solve(a.lp(objective), {
      output_flag: false,
      time_limit: remaining,
      mip_rel_gap: 0,
      mip_abs_gap: 1e-8,
      threads: 1,
    });
    statuses.push(result.Status);
    const inspected = inspectSolution(a, result);
    return {
      result,
      values: inspected.values,
      feasible: inspected.usable,
      optimal: inspected.optimal,
    };
  };
  const answer = run(objective);
  if (!answer?.feasible)
    return {
      status: statuses.at(-1) ?? "Time limit before solve",
      optimal: false,
      statuses,
      runtimeMs: performance.now() - started,
      commands: undefined,
    };
  const replay = (values: Record<string, number>) => {
    const value = (x: Expr) => a.value(x, values);
    const commands: Command[] = controls.map((u, i) => {
      const mode = (["balance", "hold", "charge", "discharge"] as Mode[]).find(
        (mode) => value(u[mode]) > 0.5,
      );
      if (!mode) throw new Error("Solver did not select a mode");
      const quantize = (v: number, min: number, step: number) =>
        min + Math.round((v - min) / step) * step;
      const boundaries = {
        start: input.slots[i].start,
        end: input.slots[i].end,
        chargeLimitW: quantize(value(u.chargeLimit) * 1000, m.minW, m.stepW),
        dischargeLimitW:
          m.dischargeStepW === undefined
            ? m.dischargeW
            : quantize(
                value(u.dischargeLimit) * 1000,
                m.dischargeMinW ?? 0,
                m.dischargeStepW,
              ),
      };
      if (mode === "balance") return { ...boundaries, mode };
      if (mode === "hold") return { ...boundaries, mode, setpointW: 0 };
      const increment = input.capabilities.setpointStepW ?? 1;
      const request = mode === "charge" ? u.chargeRequest : u.dischargeRequest;
      return {
        ...boundaries,
        mode,
        setpointW:
          Math.round((value(request) * 1000) / increment) *
          increment *
          (mode === "charge" ? 1 : -1),
      };
    });
    const scenarios = [0, input.solarHaircut].map((h) =>
      evaluate(input, commands, h),
    );
    if (
      scenarios.some((s, j) =>
        s.points.some(
          (p, i) =>
            Math.abs((p.soc * m.capacityKwh) / 100 - value(energies[j][i])) >
              2e-5 ||
            Math.abs(p.cost - value(predictions[j][i].cost)) > 2e-5 ||
            Math.abs(
              p.generatedSolarW / 1000 - value(predictions[j][i].generated),
            ) > 2e-5 ||
            Math.abs(p.chargeW / 1000 - value(predictions[j][i].charge)) >
              2e-5 ||
            Math.abs(p.dischargeW / 1000 - value(predictions[j][i].discharge)) >
              2e-5,
        ),
      )
    )
      return undefined;
    return { commands, scenarios };
  };
  let selected = replay(answer.values);
  if (!selected)
    return {
      status:
        "Rejected: solver schedule disagrees with physical replay (including PV threshold ties)",
      optimal: false,
      statuses,
      runtimeMs: performance.now() - started,
      commands: undefined,
    };
  let balancePreference = "Not attempted: cost optimum not proven";
  if (!input.capabilities.modes.includes("balance")) {
    balancePreference = "Not applicable: balance unavailable";
  } else if (input.capabilities.modes.length === 1) {
    balancePreference = "Already balance-only";
  } else if (answer.optimal) {
    // Lexicographic preference, never a monetary reward for choosing a mode.
    // Keep the primary result if the second solve has no usable improvement.
    const tolerance = 1e-8; // Currency units across the complete horizon.
    const bestCost = a.value(objective, answer.values);
    const balanceTime = a.add(
      ...controls.map((u, i) =>
        a.scale(
          u.balance,
          (input.slots[i].end - input.slots[i].start) / 3600000,
        ),
      ),
    );
    a.constrain(objective, "<=", bestCost + tolerance);
    const preferred = run(a.scale(balanceTime, -1));
    balancePreference = "Not proven: retained cost-optimal plan";
    if (
      preferred?.feasible &&
      a.value(objective, preferred.values) <= bestCost + tolerance &&
      a.value(balanceTime, preferred.values) >=
        a.value(balanceTime, answer.values) - 1e-8
    ) {
      const candidate = replay(preferred.values);
      const meanCost = (plan: NonNullable<typeof candidate>) =>
        plan.scenarios.reduce((sum, scenario) => sum + scenario.cost, 0) / 2;
      if (candidate && meanCost(candidate) <= meanCost(selected) + tolerance) {
        selected = candidate;
        balancePreference = preferred.optimal
          ? "Maximum balance time at optimal cost"
          : "Feasible balance preference; maximum not proven";
      }
    }
  }
  if (
    input.capabilities.modes.includes("balance") &&
    input.capabilities.modes.length > 1
  ) {
    // Intervals the solver labelled differently from an identical balance
    // command, including every interval of a plan whose cost is not proven.
    const relabelled = preferBalance(input, selected.commands);
    if (relabelled.relabelled) {
      selected = {
        commands: relabelled.commands,
        scenarios: relabelled.scenarios,
      };
      if (!balancePreference.startsWith("Maximum"))
        balancePreference =
          "Identical intervals relabelled to balance; maximum not proven";
    }
  }
  // Boundaries the forecast never reaches: widen them so real surplus or
  // demand beyond the forecast is still absorbed. Runs for balance-only too.
  const widened = widenBoundaries(input, selected.commands);
  selected = { commands: widened.commands, scenarios: widened.scenarios };
  const optimal = answer.optimal;
  return {
    status: optimal
      ? "Optimal for modeled objective"
      : "Feasible, not proven optimal",
    optimal,
    statuses,
    runtimeMs: performance.now() - started,
    balancePreference,
    ...selected,
  };
}
