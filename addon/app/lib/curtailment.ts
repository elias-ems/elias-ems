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

/**
 * Which rule decides what happens in the marginal region — the band of prices
 * *above* the threshold, where a kWh put on the grid still earns something, but
 * not much.
 *
 * Below the threshold every strategy does the same thing: the feedback law in
 * `curtail.ts`, aimed at `gridTargetW`. They differ only between "exporting is
 * costing me money" and "exporting is clearly worth it", and `threshold` is the
 * answer the feature shipped with — nothing at all, release everything the
 * moment exporting stops costing money.
 *
 * Stored as an id for the reason `control.ts` stores its own that way: another
 * rule is one more entry here and one more branch in the plan, with nothing
 * already on disk needing to change.
 */
export type CurtailmentStrategyId =
  | "threshold"
  | "soft-ceiling"
  | "graded-export";

/**
 * One step of the marginal region, ordered by how far above the threshold it
 * reaches.
 *
 * Both values are percentages, which is what lets the same six numbers keep
 * their meaning when the strategy is switched. It also makes the defaults suit
 * a 5 kW house as well as a 10 kW one — a default in watts would be wrong for
 * everyone except whoever picked it.
 */
export type CurtailmentBand = {
  /**
   * The band's upper edge, as an offset **above** `priceThresholdPerKwh`, in
   * currency/kWh. A price falls in the first band whose edge it is under; one
   * past the last edge is released outright.
   */
  abovePerKwh: number;
  /** `soft-ceiling`: the cap on each array, in percent of its own rating. */
  ceilingPercent: number;
  /**
   * `graded-export`: what may cross the meter, in percent of the combined
   * rating of the arrays taking part. 100 means "as much as they could possibly
   * make", which amounts to not being held back at all.
   */
  exportPercent: number;
};

/** Exactly this many, so the settings form is a fixed shape with no rows to add. */
export const CURTAILMENT_BAND_COUNT = 3;

export const CURTAILMENT_STRATEGIES: Array<{
  id: CurtailmentStrategyId;
  label: string;
  description: string;
}> = [
  {
    id: "threshold",
    label: "Threshold only",
    description:
      "Hold the arrays back below the threshold and release them entirely above it, with nothing in between.",
  },
  {
    id: "soft-ceiling",
    label: "Soft ceiling",
    description:
      "Above the threshold, cap each inverter at a percentage of its own rating that relaxes as the price climbs. Never reads the meter, so it is a ceiling rather than a cut: it binds around noon and does nothing at dusk.",
  },
  {
    id: "graded-export",
    label: "Graded export",
    description:
      "Above the threshold, let a share of what the arrays could make cross the meter, growing as the price climbs. Uses the same feedback law as below the threshold, so the battery still gets first refusal.",
  },
];

export function isCurtailmentStrategyId(
  value: unknown,
): value is CurtailmentStrategyId {
  return CURTAILMENT_STRATEGIES.some((strategy) => strategy.id === value);
}

