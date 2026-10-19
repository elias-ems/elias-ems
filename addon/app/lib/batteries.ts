/**
 * The configured batteries. Capacity and the charge window are things the
 * installer knows and Home Assistant does not, so they are typed in; the three
 * live values come from HA entities, and the title is what names the battery on
 * Home Assistant's event bus — see `commandEventType`.
 *
 * Both power entities are read with the sign convention **positive = charging,
 * negative = discharging**. That is a decision rather than an observation —
 * inverters disagree, and plenty publish the opposite — and it is the convention
 * the strategy's arithmetic and the log lines are written against, so it is also
 * the one the battery command event carries.
 *
 * Pure; persistence lives in `batteries.server.ts`.
 */

import {
  BATTERY_COMMAND_SCHEMA_VERSION,
  BATTERY_MODES,
  type BatteryMode,
  isBatteryMode,
} from "./battery-command";
import type { StrategyId } from "./control";
import { slugifyTitle } from "./slug";

export type BatteryFields = {
  /**
   * The modes this battery's automation (or adapter) can carry out when it
   * receives a battery command. `balance` is always there: it is the battery's
   * own self-consumption, which needs nothing but boundaries. The direct modes
   * — `hold`, `charge`, `discharge` — need something that can force a power
   * setpoint. No production strategy issues them yet; they are recorded so a
   * direct-mode strategy can be enabled per battery.
   */
  controlModes: BatteryMode[];
  /**
   * Whether the automation can cap discharge (AC output) in `balance`. Without
   * it a command's `discharge_limit_w` is null and discharge stays native.
   */
  dischargeLimitSupported: boolean;
  /**
   * The resolution boundaries and setpoints are planned in, in W. What a
   * `number` entity's `step` used to supply, now that nothing reads one.
   */
  powerStepW: number;
  /** Whether Optimize charge limits plans (and previews) this battery. */
  chargeLimitPlanning: boolean;
  /**
   * Which version of the battery command event this record was saved against.
   * A record without one predates the event, and is read as unsteered — see
   * `normalizeBattery`.
   */
  commandContract?: number;
  chargeEfficiencyPercent?: number;
  title: string;
  /** Usable capacity in kWh. */
  capacityKwh: number;
  /** The bottom of the window control may use, in percent. */
  minChargePercent: number;
  /** The top of that window, in percent. */
  maxChargePercent: number;
  /** Cumulative energy counter, in kWh. */
  energyEntityId: string;
  /** Current power in W: positive charging, negative discharging. */
  powerEntityId: string;
  /** State of charge, in percent. */
  socEntityId: string;
  /**
   * Whether the add-on may command this battery.
   *
   * False means watched but not steered: it still appears on the dashboard and
   * still counts as part of the house, but neither strategy controls
   * it. A supported state rather than an unfinished one — a house can
   * reasonably have one battery under control and one that only reports.
   *
   * Defaults to false for anything already on disk, so no existing
   * installation starts being steered by an upgrade.
   */
  steered: boolean;
  /**
   * Most this battery may be asked to charge at, in W, or null for no limit.
   *
   * The only place a limit can come from now that nothing is written to an
   * entity: an event has no `min`/`max` to read a battery's rating off, so a
   * cap left empty here is genuinely no cap.
   */
  maxChargePowerW: number | null;
  /**
   * The same for discharging, as a **positive magnitude** — the form asks for
   * "5000 W", not "-5000 W", and the sign is applied where it is used.
   */
  maxDischargePowerW: number | null;
};

export type Battery = BatteryFields & { id: string };

export type BatteryErrors = Partial<Record<keyof BatteryFields, string>>;

/** Prefilled in the add form: a conservative window most chemistries are happy in. */
export const BATTERY_DEFAULTS = {
  minChargePercent: 10,
  maxChargePercent: 95,
  powerStepW: 100,
} as const;

/**
 * Fields from before the battery command event: the two power-limit entities
 * Optimize charge limits wrote to directly, and its per-battery mode. Read only
 * by `normalizeBattery`, to carry the intent across an upgrade.
 */
type LegacyBatteryFields = {
  chargeLimitMode?: string;
  chargeLimitEntityId?: string;
  dischargeLimitEntityId?: string;
  /**
   * Per-battery planning settings, before Optimize charge limits hardcoded
   * them (`CHARGE_LIMIT_PLANNING` in control.ts). Dropped on read.
   */
  solarMarginPercent?: number;
  chargeWearPerKwh?: number;
};

