/**
 * PV curtailment: hold the arrays back to what the house can absorb while a kWh
 * put on the grid earns less than it costs to make.
 *
 * Pure — no Home Assistant, no clock, no disk. Even "how long has the meter been
 * off target" arrives as two numbers rather than being measured here, which is
 * what makes the settle rule as directly testable as the arithmetic.
 *
 * ## The arithmetic
 *
 * Writing `G` for the grid reading (positive importing), `C` for what the
 * *curtailable* arrays are generating, `N` for what everything else is
 * generating, `L` for the load and `B` for the batteries (positive charging),
 * the house balances as
 *
 *     G + C + N = L + B
 *
 * Leaving `L` and `N` exactly where they are, the curtailable generation that
 * would put the meter at `G_target` with the batteries at `B_target` satisfies
 *
 *     G_target + C_allowed + N = L + B_target
 *
 * and subtracting one from the other gives the whole strategy:
 *
 *     C_allowed = C + (G - G_target) + (B_target - B)
 *
 * "what the arrays we can command are making now, plus however far the meter is
 * from where we want it, plus whatever a battery is delivering that the sun
 * could deliver instead". **The load and the uncurtailable arrays cancel out.**
 * We never measure the load — it is already inside `G` — and it is the same
 * feedback form as `S = C - net` in `net-zero.ts`, with the same property: a
 * wrong answer this tick is corrected on the next one instead of accumulating.
 *
 * `N` cancelling is the part that is easy to get wrong. An array nobody can
 * command is still generating, and its output is already in `G`; counting it
 * into `C` as well would ask the arrays we *can* command to give up what it is
 * producing on top of what the meter actually shows.
 *
 * ## Why a charging battery is free, and a discharging one is not
 *
 * `B_target` is `B` for as long as a battery is charging or idle, the last term
 * is zero, and the battery cancels out exactly like the load. That is the case
 * this feature was written around: if battery control is on and the battery has
 * room, it soaks up the surplus and drives `G` towards zero — so this computes
 * `C_allowed ≈ C` and cuts nothing. Only once the battery is full or at its
 * power limit does the export appear on the meter, and only then is anything
 * curtailed. Charging at a negative price before throwing generation away is the
 * right order, and it falls out of the arithmetic rather than needing to be
 * coordinated.
 *
 * A **discharging** battery is the case that does not cancel, and treating it as
 * though it did was wrong in a way that hid itself. `G` is what crosses the
 * meter *after* the battery has covered the house, so a battery stepping in
 * makes the meter read balanced while the house is in fact short of exactly what
 * the battery is delivering. The feedback term goes to zero, the limit stops
 * rising, and the arrays stay pinned at whatever they were last cut to — while
 * the battery empties into a house the sun was standing by to supply for
 * nothing.
 *
 * The two halves of this add-on will hold each other there indefinitely.
 * Net-zero discharges to cover the import that curtailment created, the meter
 * comes back to zero, and curtailment reads its own suppression as balance. Once
 * something else is holding the meter, *every* level of PV is an equilibrium,
 * which is what makes this a fixed point rather than a slow drift — the same
 * shape of trap as the one at zero below.
 *
 * So `B_target` is `min(B, 0)`: never discharging, and never a demand to charge
 * either. The term reduces to the net discharge, added back,
 *
 *     C_allowed = C + (G - G_target) + max(0, -B)
 *
 * which is the shortfall the meter would have shown had no battery stepped in.
 * It is what makes `G - G_target` mean the same thing whether or not one did.
 *
 * Nothing is commanded to the battery from here. This only stops the arrays
 * being held down, and a limit is a ceiling: raising one an array cannot reach
 * does nothing at all, which is why a dark array on a winter evening is left
 * undisturbed by the battery carrying the house. The battery yields on its own
 * — net-zero sees the surplus the arrays now make and stops discharging, and so
 * does an inverter running its own self-consumption logic. The exception is a
 * battery being *forced* to discharge into a negative price: it exports what it
 * discharges rather than yielding, and `warnings` says so rather than the arrays
 * being cut back to hide it.
 *
 * The gap is the few seconds before the battery ramps, where the surplus is on
 * the meter but about to be taken. That is what `settleSeconds` is for.
 *
 * ## Why a car charging on solar needs telling about
 *
 * A charger steered by evcc in solar mode is a *meter-following load*, and this
 * is a meter-following source limiter. Both drive `G` to their own target, and
 * whichever arrives first leaves the other with nothing to see. That is this
 * one: `settleSeconds` is shorter than a charger's ramp, so the arrays are cut
 * back to the house before the car ever enables — and then the equilibrium
 * holds, because with the meter on target `offBy` is zero every tick and the
 * limit never moves again. It is the same fixed point as the discharging
 * battery above, with the flexible thing on the load side of the meter.
 *
 * The battery case was fixable inside the arithmetic because a discharging
 * battery's contribution is *measurable*. A load throttled to nothing is not:
 * it is indistinguishable from a load that was never there, exactly as an array
 * pinned at 1 kW is indistinguishable from one that could make 5 kW. So nothing
 * added to `C_allowed` can recover it, and the fact that a car wants the surplus
 * arrives from outside the loop instead — `carChargingEntityId` in
 * `curtailment.ts`.
 *
 * What it does with it is put a **floor under the combined limit** rather than
 * an allowance on top of it:
 *
 *     C_allowed >= chargerPowerW - (everything generating that we are not
 *                                   modulating)
 *
 * The subtraction is what keeps it honest. An uncurtailable array, or a stepped
 * one holding its step, is already feeding the charger, and asking the
 * modulating arrays for the charger's full appetite on top of that would export
 * the difference at the very price this exists to avoid.
 *
 * The floor is expressed as a **moved target**, exactly the way
 * `graded-export`'s allowance is, so that the deadband, the settle rule, the
 * generation-proportional split and the floor at `minLimitPercent` all keep
 * working unchanged. Setting `C + (G - target) = floor` and solving gives the
 * target that produces it, and it is only ever taken when it is *lower* than the
 * one already in force — so a car can release generation and can never cause
 * any to be held back.
 *
 * Two consequences worth being explicit about:
 *
 * - **It under-allows by the house load**, deliberately. The charger's appetite
 *   is known and the house's is not, so the floor is the charger alone. The
 *   error is in the direction of exporting less than it might, which is the
 *   cheap direction here.
 * - **A charger bigger than the arrays means no curtailment at all**, and that
 *   falls out rather than being special-cased: the floor lands above what the
 *   arrays could ever make, so every one of them is released.
 *
 * ## Percent, not watts
 *
 * Inverters take curtailment as a percentage of their rated AC output, so that
 * is what goes out, quantised to whole percent. Two consequences worth being
 * explicit about:
 *
 * - **The percentage is of the rating, not of what the array could make right
 *   now.** 70% at noon is a real cut; 70% at dusk does nothing at all. What is
 *   published is a ceiling, not a scaling.
 * - **Measured generation under a ceiling says nothing about potential.** An
 *   array pinned at 1 kW might be capable of 1.1 kW or of 5 kW, and there is no
 *   way to tell from here. This is why the limit is only ever moved by the
 *   feedback term above — which asks for exactly the shortfall the meter shows —
 *   and never computed from what the array "should" be able to do.
 *
 * ## The fixed point at zero, and the floor that avoids it
 *
 * `C_allowed = C + (G - G_target)` has a trap. A dark array, an idle house and a
 * meter reading zero give `C_allowed = 0`, so the limit goes to 0%, so the array
 * stays dark, so the meter stays at zero. Nothing in the arithmetic ever lifts
 * it out again, and at dawn the array would simply not come back.
 * `minLimitPercent` is what breaks that cycle, which is why its default is not
 * zero. See `curtailment.ts`.
 */

