import { evaluate } from "../../../../engine/src/physics.ts";
import type { Command, Input } from "../../../../engine/src/types.ts";
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
