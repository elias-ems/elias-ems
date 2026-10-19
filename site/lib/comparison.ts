import {
  type Capabilities,
  engineInput,
  type PlanningSnapshot,
  STRATEGY_REGISTRY,
  type StrategyResult,
  scoreCommands,
} from "../../addon/app/lib/strategies/index.ts";
import { solve } from "../../engine/src/solve.ts";
import type { Input } from "../../engine/src/types.ts";
import { parseDataset } from "./planner.ts";

export type ComparisonOptions = {
  expanded: boolean;
  setpointStepW: number;
  timeLimitSeconds: number;
};

/** One registered strategy's outcome on the imported snapshot. */
export type StrategyRun = {
  id: string;
  label: string;
  runtimeMs: number;
  result?: StrategyResult;
  /** The shared physical replay: nominal, then reduced solar. */
  scenarios?: ReturnType<typeof scoreCommands>["scenarios"];
  /** The same commands replayed with more solar than forecast; not in `meanCost`. */
  excess?: ReturnType<typeof scoreCommands>["excess"];
  meanCost?: number;
  error?: string;
};

export function sandboxCapabilities(options: ComparisonOptions): Capabilities {
  return options.expanded
    ? {
        modes: ["balance", "hold", "charge", "discharge"],
        gridCharging: true,
        batteryExport: true,
        setpointStepW: options.setpointStepW,
      }
    : { modes: ["balance"], gridCharging: false, batteryExport: false };
}

/**
 * Worker-only orchestration: every strategy in the registry, on the same
 * snapshot and capabilities, scored by the same replay. A strategy that fails
 * on this snapshot is reported beside the others rather than hiding them.
 * Snapshot v1 stays untouched.
 */
export async function compare(
  value: unknown,
  options: ComparisonOptions,
  wasmUrl?: string,
) {
  const dataset = parseDataset(value);
  const snapshot: PlanningSnapshot = {
    model: dataset.model,
    slots: dataset.slots,
    terminalReserveKwh: dataset.terminalReserveKwh,
    settings: dataset.settings,
  };
  const capabilities = sandboxCapabilities(options);
  const input: Input = engineInput(
    snapshot,
    capabilities,
    options.timeLimitSeconds,
  );
  const runs: StrategyRun[] = [];
  for (const strategy of STRATEGY_REGISTRY) {
    const started = performance.now();
    try {
      const result = await strategy.plan(snapshot, {
        capabilities,
        timeLimitSeconds: options.timeLimitSeconds,
        solveHighs: (engine) => solve(engine, wasmUrl),
      });
      const score = scoreCommands(snapshot, result.commands, capabilities);
      runs.push({
        id: strategy.id,
        label: strategy.label,
        runtimeMs: performance.now() - started,
        result,
        scenarios: score.scenarios,
        excess: score.excess,
        meanCost: score.meanCost,
      });
    } catch (error) {
      runs.push({
        id: strategy.id,
        label: strategy.label,
        runtimeMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { input, runs };
}