import type { CurtailmentBand, CurtailmentConfig } from "./curtailment";
import type { PvControlMode } from "./pv-entities";

export type PvArraySnapshot = {
  id: string;
  title: string;
  /** Current generation in W — positive — or null when the sensor has no number. */
  powerW: number | null;
  /** The inverter's rated AC output in W. Null when nobody has configured one. */
  ratedPowerW: number | null;
  /**
   * Whether a limit may be published for this array at all. An array that is
   * not curtailable is still part of the house — its output is in the grid
   * reading — but it is not part of the plan.
   */
  curtailable: boolean;
  /** How often this inverter may be written to. See `PvEntityFields`. */
  controlMode: PvControlMode;
  /** `stepped` only: the fixed limit to hold it at, in percent of its rating. */
  stepLimitPercent: number | null;
};

/**
 * What a battery is doing right now, as far as curtailment is concerned.
 *
 * Every configured battery, steered or not, and deliberately so: this is
 * physics rather than authority. A battery nobody here commands discharges into
 * the same house and hides the same shortfall, and it is just as likely to be
 * the one doing it — an inverter running its own self-consumption logic needs
 * no automation to start covering the load.
 *
 * Only the power, because only the power is in the arithmetic. What the battery
 * *may* do — its window, its limits, whether it is steered — belongs to
 * `net-zero.ts`, and nothing is commanded from here.
 */
export type PvBatterySnapshot = {
  title: string;
  /** Current power in W — positive charging, negative discharging — or null. */
  powerW: number | null;
};

/**
 * An array that is commanded once per episode rather than continuously, with
 * both of the numbers that takes.
 */
type SteppedSnapshot = PvArraySnapshot & {
  ratedPowerW: number;
  stepLimitPercent: number;
};

function isStepped(array: PvArraySnapshot): array is SteppedSnapshot {
  return (
    array.controlMode === "stepped" &&
    array.stepLimitPercent !== null &&
    (array.ratedPowerW ?? 0) > 0
  );
}

export type PvAction =
  /** Hold this array below its rating. */
  | "curtail"
  /** Hand it back: generate whatever it can. */
  | "release"
  /** Leave the last limit standing, whatever it was. */
  | "hold";

export type PvArrayDecision = {
  arrayId: string;
  title: string;
  action: PvAction;
  /**
   * Where the array should be, as a percentage of its rating, or null when
   * there is nothing to say about it.
   */
  limitPercent: number | null;
  /** The same limit in watts, for the log and for an inverter that wants watts. */
  limitW: number | null;
  /**
   * What to command, or **null to say nothing and leave the last limit
   * standing**.
   *
   * Not the same as `limitPercent`, for the reason `net-zero.ts` separates
   * `targetW` from `commandW`: a hold inside the deadband reports where the
   * array is, which is the right thing to display and the wrong thing to
   * command.
   */
  commandPercent: number | null;
  /**
   * Whether this is the add-on letting go rather than steering. The percentage
   * is 100 either way, but an automation that has to clear a limit register
   * needs to tell "generate everything" from "I am no longer in charge of you".
   */
  released: boolean;
  currentW: number | null;
  /** Why this decision, in a few words. */
  reason: string;
  /** The whole thing as one line, for the diagnostics log. */
  message: string;
};

