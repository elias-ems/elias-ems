import type { Mode } from "../../../../engine/src/types.ts";
import type { Capabilities } from "./types.ts";

/**
 * What a strategy may plan for one battery: the modes its automation can
 * carry out, as ticked in Settings. Shared by the planning loop and the
 * Planner sandbox, so a sandbox run of an export plans under exactly what
 * production did.
 *
 * `balance` is always there. Allowing `charge` implies the battery may charge
 * from the grid, and allowing `discharge` that it may export: a direct setpoint
 * that could only ever be met from solar surplus or house load would be
 * `balance` with extra steps.
 */
export function batteryCapabilities(battery: {
  controlModes: readonly Mode[];
  powerStepW: number;
}): Capabilities {
  const modes: Mode[] = [
    "balance",
    ...battery.controlModes.filter((mode) => mode !== "balance"),
  ];
  return {
    modes,
    gridCharging: modes.includes("charge"),
    batteryExport: modes.includes("discharge"),
    ...(modes.length > 1 ? { setpointStepW: battery.powerStepW } : {}),
  };
}
