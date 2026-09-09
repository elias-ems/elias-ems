/**
 * Battery control's shared model: what the settings form edits, what the home
 * page reports, and the validation between them. Pure, so both the server and
 * the browser bundle can have it — the loop itself and reading and writing the
 * config live in the matching `.server` modules, and what the loop logs is
 * `diagnostics.ts`'s shape, not a type of its own.
 */

export type StrategyId = "net-zero-energy" | "charge-limit";

export type ControlConfig = {
  enabled: boolean;
  strategy: StrategyId;
  /** How often the loop reconsiders, in seconds. */
  intervalSeconds: number;
  /** Explicit physical grid counters when Energy dashboard accounting is ambiguous. */
  gridImportIds?: string;
  gridExportIds?: string;
  solarMarginPercent?: number;
  chargeWearPerKwh?: number;
};

/**
 * Stored as an id rather than a boolean so that the price-aware strategies on
 * the roadmap are additive: one more entry here and one more branch in the loop,
 * with nothing already on disk needing to change.
 */
export const STRATEGIES: Array<{
  id: StrategyId;
  label: string;
  description: string;
}> = [
  {
    id: "charge-limit",
    label: "Optimize charge limit",
    description:
      "Plan automatically with solar forecasts and prices. When enabled, adjust only the maximum charging limit while the battery stays in native self-consumption.",
  },
  {
    id: "net-zero-energy",
    label: "Net zero energy",
    description:
      "Charge with what would otherwise be exported and discharge to cover what would otherwise be imported, so the meter sits at zero.",
  },
];

/** Five seconds: fast enough to follow a kettle, slow enough not to hammer HA. */
export const DEFAULT_CONTROL_CONFIG: ControlConfig = {
  enabled: false,
  strategy: "net-zero-energy",
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

  return {
    ...(stored?.gridImportIds !== undefined
      ? { gridImportIds: String(stored.gridImportIds) }
      : {}),
    ...(stored?.gridExportIds !== undefined
      ? { gridExportIds: String(stored.gridExportIds) }
      : {}),
    ...(stored?.solarMarginPercent !== undefined
      ? { solarMarginPercent: Number(stored.solarMarginPercent) }
      : {}),
    ...(stored?.chargeWearPerKwh !== undefined
      ? { chargeWearPerKwh: Number(stored.chargeWearPerKwh) }
      : {}),
    enabled: stored?.enabled === true,
    strategy: isStrategyId(stored?.strategy)
      ? stored.strategy
      : DEFAULT_CONTROL_CONFIG.strategy,
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
  planning?: string;
};

/**
 * Why control cannot be switched on yet.
 *
 * Enabling it with nothing to command would produce a loop that decides
 * correctly and changes nothing — which looks identical, from the outside, to
 * a loop that is broken. The check lives in the settings action rather than in
 * `parseControlConfig` because it needs the battery list, and this module is
 * pure; the constant is here so the form's warning and the server's rejection
 * cannot drift apart.
 */
export const NO_STEERABLE_BATTERY_ERROR =
  "At least one battery needs to be steered before control can be enabled — without one there is nothing to steer.";

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
  const planning: Partial<ControlConfig> = {};
  for (const key of ["gridImportIds", "gridExportIds"] as const) {
    if (formData.has(key))
      planning[key] = formData.get(key)?.toString().trim() || "";
  }
  for (const key of ["solarMarginPercent", "chargeWearPerKwh"] as const) {
    const raw = formData.get(key)?.toString().trim();
    if (raw) {
      const value = Number(raw);
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        (key === "solarMarginPercent" && value > 80)
      )
        return {
          ok: false,
          errors: {
            planning:
              "Solar margin must be 0–80%; wear cost must be non-negative.",
          },
        };
      planning[key] = value;
    }
  }

  return {
    ok: true,
    config: {
      ...planning,
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

export type ControlLoopStatus = {
  running: boolean;
  strategy: StrategyId;
  intervalSeconds: number;
  /** ISO timestamp of the last completed tick, or null if none has finished. */
  lastTickAt: string | null;
};