export type CurtailPlan = {
  /** Whether the price says PV should be held back at all right now. */
  curtailing: boolean;
  /** Net grid power in W: positive importing, negative exporting. Null when unreadable. */
  netW: number | null;
  /**
   * The **curtailable** arrays' combined generation right now, in W.
   *
   * Deliberately not every array: this is the `C` in `C_allowed = C + (G -
   * G_target)`, and including an array nothing can command would make the
   * arithmetic ask the others to give up what it is already producing.
   */
  curtailablePvW: number;
  /** The combined limit that would put the meter on target, or null when unknowable. */
  combinedAllowedW: number | null;
  /**
   * What the batteries are delivering to the house, in W, as a positive
   * magnitude — netted across them, and zero when they are idle or charging.
   *
   * The `max(0, -B)` term of the arithmetic above, reported rather than merely
   * used: a limit that rose because a battery was discharging is otherwise
   * indistinguishable in the log from one that rose because the kettle went on.
   */
  batteryDischargeW: number;
  /**
   * Whether the meter is far enough from the target to be worth acting on.
   *
   * The loop uses this to run the settle clock: it is the answer to "is
   * something happening", and the timestamp of the first tick that said yes is
   * what `offTargetSinceMs` carries back in.
   */
  offTarget: boolean;
  decisions: PvArrayDecision[];
  summary: string;
  /** Things that made the answer less trustworthy but didn't prevent one. */
  warnings: string[];
};

export type CurtailInput = {
  /** Net grid power in W: positive importing, negative exporting. Null when unreadable. */
  gridPowerW: number | null;
  arrays: PvArraySnapshot[];
  /**
   * Every configured battery. Empty is an ordinary house rather than a missing
   * reading — panels and no battery — and reads as nothing discharging.
   */
  batteries: PvBatterySnapshot[];
  /**
   * What a kWh put on the grid earns right now, with the contract applied.
   * Null when there is no forecast, the slot has run out, or the production
   * formula does not parse — all of which mean "we do not know", and none of
   * which mean "zero".
   */
  productionPricePerKwh: number | null;
  /** The currency those prices are in, for the log. */
  currency: string;
  config: CurtailmentConfig;
  /**
   * Whether a car wants the surplus right now — `carChargingEntityId` read as a
   * boolean — or **null when it cannot be read**, which includes there being no
   * entity configured at all.
   *
   * Null is treated as "no car" rather than as "a car, to be safe": a sensor
   * that has gone quiet would otherwise switch curtailment off for as long as it
   * stayed quiet, and unlike everything in `Failing open` below, that failure
   * costs money in the direction the feature exists to prevent. It is warned
   * about instead.
   */
  carCharging: boolean | null;
  /** Now, in epoch milliseconds. Passed in so this stays a pure function. */
  nowMs: number;
  /**
   * When the meter first went off target, in epoch milliseconds, or null when
   * it is on target or the run has only just started. Maintained by the loop
   * from the previous tick's `offTarget`.
   */
  offTargetSinceMs: number | null;
};

function signed(watts: number): string {
  const rounded = Math.round(watts);
  return `${rounded > 0 ? "+" : ""}${rounded} W`;
}

function magnitude(watts: number): string {
  return `${Math.abs(Math.round(watts))} W`;
}

/**
 * Formatted with a fixed number of decimals rather than `toLocaleString`, for
 * the reason `net-zero.ts` formats kWh that way: these strings go into the
 * diagnostics log, which is compared against in tests and read by whoever is
 * diagnosing an installation, and neither wants the separators to depend on the
 * server's locale.
 */
function price(value: number, currency: string): string {
  return `${value.toFixed(4)} ${currency}/kWh`;
}

/**
 * What the batteries are taking off the house's hands, as a positive number of
 * watts, or zero when they are idle or charging.
 *
 * **Netted across the batteries, not summed per battery**, which matters in the
 * one house that has both: one charging at 2 kW while another discharges at
 * 2 kW is contributing nothing to the load between them, and asking the arrays
 * to cover the discharge would be asking them to cover the charge twice.
 *
 * A battery whose power sensor has no number counts as zero rather than being
 * guessed at, which under-credits rather than over-credits — the arrays stay
 * where they are instead of being handed an allowance built on an invention.
 * The caller warns; see `planCurtailment`.
 */
function batteryDischargeOf(batteries: PvBatterySnapshot[]): number {
  const netW = batteries.reduce(
    (total, battery) => total + (battery.powerW ?? 0),
    0,
  );
  return Math.max(0, -netW);
}

/**
 * Which step of the marginal region a price falls in, or null when it is past
 * the top of it — clear of the whole thing, and so not held back at all.
 *
 * `threshold` has no marginal region by definition: it is the rule that says
 * the moment exporting stops costing money, stop interfering. Answering null
 * for it here rather than at each call site is what keeps the two other
 * strategies from having to know it exists.
 */
