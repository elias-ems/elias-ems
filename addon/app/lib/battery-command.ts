/**
 * The one event every battery strategy speaks: a versioned **battery command**,
 * published per battery on `elias_ems_<slug>_battery_command`.
 *
 * Before this, battery control reached the hardware in two different ways: a
 * bare signed target power, and `number` entities written directly, read back
 * and journalled for restoration. The second shape assumed the add-on knew
 * which entities sat behind each battery, which is exactly what stops it
 * growing to several batteries of different brands. Now every registered
 * strategy describes *what the battery should be doing*, and an automation (or
 * a future adapter) per battery owns *how* that inverter is made to do it.
 *
 * A command is a **mode plus boundaries**, the shape the engine plans in:
 *
 * | Mode | Meaning | `setpointW` |
 * | --- | --- | --- |
 * | `balance` | the battery's native self-consumption, clipped by the boundaries | null |
 * | `hold` | direct control: no battery power, whatever the meter does | 0 |
 * | `charge` | direct control: charge at the setpoint | positive |
 * | `discharge` | direct control: discharge at the setpoint | negative |
 *
 * Zero battery power (`hold`) is not a balanced meter (`balance`), and a power
 * ceiling alone is not a setpoint — so the two are separate fields rather than
 * one overloaded number.
 *
 * Pure, so the settings page can show the event type and the tests can build
 * payloads; publishing lives in `battery-commands.server.ts`.
 */

import type { StrategyId } from "./control";

/** Bumped on any change to the payload an automation could notice. */
export const BATTERY_COMMAND_SCHEMA_VERSION = 1;

export const BATTERY_MODES = [
  "balance",
  "hold",
  "charge",
  "discharge",
] as const;
export type BatteryMode = (typeof BATTERY_MODES)[number];

/** The direct-control modes: each needs an adapter that can follow a setpoint. */
export const SETPOINT_MODES = ["hold", "charge", "discharge"] as const;

export function isBatteryMode(value: unknown): value is BatteryMode {
  return BATTERY_MODES.includes(value as BatteryMode);
}

/** What a battery should be doing for one stretch of time. */
export type BatteryCommand = {
  mode: BatteryMode;
  /**
   * Signed AC power, positive charging: null in `balance`, 0 in `hold`,
   * positive in `charge`, negative in `discharge`.
   */
  setpointW: number | null;
  /** Most the battery may charge at, in W; null leaves the native limit. */
  chargeLimitW: number | null;
  /** Most it may discharge at, as a positive magnitude; null for native. */
  dischargeLimitW: number | null;
  /**
   * Whether the battery may charge from the grid, and discharge into it. Set
   * on direct commands for a battery whose `charge` / `discharge` modes are
   * allowed; always false in `balance`, which never does either.
   */
  gridCharging: boolean;
  batteryExport: boolean;
  /** Epoch ms. The command is meant for `[validFrom, validUntil)`. */
  validFrom: number;
  /**
   * After this, an adapter should treat the command as stale and hand the
   * battery back. The only safeguard that still works when Elias itself is
   * down — nothing published here can survive `kill -9`.
   */
  validUntil: number;
};

/** Why the add-on stopped steering a battery. */
export type ReleaseReason =
  /** The strategy was switched off or away. */
  | "disabled"
  /** The battery stopped being steered, or was removed. */
  | "unsteered"
  /** Planning or a precondition failed, so the last command cannot stand. */
  | "failure"
  /** The add-on is stopping. */
  | "shutdown";

/**
 * The Home Assistant event type a battery's commands go out on.
 *
 * One type per battery rather than one shared type with the battery named in
 * the payload: an automation's trigger then says which battery it is for in
 * the line that is hardest to get wrong, where a shared type plus an
 * `event_data` filter puts the identity somewhere easy to leave off — and an
 * automation missing that filter would drive every battery in the house from
 * one battery's commands.
 */
export function commandEventType(slug: string): string {
  return `elias_ems_${slug}_battery_command`;
}

/**
 * Turns a signed power target into a direct-control command: `charge`,
 * `discharge`, or `hold` at exactly zero — what a direct-mode HiGHS plan
 * publishes for a battery that allows those modes.
 */
