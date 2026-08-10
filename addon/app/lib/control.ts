/**
 * Battery control's shared model: what the settings form edits, what the debug
 * box renders, and the validation between them. Pure, so both the server and the
 * browser bundle can have it — the loop itself, its log buffer, and reading and
 * writing the config all live in the matching `.server` modules.
 */

export type StrategyId = "net-zero-energy";

export type ControlConfig = {
  enabled: boolean;
  strategy: StrategyId;
  /** How often the loop reconsiders, in seconds. */
  intervalSeconds: number;
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

export type ControlErrors = { intervalSeconds?: string };

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

export type ControlLogLevel = "info" | "warn" | "error";

export type ControlLogEntry = {
  /** Rises monotonically within a process run; the client orders by it. */
  seq: number;
  /** ISO timestamp, for anyone reading the raw JSON. */
  at: string;
  /**
   * `HH:MM:SS` in the server's timezone, formatted on the server for the same
   * reason readings are: a locale- or timezone-dependent string built during
   * render is a hydration mismatch waiting to happen.
   */
  time: string;
  level: ControlLogLevel;
  message: string;
  /** How many times in a row this exact message was logged. */
  repeat: number;
};

export type ControlLoopStatus = {
  running: boolean;
  strategy: StrategyId;
  intervalSeconds: number;
  /** ISO timestamp of the last completed tick, or null if none has finished. */
  lastTickAt: string | null;
};
