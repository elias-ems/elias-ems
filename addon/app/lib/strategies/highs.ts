import { evaluate } from "../../../../engine/src/physics.ts";
import type { Command } from "../../../../engine/src/types.ts";
import { deviceLimit } from "../charge-plan.ts";
import { engineInput } from "./score.ts";
import type { Strategy } from "./types.ts";

/**
 * The HiGHS mixed-integer planner in `engine/`: minimises the mean cost of the
 * forecast and reduced-solar scenarios (imports minus export revenue plus
 * wear), and at equal cost prefers the battery's own balance mode.
 *
 * It has no evening target and no value for energy left at the end of the
 * horizon, so on its own a plan may finish emptier than Evening target's.
 * Replanning every few minutes moves that horizon along; valuing it properly
 * is open work for the gym.
 */
export const highs: Strategy<"highs"> = {
  id: "highs",
  label: "HiGHS cost optimizer",
  description:
    "Plan with solar forecasts and prices for the lowest expected cost, solved exactly with the HiGHS optimizer and checked against a physical replay. Publishes balance commands with a maximum charge power and, where supported, an AC output limit, so the battery stays in native self-consumption. Has no evening target.",
  supportedModes: ["balance", "hold", "charge", "discharge"],
  needsDeadline: false,
  async plan(snapshot, context) {
    const input = engineInput(
      snapshot,
      context.capabilities,
      context.timeLimitSeconds,
    );
    const result = await context.solveHighs(input);
    if (!result.commands)
      throw new Error(`HiGHS returned no schedule: ${result.status}.`);
    const [nominal] = result.scenarios;
    const m = snapshot.model;
    const baselineCommands: Command[] = snapshot.slots.map((slot) => ({
      start: slot.start,
      end: slot.end,
      mode: "balance",
      chargeLimitW: deviceLimit(m.maxW, m),
      dischargeLimitW:
        m.dischargeStepW === undefined
          ? m.dischargeW
          : deviceLimit(m.dischargeW, {
              minW: m.dischargeMinW ?? 0,
              maxW: m.dischargeW,
              stepW: m.dischargeStepW,
            }),
    }));
    const baseline = evaluate(
      { ...input, capabilities: { ...input.capabilities, modes: ["balance"] } },
      baselineCommands,
    );
    return {
      commands: result.commands,
      plan: {
        points: nominal.points.map((p, i) => ({
          ...snapshot.slots[i],
          generatedSolarW: p.generatedSolarW,
          curtailedW: p.curtailedW,
          limitW: p.chargeLimitW,
          dischargeLimitW: p.dischargeLimitW,
          chargeW: p.chargeW,
          dischargeW: p.dischargeW,
          soc: p.soc,
          baselineSoc: baseline.points[i].soc,
        })),
        cost: nominal.cost,
        baselineCost: baseline.cost,
        terminalReserveKwh: 0,
        reason: `HiGHS: ${result.status}.`,
      },
      status: result.status,
      notes: [result.balancePreference],
      details: {
        optimal: result.optimal,
        statuses: result.statuses,
        runtimeMs: result.runtimeMs,
        balancePreference: result.balancePreference,
      },
    };
  },
};