export type CurtailmentConfig = {
  enabled: boolean;
  /** Which rule applies above the threshold. See `CurtailmentStrategyId`. */
  strategy: CurtailmentStrategyId;
  /**
   * The marginal region, ascending by price, always `CURTAILMENT_BAND_COUNT`
   * long once normalized.
   *
   * Ignored entirely by `threshold`, and *shared* by the other two rather than
   * held per strategy, so that switching between them keeps whatever was tuned
   * instead of quietly starting again from the defaults.
   */
  bands: CurtailmentBand[];
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
 *
 * The strategy is `threshold` for the same reason: it is what the feature did
 * before there was a choice, so an existing installation behaves identically
 * until somebody picks otherwise. The bands are still filled in, so choosing a
 * strategy is one click rather than one click and six numbers.
 */
export const DEFAULT_CURTAILMENT_CONFIG: CurtailmentConfig = {
  enabled: false,
  strategy: "threshold",
  bands: [
    { abovePerKwh: 0.01, ceilingPercent: 70, exportPercent: 33 },
    { abovePerKwh: 0.02, ceilingPercent: 80, exportPercent: 67 },
    { abovePerKwh: 0.03, ceilingPercent: 90, exportPercent: 100 },
  ],
  priceThresholdPerKwh: 0,
  gridTargetW: 0,
  deadbandW: 50,
  minLimitPercent: 5,
  settleSeconds: 30,
};

export const MAX_BAND_ABOVE_PER_KWH = 10;
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
 * What a `curtailment.json` may actually contain, as opposed to what a valid
 * one contains.
 *
 * Not `Partial<CurtailmentConfig>`: a band on disk can be half-written too, and
 * saying so here is what lets `normalizeBands` be typed honestly rather than
 * casting at the one place the file is read.
 */
export type StoredCurtailmentConfig = Omit<
  Partial<CurtailmentConfig>,
  "bands"
> & {
  bands?: Partial<CurtailmentBand>[] | null;
};

/**
 * The bands, made safe to plan against.
 *
 * Two properties the strategies rely on and would be wrong without, so they are
 * established here once rather than defended against at every use:
 *
 * - **Always `CURTAILMENT_BAND_COUNT` of them.** Every `curtailment.json`
 *   written before strategies existed has no `bands` key at all, so the absent
 *   case is the *upgrade path* rather than an error, and it has to land on the
 *   defaults.
 * - **Edges never decreasing.** A price falls in the first band it is under, so
 *   an edge *below* the one before it makes its band unreachable — silently,
 *   and in a way nothing downstream could report. The running maximum drags
 *   such an edge up rather than dropping the band. Two *equal* edges are left
 *   alone: that only empties the later band, which is a legitimate way to ask
 *   for two steps instead of three, and the form rejects it anyway for anyone
 *   who did not mean it.
 */
function normalizeBands(
  stored: Partial<CurtailmentBand>[] | undefined | null,
): CurtailmentBand[] {
  const defaults = DEFAULT_CURTAILMENT_CONFIG.bands;
  let floor = 0;

  return defaults.map((fallback, index) => {
    const band = Array.isArray(stored) ? stored[index] : null;

    const edge = Math.max(
      floor,
      clamp(
        toFiniteNumber(band?.abovePerKwh, fallback.abovePerKwh),
        0,
        MAX_BAND_ABOVE_PER_KWH,
      ),
    );
    floor = edge;

    return {
      abovePerKwh: edge,
      ceilingPercent: clamp(
        Math.round(
          toFiniteNumber(band?.ceilingPercent, fallback.ceilingPercent),
        ),
        0,
        100,
      ),
      exportPercent: clamp(
        Math.round(toFiniteNumber(band?.exportPercent, fallback.exportPercent)),
        0,
        100,
      ),
    };
  });
}

/**
 * What to make of whatever is on disk.
 *
 * Every field is clamped rather than rejected: this runs on a file, not on a
 * form, and a hand-edited `minLimitPercent: 400` should leave the feature
 * working at 100 rather than leaving the loop with nothing to run.
 */
export function normalizeCurtailmentConfig(
  stored: StoredCurtailmentConfig | null,
): CurtailmentConfig {
  const defaults = DEFAULT_CURTAILMENT_CONFIG;

  return {
    enabled: stored?.enabled === true,
    // An unknown id means a downgrade or a hand-edited file. Falling back to
    // the rule the feature shipped with beats leaving the plan with no branch
    // to take.
    strategy: isCurtailmentStrategyId(stored?.strategy)
      ? stored.strategy
      : defaults.strategy,
    bands: normalizeBands(stored?.bands),
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

/** One band's worth of complaints, positionally matching `config.bands`. */
export type CurtailmentBandErrors = Partial<
  Record<keyof CurtailmentBand, string>
>;

export type CurtailmentErrors = Partial<
  Record<Exclude<keyof CurtailmentConfig, "bands">, string>
> & {
  /**
   * Kept positional rather than collapsed into one message so each row can
   * show its own: "the second edge is not above the first" is a thing to fix in
   * one field, and a single error above the group would leave the reader
   * counting rows to find which.
   */
  bands?: CurtailmentBandErrors[];
};

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

/**
 * What the form calls one band's one value. Shared with the component so a
 * renamed field cannot go out of step with the parser that reads it.
 */
export function bandFieldName(
  index: number,
  key: keyof CurtailmentBand,
): string {
  return `bands.${index}.${key}`;
}

/**
 * All `CURTAILMENT_BAND_COUNT` bands, or the complaints about them.
 *
 * Every band is required on every save, including under the `threshold`
 * strategy which reads none of them — the form posts the unused values as
 * hidden inputs precisely so that a spell with strategy off does not quietly
 * erase whatever was tuned for the other two.
 */
function parseBands(formData: FormData): {
  bands: CurtailmentBand[];
  errors: CurtailmentBandErrors[];
} {
  const bands: CurtailmentBand[] = [];
  const errors: CurtailmentBandErrors[] = [];
  let previousEdge: number | null = null;

  for (let index = 0; index < CURTAILMENT_BAND_COUNT; index += 1) {
    const fallback = DEFAULT_CURTAILMENT_CONFIG.bands[index];
    const bandErrors: CurtailmentBandErrors = {};

    const abovePerKwh = readNumber(
      formData,
      bandFieldName(index, "abovePerKwh"),
    );
    const ceilingPercent = readNumber(
      formData,
      bandFieldName(index, "ceilingPercent"),
    );
    const exportPercent = readNumber(
      formData,
      bandFieldName(index, "exportPercent"),
    );

    if (abovePerKwh === null || abovePerKwh <= 0) {
      bandErrors.abovePerKwh = "Band edge must be a price above zero.";
    } else if (previousEdge !== null && abovePerKwh <= previousEdge) {
      // Rejected rather than reordered: a band that does not reach past the one
      // before it is empty, and silently swallowing that would leave somebody
      // tuning a step no price can ever land in.
      bandErrors.abovePerKwh = `Band edge must be further above the threshold than the ${previousEdge} before it.`;
    } else {
      previousEdge = abovePerKwh;
    }

    for (const [key, value] of [
      ["ceilingPercent", ceilingPercent],
      ["exportPercent", exportPercent],
    ] as const) {
      if (
        value === null ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 100
      ) {
        bandErrors[key] = "Must be a whole percentage between 0 and 100.";
      }
    }

    bands.push({
      abovePerKwh: abovePerKwh ?? fallback.abovePerKwh,
      ceilingPercent: ceilingPercent ?? fallback.ceilingPercent,
      exportPercent: exportPercent ?? fallback.exportPercent,
    });
    errors.push(bandErrors);
  }

  return { bands, errors };
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

  const strategy = formData.get("strategy")?.toString();
  const bands = parseBands(formData);

  const errors: CurtailmentErrors = {};
  if (bands.errors.some((band) => Object.keys(band).length > 0)) {
    errors.bands = bands.errors;
  }

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
      strategy: isCurtailmentStrategyId(strategy)
        ? strategy
        : DEFAULT_CURTAILMENT_CONFIG.strategy,
      bands: bands.bands,
      priceThresholdPerKwh: priceThresholdPerKwh as number,
      gridTargetW: gridTargetW as number,
      deadbandW: deadbandW as number,
      minLimitPercent: minLimitPercent as number,
      settleSeconds: settleSeconds as number,
    },
  };
}
