/**
 * Battery control's shared model: what the settings form edits, what the home
 * page reports, and the validation between them. Pure, so both the server and
 * the browser bundle can have it — the loop itself and reading and writing the
 * config live in the matching `.server` modules, and what the loop logs is
 * `diagnostics.ts`'s shape, not a type of its own.
 */

import { STRATEGY_REGISTRY, type StrategyId } from "./strategies/index.ts";

export type { StrategyId };

export type ControlConfig = {
  enabled: boolean;
  strategy: StrategyId;
  /** How often the loop reconsiders, in seconds. */
  intervalSeconds: number;
};

/**
 * What Optimize charge limits plans with. These were settings once, both on
 * the battery and under Battery control; they are fixed now, and anything
 * still stored under those names is ignored on read and dropped on the next
 * save. Planner exports still carry them, in their `settings` block and in
 * the model's `wearPerKwh`.
 */
export const CHARGE_LIMIT_PLANNING = {
  /** Home Assistant local hour the evening target is aimed at. */
  eveningHour: 18,
  /** Price-currency penalty per change of the charge ceiling. */
  ceilingSwitchCost: 0.002,
  /** Energy the plan prefers to have back early, for daytime spikes, kWh. */
  spikeBufferKwh: 0.54,
  /** How far the solar forecast is reduced for the cautious case, %. */
  solarMarginPercent: 20,
  /** Price-currency wear cost per charged kWh. */
  chargeWearPerKwh: 0.05,
  /** Search passes over the ceiling schedule. */
  passes: 4,
} as const;

/**
 * Settings' view of the strategy registry. Stored as an id so a new strategy
 * is additive: register it in `strategies/index.ts` and it appears here, in
 * the planning loop, in the Planner sandbox and in the gym, with nothing
 * already on disk needing to change.
 */
export const STRATEGIES: Array<{
  id: StrategyId;
  label: string;
  description: string;
}> = STRATEGY_REGISTRY.map(({ id, label, description }) => ({
  id,
  label,
  description,
}));

/**
 * Ids earlier versions stored. `charge-limit` was Evening target under its
 * feature's name and carries straight over. `net-zero-energy` was a live
 * setpoint strategy that no longer exists: its battery automations expect
 * setpoints, so it is not silently swapped for a planner that publishes
 * something else — control comes back switched off, on Evening target.
 */
const RENAMED_STRATEGIES: Record<string, StrategyId> = {
  "charge-limit": "evening-target",
};
export const REMOVED_STRATEGIES = new Set(["net-zero-energy"]);

/**
 * The interval paces the shared control loop, which PV curtailment runs on;
 * the planning strategies keep their own cadence. Five seconds: fast enough to
 * follow a kettle, slow enough not to hammer HA.
 */
export const DEFAULT_CONTROL_CONFIG: ControlConfig = {
  enabled: false,
  strategy: "evening-target",
  intervalSeconds: 5,
};

export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 3600;

export function isStrategyId(value: unknown): value is StrategyId {
  return STRATEGIES.some((strategy) => strategy.id === value);
}

function clampInterval(seconds: number): number {
  return Math.min(
    MAX_INTERVAL_SECONDS,
    Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds)),
  );
}

/**
 * What to make of whatever is on disk. An unknown strategy id means a downgrade
 * or a hand-edited file; falling back beats leaving the loop with nothing to run.
 */
export function normalizeControlConfig(
  stored: Partial<ControlConfig> | null,
): ControlConfig {
  const intervalSeconds = Number(stored?.intervalSeconds);
  const storedStrategy: unknown = stored?.strategy;
  const renamed =
    typeof storedStrategy === "string"
      ? (RENAMED_STRATEGIES[storedStrategy] ?? storedStrategy)
      : storedStrategy;
  const removed =
    typeof storedStrategy === "string" &&
    REMOVED_STRATEGIES.has(storedStrategy);

  return {
    enabled: stored?.enabled === true && !removed,
    strategy: isStrategyId(renamed) ? renamed : DEFAULT_CONTROL_CONFIG.strategy,
    intervalSeconds: clampInterval(
      Number.isFinite(intervalSeconds)
        ? intervalSeconds
        : DEFAULT_CONTROL_CONFIG.intervalSeconds,
    ),
  };
}

export type ControlErrors = {
  intervalSeconds?: string;
  enabled?: string;
};

export function parseControlConfig(
  formData: FormData,
): { ok: true; config: ControlConfig } | { ok: false; errors: ControlErrors } {
  const raw = formData.get("intervalSeconds")?.toString().trim();
  const intervalSeconds = Number(raw);

  if (
    !raw ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < MIN_INTERVAL_SECONDS ||
    intervalSeconds > MAX_INTERVAL_SECONDS
  ) {
    return {
      ok: false,
      errors: {
        intervalSeconds: `Interval must be a whole number of seconds between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}.`,
      },
    };
  }

  const strategy = formData.get("strategy")?.toString();

  return {
    ok: true,
    config: {
      // An unchecked checkbox sends nothing at all, which is what makes the
      // absent case mean "off" here.
      enabled: formData.get("enabled") === "on",
      strategy: isStrategyId(strategy)
        ? strategy
        : DEFAULT_CONTROL_CONFIG.strategy,
      intervalSeconds,
    },
  };
}