function bandFor(
  config: CurtailmentConfig,
  abovePerKwh: number,
): CurtailmentBand | null {
  if (config.strategy === "threshold") return null;
  return config.bands.find((band) => abovePerKwh < band.abovePerKwh) ?? null;
}

/** The top of the marginal region, for saying in the log what was cleared. */
function lastBandEdge(config: CurtailmentConfig): number {
  return config.bands.reduce(
    (highest, band) => Math.max(highest, band.abovePerKwh),
    0,
  );
}

/** A decision that says nothing and leaves whatever was last published standing. */
function hold(
  array: PvArraySnapshot,
  reason: string,
  limitPercent: number | null = null,
): PvArrayDecision {
  return {
    arrayId: array.id,
    title: array.title,
    action: "hold",
    limitPercent,
    limitW:
      limitPercent !== null && array.ratedPowerW !== null
        ? Math.round((limitPercent * array.ratedPowerW) / 100)
        : null,
    commandPercent: null,
    released: false,
    currentW: array.powerW,
    reason,
    message: `${array.title}: hold — ${reason}`,
  };
}

/**
 * Hand an array back. Always commands, never merely holds: an array left pinned
 * at 10% because the thing that pinned it stopped being sure of itself loses
 * money on every sunny day afterwards, and nothing on the dashboard would look
 * wrong. Releasing is the safe direction here, which is the exact opposite of
 * battery control, where 0 W is.
 */
function release(array: PvArraySnapshot, reason: string): PvArrayDecision {
  return {
    arrayId: array.id,
    title: array.title,
    action: "release",
    limitPercent: 100,
    limitW: array.ratedPowerW,
    commandPercent: 100,
    released: true,
    currentW: array.powerW,
    reason,
    message: `${array.title}: release — ${reason}`,
  };
}

/** Every array handed back, with one reason between them. */
function releaseAll(
  input: CurtailInput,
  summary: string,
  reason: string,
  extra: Partial<CurtailPlan> = {},
): CurtailPlan {
  return {
    curtailing: false,
    netW: input.gridPowerW,
    curtailablePvW: 0,
    combinedAllowedW: null,
    // Reported on every path, released ones included: it is an observation
    // about the house rather than part of this decision, and a log that only
    // mentioned the battery when it had been acted on would make it look as
    // though nothing else had ever been looked at.
    batteryDischargeW: batteryDischargeOf(input.batteries),
    offTarget: false,
    decisions: input.arrays.map((array) =>
      array.curtailable
        ? release(array, reason)
        : hold(array, NOT_CURTAILABLE_REASON),
    ),
    summary,
    warnings: [],
    ...extra,
  };
}

/** Why an array nobody asked to be curtailed sits out every plan. */
export const NOT_CURTAILABLE_REASON = "not curtailable";

/**
 * Why a write-averse inverter is brought back up for a car.
 *
 * Named rather than written inline because it is said on four paths — acting,
 * holding inside the deadband, settling, and above the threshold — and a
 * stepped array reading four different explanations for one decision would
 * suggest four different decisions.
 */
export const CAR_STEPPED_REASON =
  "stepped — a car is taking more than the modulating arrays can make";

/**
 * Whether an array can take part in *this* tick's plan.
 *
 * A missing power reading takes the array out rather than being assumed to be
 * zero, and that is a departure from what `net-zero.ts` does with a battery.
 * The reason is that the error would not self-correct. Assuming zero
 * understates `C`, so `C_allowed = C + (G - G_target)` comes out low, so the
 * array is cut; the cut shows up on the meter as import, which raises
 * `C_allowed` — but only back to the same understated fixed point. The array
 * settles at the floor with the house importing to cover it, quietly and
 * indefinitely. Dropping it out instead makes it one of the arrays that cancel,
 * which leaves the arithmetic correct for everything else.
 */
function participates(array: PvArraySnapshot): boolean {
  return (
    array.curtailable &&
    (array.ratedPowerW ?? 0) > 0 &&
    array.powerW !== null &&
    // A stepped array is held at a number somebody typed in, so it is not part
    // of the feedback law at all. It cancels out of it exactly the way an
    // uncurtailable array does — it is generating something, that something is
    // already inside the grid reading, and nothing here is going to move it.
    // Counting it into `C` would ask the modulating arrays to give up what it
    // is producing on top of what the meter already shows.
    array.controlMode !== "stepped"
  );
}

/**
 * A stepped array taking its step: the one command it gets per episode.
 *
 * No arithmetic, because that is the point. The number was typed in against
 * this inverter's rating, and it does not move while the price stays below the
 * threshold — which is what keeps the write count at one going in and one
 * coming out.
 */
function step(array: SteppedSnapshot, note = ""): PvArrayDecision {
  const percent = array.stepLimitPercent;
  const limitW = Math.round((percent * array.ratedPowerW) / 100);
  const reason = `step ${percent}% (${limitW} W of ${array.ratedPowerW} W)${note}`;

  return {
    arrayId: array.id,
    title: array.title,
    action: percent >= 100 ? ("release" as const) : ("curtail" as const),
    limitPercent: percent,
    limitW,
    commandPercent: percent,
    released: percent >= 100,
    currentW: array.powerW,
    reason,
    message: `${array.title}: ${reason}`,
  };
}

