import type { Command } from "../../../../engine/src/types.ts";
import { evening } from "../charge-evening.ts";
import type { Strategy } from "./types.ts";

/**
 * The original planner: native self-consumption with a charge ceiling (and an
 * AC output ceiling where the battery can limit discharge), searched so the
 * battery reaches its maximum charge by the evening deadline even with less
 * solar than forecast.
 */
export const eveningTarget: Strategy<"evening-target"> = {
  id: "evening-target",
  label: "Evening target",
  description:
    "Plan with solar forecasts and prices, aiming for the battery's maximum charge by 18:00 while allowing for 20% less solar than forecast. Publishes balance commands with a maximum charge power and, where supported, an AC output limit, so the battery stays in native self-consumption.",
  supportedModes: ["balance"],
  needsDeadline: true,
  async plan(snapshot) {
    const plan = await evening(snapshot, snapshot.settings);
    const commands: Command[] = plan.points.map((p) => ({
      start: p.start,
      end: p.end,
      mode: "balance",
      chargeLimitW: p.limitW,
      dischargeLimitW: p.dischargeLimitW ?? snapshot.model.dischargeW,
    }));
    return {
      commands,
      plan,
      status: `${plan.target.requestedSoc}% by deadline; reachable nominal/reduced-solar ${plan.target.reachableSoc.map((s) => s.toFixed(1)).join(" / ")}%`,
      notes: [plan.reason],
      details: {
        target: plan.target,
        searchObjective: plan.searchObjective,
        spikeBufferKwh: plan.spikeBufferKwh,
        bufferTargetSoc: plan.bufferTargetSoc,
        bufferPenalty: plan.bufferPenalty,
      },
    };
  },
};
