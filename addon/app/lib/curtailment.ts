/**
 * PV curtailment's shared model: what the settings form edits, what the home
 * page reports, and the validation between them. Pure, so both the server and
 * the browser bundle can have it — the strategy itself is `curtail.ts`, reading
 * and writing the config is `curtailment-config.server.ts`, and publishing a
 * limit is `pv-limits.server.ts`.
 *
 * The feature in one sentence: while a kWh put on the grid *earns less than*
 * `priceThresholdPerKwh`, hold the arrays back to roughly what the house and
 * its battery can absorb, so nothing is exported at a price we have to pay.
 */

export type CurtailmentConfig = {
  enabled: boolean;
  /**
   * Curtail while the **production** price is below this, in currency/kWh.
   *
   * The production leg with the contract applied, not the raw exchange price:
   * an injection fee can make a positive spot into a negative earning, and it
   * is what a kWh actually earns that decides whether exporting it is worth
   * doing. See `applyPrices` in `prices.ts` for why that is derived at read
   * time.
   *
   * Configurable rather than a hardcoded 0 because a contract with a
   * per-kWh injection fee has a break-even somewhere above zero, and because
   * somebody who wants to curtail only when it is really bad can say -0.05.
   */
  priceThresholdPerKwh: number;
  /**
   * Where on the meter to aim while curtailing, in W, signed the way the grid
   * reading is: **positive importing, negative exporting**.
   *
   * Zero means "balanced". A negative value keeps a little export as insurance
   * against dipping into import at the consumption price; a positive value
   * keeps a little import as insurance against exporting at a negative one.
   * Which of the two is cheaper depends on the contract, so it is a setting
   * rather than a decision made here.
   */
  gridTargetW: number;
  /**
   * How far the meter may sit from `gridTargetW` before the limit is moved.
   *
   * Below this the house counts as balanced and the limit is left alone;
   * chasing the noise would only cycle the inverter. Note that quantising to
   * whole percent already imposes a floor of one step — `ratedPowerW / 100` —
   * so a deadband under that does nothing the rounding was not already doing.
   */
  deadbandW: number;
  /**
   * The lowest limit an array may be given, in percent of its rating.
   *
   * Not merely a preference. `curtail.ts`'s feedback form has a fixed point at
   * zero — a dark array, an idle house and a meter reading zero would compute a
   * limit of 0%, which keeps the array dark, which keeps the meter at zero —
   * and this floor is what stops it settling there and never coming back. It is
   * independently a hardware requirement on inverters whose MPPT drops out
   * entirely at 0% and takes minutes to restart.
   */
  minLimitPercent: number;
  /**
   * How long the meter must stay off target before the limit is moved, in
   * seconds.
   *
   * This is what keeps curtailment from fighting the battery. Both features
   * correct against the same grid reading, and the battery ramps first; without
   * a settle time, curtailment would cut the surplus in the seconds before the
   * battery got to it, and then hand it back once the battery had. Cheap
   * insurance against a 15-minute price slot.
   */
  settleSeconds: number;
};

/**
 * Off, and otherwise the least surprising thing that could happen.
 *
 * The threshold is 0 — curtail when a kWh exported earns less than nothing,
 * which is what "negative prices" means to everyone who has not thought about
 * injection fees. The grid target is 0 rather than a hedge in either direction,
 * because guessing which way somebody's contract leans would be a wrong number
 * presented as a right one.
 */
export const DEFAULT_CURTAILMENT_CONFIG: CurtailmentConfig = {
  enabled: false,
  priceThresholdPerKwh: 0,
  gridTargetW: 0,
  deadbandW: 50,
  minLimitPercent: 5,
  settleSeconds: 30,
};

export const MIN_DEADBAND_W = 0;
export const MAX_DEADBAND_W = 5000;
export const MAX_GRID_TARGET_W = 20000;
export const MIN_SETTLE_SECONDS = 0;
export const MAX_SETTLE_SECONDS = 900;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * What to make of whatever is on disk.
 *
 * Every field is clamped rather than rejected: this runs on a file, not on a
 * form, and a hand-edited `minLimitPercent: 400` should leave the feature
 * working at 100 rather than leaving the loop with nothing to run.
 */