export function planCurtailment(input: CurtailInput): CurtailPlan {
  const { gridPowerW, arrays, productionPricePerKwh, currency, config } = input;
  const { gridTargetW, deadbandW, minLimitPercent, priceThresholdPerKwh } =
    config;

  const configured = arrays.filter(
    (array) => array.curtailable && (array.ratedPowerW ?? 0) > 0,
  );

  if (configured.length === 0) {
    return releaseAll(
      input,
      "No PV array is curtailable — nothing to hold back.",
      NOT_CURTAILABLE_REASON,
    );
  }

  /**
   * Whether a car is asking for the surplus. Both halves of the setting are
   * needed: a sensor with no charger power would open onto a floor of zero and
   * change nothing, which is an installation that looks configured and behaves
   * exactly as though it were not.
   */
  const carWantsSurplus =
    config.carChargingEntityId !== "" &&
    config.chargerPowerW > 0 &&
    input.carCharging === true;

  /**
   * Whether the stepped arrays are needed to feed the charger.
   *
   * **Decided from the ratings alone**, with no reading anywhere in it, and that
   * is the point rather than an approximation. A stepped inverter commits every
   * write to non-volatile memory, so a test built on generation would spend that
   * budget every time a cloud moved it across the boundary. This one can only
   * change when somebody edits the settings page, which makes it two writes per
   * car — one to release, one to take the step back afterwards — and it is
   * answerable in a sentence on that page: *your charger can take more than the
   * modulating arrays can make, so the stepped ones come up too.*
   *
   * When it is false the stepped arrays keep their step and the modulating ones
   * carry the charger, which is the right trade the other way round: releasing a
   * 5 kW inverter to feed a 3.7 kW charger exports the difference and spends two
   * writes to do it.
   */
  const modulatingRatedW = configured
    .filter((array) => array.controlMode !== "stepped")
    .reduce((total, array) => total + (array.ratedPowerW ?? 0), 0);
  const releaseSteppedForCar =
    carWantsSurplus && config.chargerPowerW > modulatingRatedW;

  // Fail open, and this is the rule the whole feature is built around: every
  // way of not knowing ends with the arrays generating. A price we cannot read
  // is not a negative price, and treating it as one would throw away generation
  // on the strength of a broken sensor.
  if (productionPricePerKwh === null) {
    return releaseAll(
      input,
      "No injection price for right now — releasing the arrays.",
      "the injection price is unknown",
    );
  }

  /**
   * Every path below goes through here, which is what keeps the two kinds of
   * array from drifting apart: one place decides what a stepped inverter does
   * under each rule, rather than each rule remembering to ask.
   *
   * A stepped array holds by default. "Say nothing" leaves whatever it was last
   * told standing, which is precisely what it should do between the one command
   * that starts an episode and the one that ends it.
   */
  const steppedDefault = (array: SteppedSnapshot): PvArrayDecision =>
    releaseSteppedForCar
      ? release(array, CAR_STEPPED_REASON)
      : hold(
          array,
          "stepped — leaving its step where it is",
          array.stepLimitPercent,
        );

  const decide = (
    reasonFor: (array: PvArraySnapshot) => PvArrayDecision,
    steppedReasonFor: (
      array: SteppedSnapshot,
    ) => PvArrayDecision = steppedDefault,
  ): PvArrayDecision[] =>
    arrays.map((array) => {
      if (!array.curtailable) return hold(array, NOT_CURTAILABLE_REASON);
      if ((array.ratedPowerW ?? 0) <= 0) {
        return hold(array, "no rated power configured");
      }

      // Deliberately before the power-reading guard below. A stepped array is
      // commanded with a number that was typed in rather than derived from a
      // reading, so its own sensor going quiet is no reason to touch it — and
      // releasing it over a sensor blip would spend a write on the very
      // hardware this mode exists to protect.
      if (array.controlMode === "stepped") {
        // Somebody said this inverter must not be written to continuously but
        // never said what to hold it at. Modulating it anyway would do the one
        // thing the mode exists to prevent, so it is left alone entirely.
        if (!isStepped(array)) {
          return hold(array, "stepped, but no fixed limit configured");
        }
        return steppedReasonFor(array);
      }

      if (array.powerW === null) {
        return release(array, "power reading unavailable");
      }
      return reasonFor(array);
    });

  // How far above the threshold the price sits, and which step of the marginal
  // region that is. Negative means below the threshold, where every strategy
  // does the same thing and `band` is deliberately not consulted.
  const abovePerKwh = productionPricePerKwh - priceThresholdPerKwh;
  const band = abovePerKwh >= 0 ? bandFor(config, abovePerKwh) : null;

  if (abovePerKwh >= 0 && band === null) {
    return releaseAll(
      input,
      `Injection at ${price(productionPricePerKwh, currency)} — ${config.strategy === "threshold" ? `at or above the ${price(priceThresholdPerKwh, currency)} threshold` : `clear of the ${price(priceThresholdPerKwh + lastBandEdge(config), currency)} top band`}, nothing to curtail.`,
      `injection at ${price(productionPricePerKwh, currency)}`,
    );
  }

  // Past here the price says hold back to some degree, and only a reading can
  // stop us.
  const priceClause =
    band === null
      ? `injection at ${price(productionPricePerKwh, currency)}, below the ${price(priceThresholdPerKwh, currency)} threshold`
      : `injection at ${price(productionPricePerKwh, currency)}, within ${price(band.abovePerKwh, currency)} of the ${price(priceThresholdPerKwh, currency)} threshold`;

  // The soft ceiling is decided here, before the grid is even looked at, and
  // that is the whole character of it: a fixed share of each inverter's rating
  // for as long as the price stays in this band. Nothing to balance against
  // means nothing that can go wrong with the balancing, and it is the one
  // strategy that still works with an unreadable meter.
  //
  // The cost is that it is a *ceiling* and not a cut. 70% of nameplate binds
  // around noon and does nothing at dusk, and no amount of measuring afterwards
  // would tell it the difference.
  // A ceiling has no feedback term, so there is no target for a charger's
  // appetite to move and no way to hand the car *just enough*. The only thing it
  // can do for one is get out of the way — and in the marginal band that is the
  // easy trade to make: the choice is between selling a kWh for very little and
  // putting it into a car for nothing.
  if (band !== null && config.strategy === "soft-ceiling" && carWantsSurplus) {
    return releaseAll(
      input,
      `${priceClause}. A car is charging — a ceiling cannot make room for it, so the arrays are released.`,
      "a car is charging",
      { curtailing: true },
    );
  }

  if (band !== null && config.strategy === "soft-ceiling") {
    const ceilingPercent = Math.min(
      100,
      Math.max(minLimitPercent, Math.round(band.ceilingPercent)),
    );

    return {
      curtailing: true,
      netW: gridPowerW,
      curtailablePvW: arrays
        .filter(participates)
        .reduce((total, array) => total + (array.powerW ?? 0), 0),
      combinedAllowedW: null,
      // Observed and reported, but not acted on: this strategy never reads the
      // meter, so it has no feedback term for a discharge to be added back to.
      // A house whose battery is carrying it while a ceiling holds the arrays
      // down wants `graded-export`, for the same reason it wants it to hold the
      // house near zero at all.
      batteryDischargeW: batteryDischargeOf(input.batteries),
      // No meter, so nothing is ever off target and the loop's settle clock
      // stays cleared. A ceiling moves when the price moves into another band,
      // which is its own pacing and does not want a second one on top.
      offTarget: false,
      decisions: decide(
        (array) => {
          const rated = array.ratedPowerW as number;
          const limitW = Math.round((ceilingPercent * rated) / 100);
          const reason = `ceiling ${ceilingPercent}% (${limitW} W of ${rated} W, now ${magnitude(array.powerW as number)})`;

          return {
            arrayId: array.id,
            title: array.title,
            action:
              ceilingPercent >= 100
                ? ("release" as const)
                : ("curtail" as const),
            limitPercent: ceilingPercent,
            limitW,
            commandPercent: ceilingPercent,
            released: ceilingPercent >= 100,
            currentW: array.powerW,
            reason,
            message: `${array.title}: ${reason}`,
          };
        },
        // The marginal region is exactly where a fixed step is the wrong tool:
        // the whole point of a band is a gradation, and a stepped inverter has
        // no gradations to offer. Spending a write to hold it back for a kWh
        // that still earns something is the worse trade, so it generates.
        (array) =>
          release(array, "stepped — not worth a write above the threshold"),
      ),
      summary: `${priceClause}. Soft ceiling — holding every modulating array at ${ceilingPercent}% of its rating.`,
      warnings: [],
    };
  }

  if (gridPowerW === null) {
    return releaseAll(
      input,
      "The grid power sensor is not readable — releasing the arrays.",
      "no grid reading to balance against",
      // Still true, and worth reporting: the price is what it is regardless of
      // whether we can act on it, and a log that said otherwise would be lying
      // about why nothing is being curtailed.
      { curtailing: true },
    );
  }

  const warnings: string[] = [];
  const participating = arrays.filter(participates);

  for (const array of configured) {
    if (array.powerW === null) {
      warnings.push(
        `${array.title}: power reading unavailable, releasing it rather than guessing`,
      );
    }
  }

  const curtailablePvW = participating.reduce(
    (total, array) => total + (array.powerW ?? 0),
    0,
  );

  /**
   * Arrays that take a step rather than following the meter. Counted here
   * because "nothing to modulate" and "nothing to do" are different states: a
   * house whose only curtailable inverter is a stepped one has no feedback loop
   * to run and still has a step to take.
   */
  const steppedCount = configured.filter(
    (array) => array.controlMode === "stepped",
  ).length;

  if (participating.length === 0 && steppedCount === 0) {
    return releaseAll(
      input,
      `${priceClause}, but no curtailable array has a usable power reading — releasing them.`,
      "power reading unavailable",
      { curtailing: true, warnings },
    );
  }

  /** The fallback denominator for the split, and what an export share is of. */
  const ratedTotal = participating.reduce(
    (total, array) => total + (array.ratedPowerW ?? 0),
    0,
  );

  // Graded export is one number and nothing else: how far the meter is allowed
  // to sit *below* the configured target while the price is only marginally
  // worth selling at. Everything after this — the deadband, the settle rule,
  // the generation-proportional split, the floor — is the same code on a
  // different target, which is the reason to express it this way rather than as
  // a second control law.
  //
  // A share of the rating rather than a number of watts, so that the same
  // percentage means the same thing on any house, and so that an array which
  // drops out of `participating` takes its share of the allowance with it.
  const exportAllowanceW =
    band !== null && config.strategy === "graded-export"
      ? (Math.min(100, band.exportPercent) / 100) * ratedTotal
      : 0;
  const baseTargetW = gridTargetW - exportAllowanceW;

  const netW = gridPowerW;

  // The battery term, and the whole of why there is one — see the header. `G`
  // is what crosses the meter *after* a battery has covered the house, so a
  // discharging one hides exactly the shortfall this law is looking for and
  // leaves the arrays pinned wherever they were last cut to. Added back, the
  // error means the same thing whether or not a battery stepped in: how much
  // more the arrays could be making with the meter on target and nothing being
  // taken out of a battery to keep it there.
  const batteryDischargeW = batteryDischargeOf(input.batteries);

  // Warned about even though the answer is simply the one without it. An
  // unreadable battery is the case where the arrays quietly stay held back
  // while it empties, and that is precisely the failure this term exists to
  // end — so it says so rather than reporting a confident number built on a
  // sensor that is not there.
  for (const battery of input.batteries) {
    if (battery.powerW === null) {
      warnings.push(
        `${battery.title}: power reading unavailable, assuming it is not discharging`,
      );
    }
  }

  if (config.carChargingEntityId !== "" && input.carCharging === null) {
    warnings.push(
      `${config.carChargingEntityId} is unreadable, so nothing is being held open for a car`,
    );
  }
  if (config.carChargingEntityId !== "" && config.chargerPowerW <= 0) {
    warnings.push(
      "a car-charging sensor is configured but the charger's power is not, so nothing is being held open for a car",
    );
  }

  /**
   * What is generating that this tick is not modulating: the uncurtailable
   * arrays, the stepped ones, and any array dropped for want of a reading.
   *
   * Subtracted from the charger's appetite below, because all of it is already
   * feeding the charger. Asking the modulating arrays for the whole appetite on
   * top would export the difference at exactly the price this exists to avoid.
   */
  const otherPvW =
    arrays.reduce((total, array) => total + (array.powerW ?? 0), 0) -
    curtailablePvW;

  /** The lowest the combined limit may come out at while a car wants charge. */
  const chargerFloorW = carWantsSurplus
    ? Math.max(0, config.chargerPowerW - otherPvW)
    : 0;

  // The target that produces exactly that floor, from `C + (G - target) = floor`
  // with the battery term in place — the same rearrangement `graded-export`
  // makes, and the reason neither needed a second control law.
  //
  // `min`, so this can only ever move the target *down*: a car can release
  // generation and can never be the reason any is held back.
  const effectiveTargetW =
    chargerFloorW > 0
      ? Math.min(
          baseTargetW,
          netW + curtailablePvW + batteryDischargeW - chargerFloorW,
        )
      : baseTargetW;

  const meterOffBy = netW - effectiveTargetW;
  const offBy = meterOffBy + batteryDischargeW;
  const offTarget = Math.abs(offBy) >= deadbandW;
  const combinedAllowedW = curtailablePvW + offBy;

  // The one case the term above does not fix, and it must not pass silently. A
  // battery that goes on discharging while the arrays already cover the house
  // puts what it discharges out of the meter. Cutting the arrays back *would*
  // stop that export — by draining the battery to displace free generation,
  // which is the trade this whole term exists to refuse — so it is reported
  // rather than acted on. Ordinary for a tick or two while a battery yields;
  // standing, it means something is forcing the discharge.
  if (
    batteryDischargeW >= deadbandW &&
    meterOffBy <= -deadbandW &&
    !offTarget
  ) {
    warnings.push(
      `the battery is discharging ${magnitude(batteryDischargeW)} into a house the arrays already cover — that is what is going out of the meter`,
    );
  }

  const flow = netW > 0 ? "importing" : "exporting";
  const target =
    effectiveTargetW === 0
      ? "balanced"
      : `a ${signed(effectiveTargetW)} target`;
  /**
   * Named in every summary below for as long as it is happening, because the
   * meter stops being the whole story the moment it is. `-1959 W` beside a
   * battery discharging 1959 W is a house whose arrays are covering it exactly;
   * the same reading on its own is a house exporting at a price it is paying,
   * and a log that showed only the second would send somebody looking for a
   * fault in the wrong half of the system.
   */
  const batteryClause =
    batteryDischargeW > 0
      ? ` while the battery discharges ${magnitude(batteryDischargeW)}`
      : "";
  /**
   * Said on every path while it is true, for the same reason the battery is: a
   * limit that stopped moving because a car is being fed reads, in a log that
   * did not mention the car, exactly like a limit that stopped moving because
   * something is broken.
   */
  const carClause = !carWantsSurplus
    ? ""
    : chargerFloorW > 0
      ? ` A car is charging — the arrays may make ${magnitude(chargerFloorW)} before any of it is held back.`
      : " A car is charging, and the arrays nothing here modulates already cover the charger.";

  if (!offTarget) {
    return {
      curtailing: true,
      netW,
      curtailablePvW,
      combinedAllowedW,
      batteryDischargeW,
      offTarget: false,
      decisions: decide((array) =>
        hold(array, `grid within the ${deadbandW} W deadband`),
      ),
      summary: `${priceClause}. Grid net ${signed(netW)}${batteryClause} — ${target} within the ${deadbandW} W deadband, holding.${carClause}`,
      warnings,
    };
  }

  // The settle rule. Both directions, not just cutting: handing generation back
  // the instant a kettle switches off would be just as twitchy, and the cost of
  // waiting is a few seconds of a fifteen-minute price slot either way.
  //
  // Note what `offTargetSinceMs` means, because it is more than "when the meter
  // went off target": the loop restarts it every time a limit actually moves,
  // so this is equally the wait for the *last correction* to reach the meter.
  // Without that, `C` and `G` below would describe different instants and the
  // same watts would be corrected for twice.
  const settleMs = config.settleSeconds * 1000;
  const offTargetForMs =
    input.offTargetSinceMs === null ? 0 : input.nowMs - input.offTargetSinceMs;

  if (offTargetForMs < settleMs) {
    const waited = Math.max(0, Math.round(offTargetForMs / 1000));
    return {
      curtailing: true,
      netW,
      curtailablePvW,
      combinedAllowedW,
      batteryDischargeW,
      offTarget: true,
      decisions: decide((array) =>
        hold(
          array,
          `waiting for the meter to settle (${waited}s of ${config.settleSeconds}s)`,
        ),
      ),
      summary: `${priceClause}. Grid net ${signed(netW)} (${flow})${batteryClause} — settling, ${waited}s of ${config.settleSeconds}s.${carClause}`,
      warnings,
    };
  }

  // Proportional to what each array is generating right now, not to its rating.
  // An east array at 200 W and a south array at 4 kW should not be cut equally,
  // and a rating-proportional split would hand the small one a limit it cannot
  // reach while cutting the large one past what was asked for.
  const generating = participating.reduce(
    (total, array) => total + Math.max(0, array.powerW ?? 0),
    0,
  );

  const decisions = decide(
    (array) => {
      const rated = array.ratedPowerW as number;
      const powerW = array.powerW as number;

      // Rating-proportional only when nothing is generating at all — at night, or
      // with every array already pinned at the floor. Without the fallback the
      // split would be 0/0; with it as the *primary* rule the shape of the array
      // would be ignored whenever it mattered most.
      const share =
        generating > 0
          ? (combinedAllowedW * Math.max(0, powerW)) / generating
          : (combinedAllowedW * rated) / ratedTotal;

      const requestedPercent = (share / rated) * 100;
      const limitPercent = Math.min(
        100,
        Math.max(minLimitPercent, Math.round(requestedPercent)),
      );
      const limitW = Math.round((limitPercent * rated) / 100);

      const floored =
        requestedPercent < minLimitPercent
          ? `, floored at ${minLimitPercent}%`
          : "";
      const reason = `limit ${limitPercent}% (${limitW} W of ${rated} W${floored}, now ${magnitude(powerW)})`;

      return {
        arrayId: array.id,
        title: array.title,
        action:
          limitPercent >= 100 ? ("release" as const) : ("curtail" as const),
        limitPercent,
        limitW,
        commandPercent: limitPercent,
        // A limit that has come back to 100% is the add-on stepping out of the
        // way, and an automation clearing a register needs to hear that as
        // clearly as it heard the limit going on.
        released: limitPercent >= 100,
        currentW: powerW,
        reason,
        message: `${array.title}: ${reason}`,
      };
    },
    // The step is taken only against **export**, not against being off target in
    // either direction. Two consequences, and both are the point of the mode:
    //
    // Importing past the target means the house is swallowing everything the
    // arrays make, so there is nothing being sold at a loss and nothing to hold
    // back — and once stepped, this branch holding is what leaves the array where
    // it is rather than handing it back the moment a load switches on. It stays
    // down until the price recovers, which is one write in and one write out.
    //
    // On the way in, the same test means a surplus the battery is quietly
    // absorbing never costs a write at all: the meter is inside the deadband, so
    // this is never reached.
    //
    // The test is on `offBy` rather than on the meter, so the battery term is in
    // it here too, and that is the right way round: an export a battery's own
    // discharge accounts for is that battery's to stop, and spending one of a
    // finite number of writes to hide it — by holding an array down so the
    // battery can empty in its place — is the trade this mode exists to avoid
    // making twice over.
    (array) =>
      releaseSteppedForCar
        ? release(array, CAR_STEPPED_REASON)
        : offBy <= -deadbandW
          ? step(array)
          : hold(
              array,
              "stepped — no export to prevent, holding its step",
              array.stepLimitPercent,
            ),
  );

  return {
    curtailing: true,
    netW,
    curtailablePvW,
    combinedAllowedW,
    batteryDischargeW,
    offTarget: true,
    decisions,
    summary: `${priceClause}.${exportAllowanceW > 0 ? ` Graded export — up to ${magnitude(exportAllowanceW)} may cross the meter.` : ""} Grid net ${signed(netW)} (${flow})${batteryClause}, arrays at ${magnitude(curtailablePvW)} → allow ${magnitude(combinedAllowedW)} total.${carClause}`,
    warnings,
  };
}
