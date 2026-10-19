/**
 * Every battery control strategy, in the order Settings lists them. Adding one
 * is a module implementing `Strategy` and a line here: Settings, the planning
 * loop, the Planner sandbox and the gym all read this list.
 */
import { eveningTarget } from "./evening-target.ts";
import { highs } from "./highs.ts";
import type { Strategy } from "./types.ts";

export const STRATEGY_REGISTRY = [eveningTarget, highs] as const;

export type StrategyId = (typeof STRATEGY_REGISTRY)[number]["id"];

export function strategyById(id: StrategyId): Strategy<StrategyId> {
  const strategy = STRATEGY_REGISTRY.find((s) => s.id === id);
  if (!strategy) throw new Error(`Unknown strategy: ${id}`);
  return strategy;
}

export { engineInput, scoreCommands } from "./score.ts";
export type * from "./types.ts";
