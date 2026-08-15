/**
 * The configured batteries. Capacity and the charge window are things the
 * installer knows and Home Assistant does not, so they are typed in; the three
 * live values come from HA entities, and a fourth, `targetPowerEntityId`, is
 * the writable one the setpoint goes to.
 *
 * Both power entities are read with the sign convention **positive = charging,
 * negative = discharging**. That is a decision rather than an observation —
 * inverters disagree, and plenty publish the opposite — and it is the convention
 * the strategy's arithmetic and the log lines are written against, so it is also
 * the one the write path uses.
 *
 * Pure; persistence lives in `batteries.server.ts`.
 */

export type BatteryFields = {
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
   * Where the setpoint gets written: a writable entity — a `number` from an
   * inverter integration, or an `input_number` an automation forwards to
   * `modbus.write_register` — read with the same sign convention as
   * `powerEntityId`, positive charging and negative discharging.
   *
   * Optional. Empty means this battery is watched but not steered, which is
   * what every record saved before this field existed becomes.
   */
  targetPowerEntityId: string;
  /**
   * Most this battery may be asked to charge at, in W. Null falls back to the
   * target entity's own `max` attribute; see `resolvePowerLimits`.
   */
  maxChargePowerW: number | null;
  /**
   * The same for discharging, as a **positive magnitude** — the form asks for
   * "5000 W", not "-5000 W", and the sign is applied where it is used. Null
   * falls back to the target entity's own `min` attribute.
   */
  maxDischargePowerW: number | null;
};

export type Battery = BatteryFields & { id: string };

export type BatteryErrors = Partial<Record<keyof BatteryFields, string>>;

/** Prefilled in the add form: a conservative window most chemistries are happy in. */
export const BATTERY_DEFAULTS = {
  minChargePercent: 10,
  maxChargePercent: 95,
} as const;

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
 * sensible to be: the three control fields below all read as "not configured"
 * when they are missing, so an installation that predates them keeps behaving
 * exactly as it did.
 */
export function normalizeBattery(battery: Battery): Battery {
  return {
    ...battery,
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
    targetPowerEntityId: battery.targetPowerEntityId?.trim() ?? "",
    maxChargePowerW: toOptionalPowerW(battery.maxChargePowerW),
    maxDischargePowerW: toOptionalPowerW(battery.maxDischargePowerW),
  };
}

/**
 * Whether a setpoint can be written to this battery at all.
 *
 * The one thing that separates a battery the strategy may command from one it
 * can only watch, so it is a named function rather than a truthiness check
 * spelled out at each of the three call sites that need it.
 */
export function isSteerable(
  battery: Pick<BatteryFields, "targetPowerEntityId">,
): boolean {
  return Boolean(battery.targetPowerEntityId?.trim());
}

/** What a battery may be asked for, once config and the entity are both in. */
export type PowerLimits = {
  /** Most it may charge at, in W. Null when nothing constrains it. */
  maxChargeW: number | null;
  /** Most it may discharge at, in W as a positive magnitude. Null when unconstrained. */
  maxDischargeW: number | null;
};

/**
 * The range a writable entity publishes about itself. `number` entities always
 * carry `min`/`max` — they are required properties of the platform — and so do
 * `input_number` helpers, so in practice this is nearly always available.
 */
export type EntityRange = { min: number | null; max: number | null };

/**
 * What the battery may actually be asked for, from the two sources that know:
 * the fields typed into settings and the target entity's own range.
 *
 * **Configured values win.** The entity's range is a good default but not a
 * trustworthy one — an `input_number` helper created through the UI defaults to
 * 0–100, which would cap a 5 kW battery at 100 W — so the override has to be
 * able to say otherwise rather than merely narrow it.
 *
 * A range that cannot express a direction caps that direction at 0 rather than
 * leaving it open: `min: 0` on a signed setpoint entity means negative values
 * are not writable, so discharging through it is not something we can do. That
 * is also exactly what the mis-created helper above looks like, and a 0 is a
 * visible symptom where silently writing out of range would not be.
 */
export function resolvePowerLimits(
  battery: Pick<BatteryFields, "maxChargePowerW" | "maxDischargePowerW">,
  range: EntityRange | null,
): PowerLimits {
  return {
    maxChargeW:
      battery.maxChargePowerW ??
      (range?.max == null ? null : Math.max(0, range.max)),
    maxDischargeW:
      battery.maxDischargePowerW ??
      (range?.min == null ? null : Math.max(0, -range.min)),
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
  // Optional: a battery with no target entity is watched but not steered.
  const targetPowerEntityId =
    formData.get("targetPowerEntityId")?.toString().trim() ?? "";
  const capacityKwh = readNumber(formData, "capacityKwh");
  const minChargePercent = readNumber(formData, "minChargePercent");
  const maxChargePercent = readNumber(formData, "maxChargePercent");
  const maxChargePowerW = readOptionalPowerW(formData, "maxChargePowerW");
  const maxDischargePowerW = readOptionalPowerW(formData, "maxDischargePowerW");

  const errors: BatteryErrors = {};
  if (!title) errors.title = "Give this battery a name.";
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
      targetPowerEntityId,
      // Both are known good here: an unparseable one is an error above.
      maxChargePowerW: maxChargePowerW.ok ? maxChargePowerW.value : null,
      maxDischargePowerW: maxDischargePowerW.ok
        ? maxDischargePowerW.value
        : null,
    },
  };
}
