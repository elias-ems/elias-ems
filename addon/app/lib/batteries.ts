/**
 * The configured batteries. Capacity and the charge window are things the
 * installer knows and Home Assistant does not, so they are typed in; the three
 * live values come from HA entities.
 *
 * `powerEntityId` is read with the sign convention **positive = charging,
 * negative = discharging**. That is a decision rather than an observation —
 * inverters disagree, and plenty publish the opposite — and it is the convention
 * the strategy's arithmetic and the log lines are written against, so it is also
 * the one the eventual write path will use.
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
 * Numbers survive a round trip through JSON, but not through someone editing
 * the file by hand — and a string where a number belongs would turn the
 * strategy's arithmetic into silent string concatenation.
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
  };
}

function readNumber(formData: FormData, name: string): number | null {
  const raw = formData.get(name)?.toString().trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function parseBattery(
  formData: FormData,
): { ok: true; fields: BatteryFields } | { ok: false; errors: BatteryErrors } {
  const title = formData.get("title")?.toString().trim() ?? "";
  const energyEntityId =
    formData.get("energyEntityId")?.toString().trim() ?? "";
  const powerEntityId = formData.get("powerEntityId")?.toString().trim() ?? "";
  const socEntityId = formData.get("socEntityId")?.toString().trim() ?? "";
  const capacityKwh = readNumber(formData, "capacityKwh");
  const minChargePercent = readNumber(formData, "minChargePercent");
  const maxChargePercent = readNumber(formData, "maxChargePercent");

  const errors: BatteryErrors = {};
  if (!title) errors.title = "Give this battery a name.";
  if (!energyEntityId) errors.energyEntityId = "Pick the energy entity.";
  if (!powerEntityId) errors.powerEntityId = "Pick the power entity.";
  if (!socEntityId) errors.socEntityId = "Pick the state-of-charge entity.";

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
    },
  };
}
