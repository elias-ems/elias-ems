import { evaluate } from "../../engine/src/physics.ts";
import { solve } from "../../engine/src/solve.ts";
import type { Input } from "../../engine/src/types.ts";
import { parseDataset, runPlanner } from "./planner.ts";
export type ComparisonOptions = {
  expanded: boolean;
  gridCharging: boolean;
  batteryExport: boolean;
  setpointStepW: number;
  priority: "evening-first" | "cost-first";
  shortfallPerKwh: number;
  timeLimitSeconds: number;
};
/** Worker-only orchestration; snapshot v1 stays untouched. */
export async function compare(
  value: unknown,
  options: ComparisonOptions,
  wasmUrl?: string,
) {
  const dataset = parseDataset(value);
  const input: Input = {
    model: dataset.model,
    slots: dataset.slots,
    deadline: Date.parse(dataset.settings.deadline),
    solarHaircut: dataset.settings.solarHaircut,
    terminalReserveKwh: dataset.terminalReserveKwh,
    capabilities: {
      modes: options.expanded
        ? ["balance", "hold", "charge", "discharge"]
        : ["balance"],
      gridCharging: options.expanded && options.gridCharging,
      batteryExport: options.expanded && options.batteryExport,
      ...(options.expanded ? { setpointStepW: options.setpointStepW } : {}),
    },
    objective: {
      priority: options.priority,
      shortfallPerKwh: options.shortfallPerKwh,
    },
    timeLimitSeconds: options.timeLimitSeconds,
  };
  const started = performance.now();
  const legacy = await runPlanner(dataset);
  const legacyRuntimeMs = performance.now() - started;
  const commands = legacy.points.map((p) => ({
    start: p.start,
    end: p.end,
    mode: "balance" as const,
    chargeLimitW: p.limitW,
    dischargeLimitW: p.dischargeLimitW ?? dataset.model.dischargeW,
  }));
  const legacyScenarios = [0, input.solarHaircut].map((h) =>
    evaluate(input, commands, h),
  );
  // Return the original planner even if this snapshot is unsupported by HiGHS.
  try {
    const engine = await solve(input, wasmUrl);
    return {
      legacy,
      legacyRuntimeMs,
      legacyScenarios,
      input,
      engine,
      engineError: "",
    };
  } catch (error) {
    return {
      legacy,
      legacyRuntimeMs,
      legacyScenarios,
      input,
      engine: undefined,
      engineError: error instanceof Error ? error.message : String(error),
    };
  }
}