export function normalizeCurtailmentConfig(
  stored: Partial<CurtailmentConfig> | null,
): CurtailmentConfig {
  const defaults = DEFAULT_CURTAILMENT_CONFIG;

  return {
    enabled: stored?.enabled === true,
    priceThresholdPerKwh: toFiniteNumber(
      stored?.priceThresholdPerKwh,
      defaults.priceThresholdPerKwh,
    ),
    gridTargetW: clamp(
      toFiniteNumber(stored?.gridTargetW, defaults.gridTargetW),
      -MAX_GRID_TARGET_W,
      MAX_GRID_TARGET_W,
    ),
    deadbandW: clamp(
      toFiniteNumber(stored?.deadbandW, defaults.deadbandW),
      MIN_DEADBAND_W,
      MAX_DEADBAND_W,
    ),
    minLimitPercent: clamp(
      Math.round(
        toFiniteNumber(stored?.minLimitPercent, defaults.minLimitPercent),
      ),
      0,
      100,
    ),
    settleSeconds: clamp(
      Math.round(toFiniteNumber(stored?.settleSeconds, defaults.settleSeconds)),
      MIN_SETTLE_SECONDS,
      MAX_SETTLE_SECONDS,
    ),
  };
}

export type CurtailmentErrors = Partial<
  Record<keyof CurtailmentConfig, string>
>;

/**
 * Why curtailment cannot be switched on yet.
 *
 * Enabling it with nothing to hold back would produce a loop that decides
 * correctly and changes nothing — which looks identical, from the outside, to a
 * loop that is broken. The check lives in the settings action rather than here
 * because it needs the array list, and this module is pure; the constant is
 * here so the form's warning and the server's rejection cannot drift apart.
 */
export const NO_CURTAILABLE_ARRAY_ERROR =
  "At least one PV array needs to be curtailable, with its inverter's rated power filled in, before curtailment can be enabled.";

/**
 * Why curtailment cannot be switched on without prices.
 *
 * Separate from the one above because the fix is somewhere else entirely: the
 * arrays are fine and the price source is not configured. Without a price there
 * is no answer to "should we be curtailing", and the honest behaviour with no
 * answer is to generate — so an enabled feature would simply never act.
 */
export const NO_PRICES_ERROR =
  "Curtailment decides on the injection price, so dynamic prices have to be configured first.";

function readNumber(formData: FormData, name: string): number | null {
  const raw = formData.get(name)?.toString().trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function parseCurtailmentConfig(
  formData: FormData,
):
  | { ok: true; config: CurtailmentConfig }
  | { ok: false; errors: CurtailmentErrors } {
  const priceThresholdPerKwh = readNumber(formData, "priceThresholdPerKwh");
  const gridTargetW = readNumber(formData, "gridTargetW");
  const deadbandW = readNumber(formData, "deadbandW");
  const minLimitPercent = readNumber(formData, "minLimitPercent");
  const settleSeconds = readNumber(formData, "settleSeconds");

  const errors: CurtailmentErrors = {};

  // No range on the threshold beyond being a number: it is a price, and how
  // negative a price can get is the market's business rather than ours.
  if (priceThresholdPerKwh === null) {
    errors.priceThresholdPerKwh = "Price threshold must be a number.";
  }
  if (
    gridTargetW === null ||
    Math.abs(gridTargetW) > MAX_GRID_TARGET_W ||
    !Number.isInteger(gridTargetW)
  ) {
    errors.gridTargetW = `Grid target must be a whole number of watts between -${MAX_GRID_TARGET_W} and ${MAX_GRID_TARGET_W}.`;
  }
  if (
    deadbandW === null ||
    !Number.isInteger(deadbandW) ||
    deadbandW < MIN_DEADBAND_W ||
    deadbandW > MAX_DEADBAND_W
  ) {
    errors.deadbandW = `Deadband must be a whole number of watts between ${MIN_DEADBAND_W} and ${MAX_DEADBAND_W}.`;
  }
  if (
    minLimitPercent === null ||
    !Number.isInteger(minLimitPercent) ||
    minLimitPercent < 0 ||
    minLimitPercent > 100
  ) {
    errors.minLimitPercent =
      "Minimum limit must be a whole percentage between 0 and 100.";
  }
  if (
    settleSeconds === null ||
    !Number.isInteger(settleSeconds) ||
    settleSeconds < MIN_SETTLE_SECONDS ||
    settleSeconds > MAX_SETTLE_SECONDS
  ) {
    errors.settleSeconds = `Settle time must be a whole number of seconds between ${MIN_SETTLE_SECONDS} and ${MAX_SETTLE_SECONDS}.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      // An unchecked checkbox sends nothing at all, which is what makes the
      // absent case mean "off" here.
      enabled: formData.get("enabled") === "on",
      priceThresholdPerKwh: priceThresholdPerKwh as number,
      gridTargetW: gridTargetW as number,
      deadbandW: deadbandW as number,
      minLimitPercent: minLimitPercent as number,
      settleSeconds: settleSeconds as number,
    },
  };
}
