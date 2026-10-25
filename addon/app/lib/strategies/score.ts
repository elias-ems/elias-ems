import { evaluate } from "../../../../engine/src/physics.ts";
import type { Command, Input } from "../../../../engine/src/types.ts";
import { type ChargePlan, deviceLimit } from "../charge-plan.ts";
import type { Capabilities, PlanningSnapshot } from "./types.ts";

/** The engine input a snapshot describes, under the given capabilities. */
export function engineInput(
  snapshot: PlanningSnapshot,
  capabilities: Capabilities,
  timeLimitSeconds = 30,
): Input {
  return {
    model: snapshot.model,
    slots: snapshot.slots,
    solarHaircut: snapshot.settings.solarHaircut,
    capabilities,
    timeLimitSeconds,
  };
}

/**
 * The one scoring rule every strategy is judged by: the engine's physical
 * replay of the commands, under the forecast and under reduced solar. A
 * strategy's own claimed cost is never used — each has its own internal
 * objective, and comparing those would compare preferences, not outcomes.
 *
 * `meanCost` is what HiGHS minimises and what a gym should rank by; it counts
 * import cost, export revenue and wear, and nothing for the energy left in the
 * battery at the end, so compare `finalSoc` alongside it.
 *
 * `excess` replays the same commands with solar raised by the same margin. It
 * is reported only and stays out of `meanCost`: no strategy plans for it, so
 * counting it would rank strategies on a scenario HiGHS never optimised.
 */
export function scoreCommands(
  snapshot: PlanningSnapshot,
  commands: Command[],
  capabilities: Capabilities,
) {
  const input = engineInput(snapshot, capabilities);
  const scenarios = [0, input.solarHaircut].map((haircut) =>
    evaluate(input, commands, haircut),
  );
  return {
    scenarios,
    excess: evaluate(input, commands, -input.solarHaircut),
    meanCost:
      scenarios.reduce((sum, scenario) => sum + scenario.cost, 0) /
      scenarios.length,
  };
}

/** The device's widest balance boundaries: the battery left to its own control. */
export function widestBalance(model: Input["model"]) {
  return {
    mode: "balance" as const,
    chargeLimitW: deviceLimit(model.maxW, model),
    dischargeLimitW:
      model.dischargeStepW === undefined
        ? model.dischargeW
        : deviceLimit(model.dischargeW, {
            minW: model.dischargeMinW ?? 0,
            maxW: model.dischargeW,
            stepW: model.dischargeStepW,
          }),
  };
}

/**
 * The unrestricted baseline every strategy is drawn against: widest balance in
 * every interval, replayed by the engine at nominal solar. One definition, so
 * the plan card and the sandbox's chart show the same battery left alone
 * whichever strategy planned.
 */
export function baselineReplay(input: Input) {
  const widest = widestBalance(input.model);
  return evaluate(
    { ...input, capabilities: { ...input.capabilities, modes: ["balance"] } },
    input.slots.map((slot) => ({
      start: slot.start,
      end: slot.end,
      ...widest,
    })),
  );
}

/**
 * A strategy's replayed nominal scenario in the shape the dashboard's plan
 * card draws, beside the unrestricted baseline.
 */
export function planFromReplay(
  input: Input,
  nominal: ReturnType<typeof evaluate>,
  plan: Pick<ChargePlan, "terminalReserveKwh" | "reason">,
): ChargePlan {
  const baseline = baselineReplay(input);
  return {
    points: nominal.points.map((p, i) => ({
      ...input.slots[i],
      generatedSolarW: p.generatedSolarW,
      curtailedW: p.curtailedW,
      limitW: p.chargeLimitW,
      dischargeLimitW: p.dischargeLimitW,
      mode: p.mode,
      ...(p.setpointW === undefined ? {} : { setpointW: p.setpointW }),
      chargeW: p.chargeW,
      dischargeW: p.dischargeW,
      soc: p.soc,
      baselineSoc: baseline.points[i].soc,
    })),
    cost: nominal.cost,
    baselineCost: baseline.cost,
    ...plan,
  };
}
