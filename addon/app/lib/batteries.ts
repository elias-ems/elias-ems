/**
 * The configured batteries. Capacity and the charge window are things the
 * installer knows and Home Assistant does not, so they are typed in; the three
 * live values come from HA entities, and `controlKey` names the battery in the
 * setpoint event an automation listens for.
 *
 * Both power entities are read with the sign convention **positive = charging,
 * negative = discharging**. That is a decision rather than an observation —
 * inverters disagree, and plenty publish the opposite — and it is the convention
 * the strategy's arithmetic and the log lines are written against, so it is also
 * the one the setpoint event carries.
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
   * How this battery is named in the setpoint event, and by that the one thing
   * that decides whether it is steered at all.
   *
   * The add-on does not write to the battery itself: it fires one Home
   * Assistant event per setpoint and an automation turns that into whatever
   * the hardware wants. This key is what the automation's event trigger
   * matches on, so it is chosen by whoever writes the automation rather than
   * derived from anything — a generated record id would be unreadable in YAML,
   * and the title is renamed the moment somebody tidies up the settings page.
   *
   * Optional. Empty means this battery is watched but not steered, which is
   * what every record saved before this field existed becomes.
   */
  controlKey: string;
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
 *
 * A record from the version that wrote setpoints to an entity lands here too,
 * carrying a `targetPowerEntityId` and no `controlKey`, and comes out
 * unsteered. That is the honest reading rather than a lossy one: the setpoint
 * now goes out as an event that nothing is listening for until an automation
 * exists, so keeping the battery "steered" through the upgrade would mean
 * claiming to command hardware that has stopped hearing us.
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
    controlKey: battery.controlKey?.trim() ?? "",
    maxChargePowerW: toOptionalPowerW(battery.maxChargePowerW),
    maxDischargePowerW: toOptionalPowerW(battery.maxDischargePowerW),
  };
}

/**
 * Whether a setpoint can be published for this battery at all.
 *
 * The one thing that separates a battery the strategy may command from one it
 * can only watch, so it is a named function rather than a truthiness check
 * spelled out at each of the three call sites that need it.
 */
export function isSteerable(
  battery: Pick<BatteryFields, "controlKey">,
): boolean {
  return Boolean(battery.controlKey?.trim());
}

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
 * Settings are the only source. While the setpoint was written to an entity
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
  // Optional: a battery with no control key is watched but not steered.
  const controlKey = formData.get("controlKey")?.toString().trim() ?? "";
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
      controlKey,
      // Both are known good here: an unparseable one is an error above.
      maxChargePowerW: maxChargePowerW.ok ? maxChargePowerW.value : null,
      maxDischargePowerW: maxDischargePowerW.ok
        ? maxDischargePowerW.value
        : null,
    },
  };
}
