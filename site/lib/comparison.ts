import { batteryCapabilities } from "../../addon/app/lib/strategies/capabilities.ts";
import {
  type Capabilities,
  engineInput,
  type PlanningSnapshot,
  STRATEGY_REGISTRY,
  type StrategyResult,
  scoreCommands,
} from "../../addon/app/lib/strategies/index.ts";
import { solve } from "../../engine/src/solve.ts";
import type { Input, Mode } from "../../engine/src/types.ts";
import { type PlannerDataset, parseDataset } from "./planner.ts";

export type ComparisonOptions = {
  /**
   * `battery`: the modes ticked for the exported battery, which is what the
   * add-on planned with. `balance`: balance with boundaries only. `expanded`:
   * all four modes with grid charging and export, whatever the battery allows.
   */
  capabilities: "battery" | "balance" | "expanded";
  /** The setpoint step `expanded` assumes; `battery` uses the battery's own. */
  setpointStepW: number;
  timeLimitSeconds: number;
};

const MODES: Mode[] = ["balance", "hold", "charge", "discharge"];

/**
 * The exported battery's control modes and power step, when the export
 * carries them: exports from before per-battery modes, and the presets, do not.
 */
export function exportedBattery(
  dataset: Pick<PlannerDataset, "devices">,
): { controlModes: Mode[]; powerStepW: number } | undefined {
  const devices = dataset.devices as
    | { battery?: { controlModes?: unknown; powerStepW?: unknown } }
    | undefined;
  const battery = devices?.battery;
  if (
    !Array.isArray(battery?.controlModes) ||
    !battery.controlModes.every((mode) => MODES.includes(mode)) ||
    typeof battery.powerStepW !== "number" ||
    !(battery.powerStepW > 0)
  )
    return undefined;
  return {
    controlModes: battery.controlModes,
    powerStepW: battery.powerStepW,
  };
}

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

export function sandboxCapabilities(
  options: ComparisonOptions,
  dataset: Pick<PlannerDataset, "devices">,
): Capabilities {
  if (options.capabilities === "battery") {
    const battery = exportedBattery(dataset);
    if (!battery)
      throw new Error(
        "This export does not record the battery's control modes; choose balance or expanded.",
      );
    return batteryCapabilities(battery);
  }
  return options.capabilities === "expanded"
    ? {
        modes: MODES,
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
  const capabilities = sandboxCapabilities(options, dataset);
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