/**
 * A battery as it may be on disk: anything saved before a field existed lacks
 * it, and `normalizeBattery` is where it is given something to be.
 */
export type StoredBattery = Omit<
  Battery,
  | "controlModes"
  | "dischargeLimitSupported"
  | "powerStepW"
  | "chargeLimitPlanning"
> &
  Partial<
    Pick<
      Battery,
      | "controlModes"
      | "dischargeLimitSupported"
      | "powerStepW"
      | "chargeLimitPlanning"
    >
  > &
  LegacyBatteryFields;

function toControlModes(value: unknown): BatteryMode[] {
  // Missing means "never chosen", and every mode is what a new battery is
  // offered by default.
  if (!Array.isArray(value)) return [...BATTERY_MODES];
  return BATTERY_MODES.filter(
    (mode) => mode === "balance" || value.some((v) => v === mode),
  );
}

function toFiniteNumber(value: unknown, fallback: number): number {
  // `Number("")` and `Number(null)` are both 0, so an empty or missing field
  // would otherwise pass the finite check and quietly become a real zero — a
  // 0% floor being very different from "this field wasn't filled in".
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A power cap, or null for "no cap configured".
 *
 * Zero and negatives collapse to null rather than being kept: a cap of 0 W
 * would silently stop the battery taking part at all, and that is far more
 * likely to be a blank field or a hand-edited typo than something anyone meant.
 */
function toOptionalPowerW(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Numbers survive a round trip through JSON, but not through someone editing
 * the file by hand — and a string where a number belongs would turn the
 * strategy's arithmetic into silent string concatenation.
 *
 * This is also where a record written before a field existed is given something
 * sensible to be: the power caps read as "not configured" when they are
 * missing, and the control modes as "everything".
 *
 * A record saved before the battery command event — no `commandContract` —
 * comes out **unsteered**, whatever it said before. Both of the shapes it could
 * have been steered under (a `_target_power` event, or limit entities written
 * directly) are gone, and nothing is listening for the new event until an
 * automation exists, so keeping it steered would mean claiming to command
 * hardware that has stopped hearing us.
 */
export function normalizeBattery(battery: StoredBattery): Battery {
  const {
    chargeLimitMode: _mode,
    chargeLimitEntityId,
    dischargeLimitEntityId,
    solarMarginPercent: _margin,
    chargeWearPerKwh: _wear,
    ...rest
  } = battery;
  // A record saved before the battery command event existed. Its strategy
  // either published `_target_power` events or wrote power-limit entities
  // itself; an automation listening for either hears nothing now, so carrying
  // it across as steered would be claiming to command hardware that has
  // stopped hearing us. Its *intent* survives: a battery that had limit
  // entities keeps charge-limit planning, and discharge limiting if it had an
  // output entity.
  const current = battery.commandContract === BATTERY_COMMAND_SCHEMA_VERSION;
  const powerStepW = toFiniteNumber(
    battery.powerStepW,
    BATTERY_DEFAULTS.powerStepW,
  );

  return {
    ...rest,
    title: battery.title?.trim() || battery.powerEntityId,
    capacityKwh: toFiniteNumber(battery.capacityKwh, 0),
    minChargePercent: toFiniteNumber(
      battery.minChargePercent,
      BATTERY_DEFAULTS.minChargePercent,
    ),
    maxChargePercent: toFiniteNumber(
      battery.maxChargePercent,
      BATTERY_DEFAULTS.maxChargePercent,
    ),
    steered: current && battery.steered === true,
    controlModes: toControlModes(battery.controlModes),
    dischargeLimitSupported: current
      ? battery.dischargeLimitSupported === true
      : Boolean(dischargeLimitEntityId?.trim()),
    chargeLimitPlanning: current
      ? battery.chargeLimitPlanning === true
      : Boolean(chargeLimitEntityId?.trim()),
    powerStepW: powerStepW > 0 ? powerStepW : BATTERY_DEFAULTS.powerStepW,
    commandContract: BATTERY_COMMAND_SCHEMA_VERSION,
    chargeEfficiencyPercent: toFiniteNumber(
      battery.chargeEfficiencyPercent,
      95,
    ),
    maxChargePowerW: toOptionalPowerW(battery.maxChargePowerW),
    maxDischargePowerW: toOptionalPowerW(battery.maxDischargePowerW),
  };
}

/**
 * Whether the add-on may command this battery at all. The one thing that
 * separates a battery a strategy may command from one it can only watch.
 */
export function isSteerable(battery: Pick<BatteryFields, "steered">): boolean {
  return battery.steered === true;
}

/**
 * Whether this strategy may command this battery: steered, and opted in to
 * planning. Both registered strategies publish `balance` with boundaries in
 * production, which every battery supports. The strategy stays a parameter
 * because one that issues direct modes would also need the battery's
 * `controlModes` to include them.
 */
export function steerableBy(
  battery: Pick<BatteryFields, "steered" | "chargeLimitPlanning">,
  _strategy: StrategyId,
): boolean {
  return isSteerable(battery) && battery.chargeLimitPlanning;
}

/** The battery's slug, with a last-resort fallback so it is never empty. */
export function batterySlug(battery: Pick<Battery, "id" | "title">): string {
  return slugifyTitle(battery.title) || `battery_${slugifyTitle(battery.id)}`;
}

/**
 * Why two batteries may not have names that slugify the same way.
 *
 * "Home battery" and "home-battery" are different titles and the same event
 * type, which would leave both batteries taking each other's commands with
 * nothing anywhere reporting a problem. Checked in the settings action rather
 * than in `parseBattery`, because it needs the other batteries and this module
 * is pure; the constant lives here so the message cannot drift from the rule.
 */
export const DUPLICATE_SLUG_ERROR =
  "Another battery already has this name — both would publish to the same event.";

/** What a battery may be asked for. */
export type PowerLimits = {
  /** Most it may charge at, in W. Null when nothing constrains it. */
  maxChargeW: number | null;
  /** Most it may discharge at, in W as a positive magnitude. Null when unconstrained. */
  maxDischargeW: number | null;
};

/**
 * What the battery may actually be asked for.
 *
 * Settings are the only source. While the target was written to an entity
 * there was a second one — the `min`/`max` a `number` or `input_number`
 * publishes about itself — and an empty field fell back to it. An event has no
 * such range, and inventing one from the battery's capacity would be a guess
 * about hardware, so an empty field now means exactly what it says: this
 * direction is uncapped, and it is the strategy's SoC window that keeps the
 * battery inside its own limits.
 *
 * A one-field-per-direction rename rather than a bare property read, because
 * "the cap on charging" and "the field the form calls maxChargePowerW" are
 * different enough that the strategy should not have to know the second name.
 */
export function resolvePowerLimits(
  battery: Pick<BatteryFields, "maxChargePowerW" | "maxDischargePowerW">,
): PowerLimits {
  return {
    maxChargeW: battery.maxChargePowerW,
    maxDischargeW: battery.maxDischargePowerW,
  };
}

function readNumber(formData: FormData, name: string): number | null {
  const raw = formData.get(name)?.toString().trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * An optional power cap. Unlike `readNumber` this has to tell a field left
 * empty from one filled in with nonsense: the first is a valid "no cap", the
 * second is a typo, and reporting them the same way would let a mistyped limit
 * through as "unlimited" — the least safe reading of the two.
 */
function readOptionalPowerW(
  formData: FormData,
  name: string,
): { ok: true; value: number | null } | { ok: false } {
  const raw = formData.get(name)?.toString().trim();
  if (!raw) return { ok: true, value: null };

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return { ok: false };
  return { ok: true, value };
}

export function parseBattery(
  formData: FormData,
): { ok: true; fields: BatteryFields } | { ok: false; errors: BatteryErrors } {
  const title = formData.get("title")?.toString().trim() ?? "";
  const energyEntityId =
    formData.get("energyEntityId")?.toString().trim() ?? "";
  const powerEntityId = formData.get("powerEntityId")?.toString().trim() ?? "";
  const socEntityId = formData.get("socEntityId")?.toString().trim() ?? "";
  // An unchecked checkbox sends nothing at all, which is what makes the absent
  // case mean "watched, not steered".
  const steered = formData.get("steered") === "on";
  const capacityKwh = readNumber(formData, "capacityKwh");
  const minChargePercent = readNumber(formData, "minChargePercent");
  const maxChargePercent = readNumber(formData, "maxChargePercent");
  const maxChargePowerW = readOptionalPowerW(formData, "maxChargePowerW");
  const maxDischargePowerW = readOptionalPowerW(formData, "maxDischargePowerW");

  const errors: BatteryErrors = {};
  const chargeLimitPlanning = formData.get("chargeLimitPlanning") === "on";
  const dischargeLimitSupported =
    formData.get("dischargeLimitSupported") === "on";
  const requestedModes = formData.getAll("controlModes").map(String);
  const powerStepW =
    readNumber(formData, "powerStepW") ??
    (formData.get("powerStepW") ? NaN : BATTERY_DEFAULTS.powerStepW);
  const chargeEfficiencyPercent =
    readNumber(formData, "chargeEfficiencyPercent") ??
    (formData.get("chargeEfficiencyPercent") ? NaN : 95);
  if (requestedModes.some((mode) => !isBatteryMode(mode)))
    errors.controlModes = "Choose from balance, hold, charge and discharge.";
  if (!Number.isFinite(powerStepW) || powerStepW <= 0)
    errors.powerStepW = "Power step must be a number above 0.";
  if (chargeLimitPlanning) {
    if (!maxChargePowerW.ok || maxChargePowerW.value === null)
      errors.maxChargePowerW =
        "Set the hardware charge ceiling for charge-limit planning.";
    if (!maxDischargePowerW.ok || maxDischargePowerW.value === null)
      errors.maxDischargePowerW =
        "Set the native discharge power limit for the self-consumption model.";
  }
  if (
    !Number.isFinite(chargeEfficiencyPercent) ||
    chargeEfficiencyPercent <= 0 ||
    chargeEfficiencyPercent > 100
  )
    errors.chargeEfficiencyPercent =
      "Efficiency must be above 0 and at most 100%.";
  if (!title) {
    errors.title = "Give this battery a name.";
  } else if (slugifyTitle(title) === "") {
    // The title is what the event type is built from, so a name made entirely
    // of punctuation or emoji has nothing to build one out of. Rejected here
    // rather than papered over with the record id, which would leave the
    // settings page showing a name and the automation needing another.
    errors.title =
      "Give this battery a name with at least one letter or digit.";
  }
  if (!energyEntityId) errors.energyEntityId = "Pick the energy entity.";
  if (!powerEntityId) errors.powerEntityId = "Pick the power entity.";
  if (!socEntityId) errors.socEntityId = "Pick the state-of-charge entity.";

  if (!maxChargePowerW.ok) {
    errors.maxChargePowerW = "Maximum charge power must be a number above 0.";
  }
  if (!maxDischargePowerW.ok) {
    errors.maxDischargePowerW =
      "Maximum discharge power must be a number above 0.";
  }

  if (capacityKwh === null || capacityKwh <= 0) {
    errors.capacityKwh = "Capacity must be a number above 0.";
  }
  if (
    minChargePercent === null ||
    minChargePercent < 0 ||
    minChargePercent > 100
  ) {
    errors.minChargePercent = "Minimum charge must be between 0 and 100.";
  }
  if (
    maxChargePercent === null ||
    maxChargePercent < 0 ||
    maxChargePercent > 100
  ) {
    errors.maxChargePercent = "Maximum charge must be between 0 and 100.";
  }
  // Only worth saying once both ends are otherwise valid, or it piles a second
  // message onto a field that already has one.
  if (
    minChargePercent !== null &&
    maxChargePercent !== null &&
    !errors.minChargePercent &&
    !errors.maxChargePercent &&
    minChargePercent >= maxChargePercent
  ) {
    errors.maxChargePercent = "Maximum charge must be above the minimum.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    fields: {
      title,
      capacityKwh: capacityKwh as number,
      minChargePercent: minChargePercent as number,
      maxChargePercent: maxChargePercent as number,
      energyEntityId,
      powerEntityId,
      socEntityId,
      steered,
      controlModes: toControlModes(requestedModes),
      dischargeLimitSupported,
      powerStepW,
      chargeLimitPlanning,
      commandContract: BATTERY_COMMAND_SCHEMA_VERSION,
      chargeEfficiencyPercent,
      // Both are known good here: an unparseable one is an error above.
      maxChargePowerW: maxChargePowerW.ok ? maxChargePowerW.value : null,
      maxDischargePowerW: maxDischargePowerW.ok
        ? maxDischargePowerW.value
        : null,
    },
  };
}
