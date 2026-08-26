/**
 * A PV array: its two live readings, a name to tell it from the next one, and
 * what curtailment needs to know about it.
 *
 * `powerEntityId` is read with the sign convention **positive = generating**,
 * which is what every PV sensor publishes and the arithmetic in `curtail.ts` is
 * written against.
 *
 * Pure; persistence lives in `pv-entities.server.ts`.
 */

import { slugifyTitle } from "./slug";

export type PvEntityFields = {
  title: string;
  /** Current power, in W. */
  powerEntityId: string;
  /** Total energy generated, in kWh. */
  energyEntityId: string;
  /**
   * The inverter's rated AC output in W, or null when nobody has said.
   *
   * Typed in rather than read from anywhere, because there is nowhere to read
   * it from: a power sensor publishes no rating, and taking the highest value
   * ever observed would underestimate it after a cloudy week — which would
   * quietly change what "1%" means from one day to the next. Curtailment is
   * commanded as a percentage of this number, so an array without one cannot
   * be curtailed at all; see `isCurtailable`.
   */
  ratedPowerW: number | null;
  /**
   * Whether the add-on may hold this array back.
   *
   * False means watched but not commanded: it still appears on the dashboard
   * and still counts towards what the house is generating, and no limit is
   * ever published for it. A supported state rather than an unfinished one —
   * an installation can reasonably have one steerable inverter and one that
   * only reports.
   *
   * Defaults to false for anything already on disk, so no existing
   * installation starts being curtailed by an upgrade.
   */
  curtailable: boolean;
  /**
   * How often this inverter may be commanded — which decides what it is
   * commanded *with*.
   *
   * `modulating` is the ordinary case: the limit lives in RAM, so it can be
   * rewritten every few seconds and the array follows the house continuously.
   *
   * `stepped` is for an inverter that commits **every** write to non-volatile
   * memory — a Huawei SUN2000 and others like it. Following the house would
   * spend its write endurance on a handful of negative-price afternoons a year,
   * so it is told one fixed limit when curtailment starts and handed back when
   * it ends, and nothing in between. See `stepLimitPercent`.
   *
   * A string rather than a boolean for the reason `CurtailmentStrategyId` and
   * `PriceSourceKind` are: an inverter that can only be switched rather than
   * limited, or one that takes limits in coarse steps of its own, should be one
   * more entry here rather than a second flag to reason about alongside this one.
   */
  controlMode: PvControlMode;
  /**
   * `stepped` only: the limit to hold this array at while curtailing, in
   * percent of its rating. Null when nobody has said.
   *
   * Deliberately **not** clamped to `minLimitPercent`. That floor exists to keep
   * the modulating feedback law out of its fixed point at zero, and a stepped
   * array is not in that loop — it is set to this number and left there. The
   * separate hardware reason for the floor, an MPPT that drops out at 0%, is
   * real but is the installer's call, so the settings page warns rather than
   * silently raising what was typed.
   */
  stepLimitPercent: number | null;
};

/** See `PvEntityFields.controlMode`. */
export type PvControlMode = "modulating" | "stepped";

export const PV_CONTROL_MODES: Array<{
  id: PvControlMode;
  label: string;
  description: string;
}> = [
  {
    id: "modulating",
    label: "Follows the house",
    description:
      "The limit is recalculated every few seconds so the array makes what the house can absorb. Right for any inverter that keeps its limit in memory — an SMA Sunny Boy and most others.",
  },
  {
    id: "stepped",
    label: "One fixed step",
    description:
      "One command when curtailment starts, one when it ends, and nothing in between. For an inverter that writes every limit to permanent memory — a Huawei SUN2000 and similar — where following the house would wear it out. The other arrays balance the house around this one.",
  },
];

export function isPvControlMode(value: unknown): value is PvControlMode {
  return PV_CONTROL_MODES.some((mode) => mode.id === value);
}

export type PvEntity = PvEntityFields & { id: string };

export type PvEntityErrors = Partial<Record<keyof PvEntityFields, string>>;

