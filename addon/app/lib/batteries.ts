/**
 * The configured batteries. Capacity and the charge window are things the
 * installer knows and Home Assistant does not, so they are typed in; the three
 * live values come from HA entities, and the title is what names the battery on
 * Home Assistant's event bus — see `targetEventType`.
 *
 * Both power entities are read with the sign convention **positive = charging,
 * negative = discharging**. That is a decision rather than an observation —
 * inverters disagree, and plenty publish the opposite — and it is the convention
 * the strategy's arithmetic and the log lines are written against, so it is also
 * the one the target event carries.
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
   * Whether the add-on may command this battery.
   *
   * False means watched but not steered: it still appears on the dashboard and
   * still counts as part of the house, and no target is ever published for
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
 * A record from the version that wrote to a target entity lands here too, and
 * comes out unsteered — `steered` is absent, so it reads as false.
 * That is the honest reading rather than a lossy one: the target power now goes
 * out as an event that nothing is listening for until an automation exists, so
 * keeping the battery steered through the upgrade would mean claiming to
 * command hardware that has stopped hearing us.
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
    steered: battery.steered === true,
    maxChargePowerW: toOptionalPowerW(battery.maxChargePowerW),
    maxDischargePowerW: toOptionalPowerW(battery.maxDischargePowerW),
  };
}

/**
 * Whether a target can be published for this battery at all.
 *
 * The one thing that separates a battery the strategy may command from one it
 * can only watch, so it is a named function rather than a truthiness check
 * spelled out at each of the three call sites that need it.
 */
export function isSteerable(battery: Pick<BatteryFields, "steered">): boolean {
  return battery.steered === true;
}

/**
 * The battery's title reduced to something that can be part of a Home
 * Assistant event type: lowercase, accents folded away, and every run of
 * anything else turned into a single underscore.
 *
 * "Home battery" becomes `home_battery`, and so does "Home  Battery!" — the
 * point is that the name in an automation is predictable from the name on the
 * settings page, not that every distinct title survives intact. Accents are
 * folded rather than dropped so that "Réserve" is `reserve` instead of `r_serve`.
 *
 * Empty when the title has no letters or digits at all. Callers decide what to
 * do about that: the form rejects such a title, and `batterySlug` falls back to
 * the record id for anything a hand-edited file gets past it.
 */
export function slugifyTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The battery's slug, with a last-resort fallback so it is never empty. */
export function batterySlug(battery: Pick<Battery, "id" | "title">): string {
  return slugifyTitle(battery.title) || `battery_${slugifyTitle(battery.id)}`;
}

/**
 * The Home Assistant event type this battery's target power goes out on.
 *
 * `target_power` rather than a bare `target`, so that a battery growing a
 * second kind of target later — a state of charge to aim for, once the
 * price-aware strategies land — has somewhere to go that does not collide.
 *
 * One type per battery rather than one shared type with the battery named in
 * the payload: an automation's event trigger then says which battery it is for
 * in the line that matters most — `event_type: elias_ems_home_battery_target_power`
 * reads as what it is, where a shared type plus an `event_data` filter puts the
 * identity somewhere easy to leave off by mistake, in which case the automation
 * quietly drives every battery in the house from one battery's target.
 *
 * The cost is that renaming a battery renames its event. The settings page says
 * so while the rename is being typed, because nothing downstream can: Home
 * Assistant does not know that two event types were ever related, and an
 * automation listening for the old one simply stops hearing anything.
 */
export function targetEventType(slug: string): string {
  return `elias_ems_${slug}_target_power`;
}

/**
 * Why two batteries may not have names that slugify the same way.
 *
 * "Home battery" and "home-battery" are different titles and the same event
 * type, which would leave both batteries taking each other's targets with
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
      // Both are known good here: an unparseable one is an error above.
      maxChargePowerW: maxChargePowerW.ok ? maxChargePowerW.value : null,
      maxDischargePowerW: maxDischargePowerW.ok
        ? maxDischargePowerW.value
        : null,
    },
  };
}