export function setpointCommand(
  targetW: number,
  limits: { maxChargeW: number | null; maxDischargeW: number | null },
  validFrom: number,
  validUntil: number,
  permissions = { gridCharging: false, batteryExport: false },
): BatteryCommand {
  // Whole watts: a target carried to fifteen decimals only makes an
  // automation's trace harder to read.
  const setpointW = Math.round(targetW);
  return {
    mode: setpointW > 0 ? "charge" : setpointW < 0 ? "discharge" : "hold",
    // `+ 0` folds -0 into 0, which would otherwise serialize as `0` but compare
    // unequal under Object.is in tests.
    setpointW: setpointW + 0,
    chargeLimitW: limits.maxChargeW,
    dischargeLimitW: limits.maxDischargeW,
    gridCharging: permissions.gridCharging,
    batteryExport: permissions.batteryExport,
    validFrom,
    validUntil,
  };
}

/** A native self-consumption command bounded by limits. Charge-limit's shape. */
export function balanceCommand(
  limits: { chargeLimitW: number | null; dischargeLimitW: number | null },
  validFrom: number,
  validUntil: number,
): BatteryCommand {
  return {
    mode: "balance",
    setpointW: null,
    chargeLimitW: limits.chargeLimitW,
    dischargeLimitW: limits.dischargeLimitW,
    gridCharging: false,
    batteryExport: false,
    validFrom,
    validUntil,
  };
}

/** Who a payload is about and where it came from. */
export type CommandEnvelope = {
  slug: string;
  batteryId: string;
  title: string;
  commandId: string;
  ownerEpoch: string;
  issuedAt: number;
};

const iso = (ms: number) => new Date(ms).toISOString();
const whole = (w: number | null) => (w === null ? null : Math.round(w));

/**
 * The event data, in Home Assistant's snake_case.
 *
 * Flat rather than nested, because every field is read from Jinja as
 * `trigger.event.data.<field>` and a nested object is one more thing to get
 * wrong in a template that drives hardware. `charge_w` and `discharge_w`
 * restate the setpoint as unsigned magnitudes, for inverters with a register
 * per direction.
 */
export function commandPayload(
  envelope: CommandEnvelope,
  body:
    | { action: "apply"; strategy: StrategyId; command: BatteryCommand }
    | { action: "release"; strategy: StrategyId | null; reason: ReleaseReason },
): Record<string, unknown> {
  const head = {
    schema_version: BATTERY_COMMAND_SCHEMA_VERSION,
    slug: envelope.slug,
    battery_id: envelope.batteryId,
    title: envelope.title,
    command_id: envelope.commandId,
    owner_epoch: envelope.ownerEpoch,
    issued_at: iso(envelope.issuedAt),
    action: body.action,
    strategy: body.strategy,
    released: body.action === "release",
  };

  if (body.action === "release") {
    return {
      ...head,
      mode: null,
      setpoint_w: null,
      charge_w: 0,
      discharge_w: 0,
      charge_limit_w: null,
      discharge_limit_w: null,
      grid_charging: false,
      battery_export: false,
      valid_from: iso(envelope.issuedAt),
      valid_until: null,
      release_reason: body.reason,
    };
  }

  const { command } = body;
  const setpointW = whole(command.setpointW);
  return {
    ...head,
    mode: command.mode,
    setpoint_w: setpointW,
    charge_w: Math.max(0, setpointW ?? 0),
    discharge_w: Math.max(0, -(setpointW ?? 0)),
    charge_limit_w: whole(command.chargeLimitW),
    discharge_limit_w: whole(command.dischargeLimitW),
    grid_charging: command.gridCharging,
    battery_export: command.batteryExport,
    valid_from: iso(command.validFrom),
    valid_until: iso(command.validUntil),
    release_reason: null,
  };
}

/** One line for the log: what a command asks for, without the envelope. */
export function describeCommand(command: BatteryCommand): string {
  const limits = [
    command.chargeLimitW === null
      ? null
      : `charge ≤ ${Math.round(command.chargeLimitW)} W`,
    command.dischargeLimitW === null
      ? null
      : `discharge ≤ ${Math.round(command.dischargeLimitW)} W`,
  ].filter(Boolean);
  const head =
    command.mode === "balance"
      ? "balance"
      : command.mode === "hold"
        ? "hold"
        : `${command.mode} ${Math.abs(Math.round(command.setpointW ?? 0))} W`;
  return limits.length && command.mode === "balance"
    ? `${head} (${limits.join(", ")})`
    : head;
}
