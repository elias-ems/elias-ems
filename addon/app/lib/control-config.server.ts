import {
  type ControlConfig,
  DEFAULT_CONTROL_CONFIG,
  normalizeControlConfig,
  REMOVED_STRATEGIES,
} from "./control";
import { appendDiagnostic } from "./diagnostics.server";
import { readJson, writeJson } from "./store.server";

const FILE_NAME = "control.json";

export async function readControlConfig(): Promise<ControlConfig> {
  const stored = await readJson<Partial<ControlConfig>>(
    FILE_NAME,
    DEFAULT_CONTROL_CONFIG,
  );
  const config = normalizeControlConfig(stored);
  const removed: unknown = stored?.strategy;
  if (typeof removed === "string" && REMOVED_STRATEGIES.has(removed)) {
    // Written back at once so this is said once, not on every read: the
    // strategy no longer exists, and control stays off until someone picks
    // one of the registered strategies and writes the automation it needs.
    await saveControlConfig(config);
    appendDiagnostic(
      "battery-control",
      "warn",
      `The ${removed} strategy has been removed, so battery control was switched off. Choose Evening target or HiGHS under Settings → Battery control; both publish balance commands, which the battery's automation has to handle.`,
    );
  }
  return config;
}

export async function saveControlConfig(config: ControlConfig): Promise<void> {
  await writeJson(FILE_NAME, config);
}