/**
 * A rated power, or null for "not configured".
 *
 * Zero and negatives collapse to null rather than being kept: a rating of 0 W
 * makes every percentage meaningless and is far more likely to be a blank field
 * or a hand-edited typo than something anyone meant.
 */
function toOptionalPowerW(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * What to make of whatever is on disk.
 *
 * `title` was added after the first entries were already stored, so records may
 * not have one. Fall back to the power entity id, which at least tells two
 * arrays apart, rather than showing every one of them as "Untitled".
 *
 * `ratedPowerW` and `curtailable` were added later still, and both read as
 * "not configured" when missing — so an installation that predates curtailment
 * keeps behaving exactly as it did.
 *
 * `controlMode` and `stepLimitPercent` came last, and read as "modulating, no
 * step configured". That is the behaviour every existing array already had, so
 * an upgrade changes nothing about how any of them are commanded.
 */
export function normalizePvEntity(entity: PvEntity): PvEntity {
  return {
    ...entity,
    title: entity.title?.trim() || entity.powerEntityId,
    ratedPowerW: toOptionalPowerW(entity.ratedPowerW),
    curtailable: entity.curtailable === true,
    controlMode: isPvControlMode(entity.controlMode)
      ? entity.controlMode
      : "modulating",
    stepLimitPercent: toOptionalPercent(entity.stepLimitPercent),
  };
}

/**
 * A whole percentage in 0–100, or null for "not configured".
 *
 * Zero is kept here, unlike `toOptionalPowerW` where it collapses to null: a
 * rating of 0 W makes every percentage meaningless, but a *step* of 0% is the
 * most obvious thing somebody would want — stop this array entirely while
 * prices are negative.
 */
function toOptionalPercent(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

/**
 * Whether a limit can be published for this array at all.
 *
 * Two conditions, not one: somebody has to have asked for it *and* there has to
 * be a rating to express the limit as a percentage of. An array ticked
 * curtailable with the rating left blank is a half-filled form, and treating it
 * as steerable would mean dividing by null.
 */
export function isCurtailable<
  TEntity extends Pick<PvEntityFields, "curtailable" | "ratedPowerW">,
>(entity: TEntity): entity is TEntity & { ratedPowerW: number } {
  return entity.curtailable === true && (entity.ratedPowerW ?? 0) > 0;
}

/**
 * Whether this array is commanded once per episode rather than continuously.
 *
 * Both conditions again, and for the same shape of reason as `isCurtailable`:
 * a stepped array with no step configured has nothing to be commanded *with*,
 * and guessing a number for it would be guessing about somebody's hardware.
 */
export function isStepped<
  TEntity extends Pick<PvEntityFields, "controlMode" | "stepLimitPercent">,
>(entity: TEntity): entity is TEntity & { stepLimitPercent: number } {
  return entity.controlMode === "stepped" && entity.stepLimitPercent !== null;
}

/** The array's slug, with a last-resort fallback so it is never empty. */
export function pvSlug(entity: Pick<PvEntity, "id" | "title">): string {
  return slugifyTitle(entity.title) || `pv_${slugifyTitle(entity.id)}`;
}

/**
 * The Home Assistant event type this array's generation limit goes out on.
 *
 * `pv_limit` rather than a bare `curtail`, for the reason a battery's is
 * `target_power` rather than `target`: an array growing a second kind of limit
 * later — a reactive power setpoint, an export cap that is not about price —
 * needs somewhere to go that does not collide with this one.
 *
 * One type per array rather than one shared type with the array named in the
 * payload, for the same reason as batteries: an automation's event trigger then
 * says which array it is for in the line that is hardest to get wrong, where a
 * shared type plus an `event_data` filter puts the identity somewhere easy to
 * leave off — in which case the automation quietly curtails every inverter in
 * the house from one array's limit.
 */
export function pvLimitEventType(slug: string): string {
  return `elias_ems_${slug}_pv_limit`;
}

/**
 * Why two arrays may not have names that slugify the same way.
 *
 * "South roof" and "south-roof" are different titles and the same event type,
 * which would leave both arrays taking each other's limits with nothing
 * anywhere reporting a problem. Checked in the settings action rather than in
 * `parsePvEntity`, because it needs the other arrays and this module is pure;
 * the constant lives here so the message cannot drift from the rule.
 */
export const DUPLICATE_PV_SLUG_ERROR =
  "Another PV array already has this name — both would publish to the same event.";

/**
 * An optional rated power. Unlike a plain number read this has to tell a field
 * left empty from one filled in with nonsense: the first is a valid "not
 * configured", the second is a typo, and reporting them the same way would let
 * a mistyped rating through as "no rating" — which silently makes the array
 * uncurtailable rather than saying what is wrong with it.
 */
/**
 * An optional whole percentage. Separate from `readOptionalPowerW` because 0 is
 * a meaningful answer here — "stop this array entirely" — where a rating of 0 W
 * is not.
 */
function readOptionalPercent(
  formData: FormData,
  name: string,
): { ok: true; value: number | null } | { ok: false } {
  const raw = formData.get(name)?.toString().trim();
  if (!raw) return { ok: true, value: null };

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return { ok: false };
  }
  return { ok: true, value };
}

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

export function parsePvEntity(
  formData: FormData,
):
  | { ok: true; fields: PvEntityFields }
  | { ok: false; errors: PvEntityErrors } {
  const title = formData.get("title")?.toString().trim() ?? "";
  const powerEntityId = formData.get("powerEntityId")?.toString().trim() ?? "";
  const energyEntityId =
    formData.get("energyEntityId")?.toString().trim() ?? "";
  // An unchecked checkbox sends nothing at all, which is what makes the absent
  // case mean "watched, not curtailed".
  const curtailable = formData.get("curtailable") === "on";
  const ratedPowerW = readOptionalPowerW(formData, "ratedPowerW");
  const rawMode = formData.get("controlMode")?.toString();
  const controlMode: PvControlMode = isPvControlMode(rawMode)
    ? rawMode
    : "modulating";
  const stepLimitPercent = readOptionalPercent(formData, "stepLimitPercent");

  const errors: PvEntityErrors = {};

  if (!title) {
    errors.title = "Give this array a name.";
  } else if (slugifyTitle(title) === "") {
    // The title is what the event type is built from, so a name made entirely
    // of punctuation or emoji has nothing to build one out of. Rejected here
    // rather than papered over with the record id, which would leave the
    // settings page showing a name and the automation needing another.
    errors.title = "Give this array a name with at least one letter or digit.";
  }
  if (!powerEntityId) errors.powerEntityId = "Pick the current power entity.";
  if (!energyEntityId) {
    errors.energyEntityId = "Pick the total energy entity.";
  }

  if (!ratedPowerW.ok) {
    errors.ratedPowerW = "Rated power must be a number above 0.";
  } else if (curtailable && ratedPowerW.value === null) {
    // Only required once the box is ticked: an array nobody is curtailing has
    // no use for a rating, and demanding one would make every existing entry
    // un-editable until a number was invented for it.
    errors.ratedPowerW =
      "Curtailment needs the inverter's rated power — the limit is a percentage of it.";
  }

  if (!stepLimitPercent.ok) {
    errors.stepLimitPercent =
      "The fixed limit must be a whole percentage between 0 and 100.";
  } else if (
    controlMode === "stepped" &&
    curtailable &&
    stepLimitPercent.value === null
  ) {
    // Required only where it is actually used. A stepped array that nobody is
    // curtailing is never commanded at all, so demanding a number for it would
    // be asking about a decision that is not being made.
    errors.stepLimitPercent =
      "A stepped inverter is held at one fixed limit while curtailing — say which.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    fields: {
      title,
      powerEntityId,
      energyEntityId,
      // Known good here: an unparseable one is an error above.
      ratedPowerW: ratedPowerW.ok ? ratedPowerW.value : null,
      curtailable,
      controlMode,
      stepLimitPercent: stepLimitPercent.ok ? stepLimitPercent.value : null,
    },
  };
}
