import {
  type ControlConfig,
  DEFAULT_CONTROL_CONFIG,
  normalizeControlConfig,
  REMOVED_STRATEGIES,
} from "./control";
import { appendDiagnostic } from "./diagnostics.server";
import { readJson, writeJson } from "./store.server";

const FILE_NAME = "control.json";

/**
 * The removed-strategy migration in flight or done, per data directory. At boot
 * the planning loop, the curtailment loop and the first page load all read
 * this file at once, and every one of them sees the removed id; without this
 * each wrote the migration back and logged it.
 */
const migrations = new Map<string, Promise<void>>();

export async function readControlConfig(): Promise<ControlConfig> {
  const stored = await readJson<Partial<ControlConfig>>(
    FILE_NAME,
    DEFAULT_CONTROL_CONFIG,
  );
  const config = normalizeControlConfig(stored);
  const removed: unknown = stored?.strategy;
  if (typeof removed === "string" && REMOVED_STRATEGIES.has(removed)) {
    // Written back so this is said once, not on every read: the strategy no
    // longer exists, and control stays off until someone picks one of the
    // registered strategies and writes the automation it needs.
    const key = process.env.DATA_DIR ?? "";
    let migration = migrations.get(key);
    if (!migration) {
      const started = saveControlConfig(config).then(() => {
        appendDiagnostic(
          "battery-control",
          "warn",
          `The ${removed} strategy has been removed, so battery control was switched off. Choose Evening target or HiGHS under Settings → Battery control; both publish balance commands, which the battery's automation has to handle.`,
        );
      });
      // A failed write is retried by the next read rather than remembered.
      started.catch(() => migrations.delete(key));
      migrations.set(key, started);
      migration = started;
    }
    await migration;
  }
  return config;
}

export async function saveControlConfig(config: ControlConfig): Promise<void> {
  await writeJson(FILE_NAME, config);
}
