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
 * generating, `L` for the load and `B` for the battery, the house balances as
 *
 *     G + C + N = L + B
 *
 * Leaving `L`, `B` and `N` exactly where they are, the curtailable generation
 * that would put the meter at `G_target` satisfies
 *
 *     G_target + C_allowed + N = L + B
 *
 * and subtracting one from the other gives the whole strategy:
 *
 *     C_allowed = C + (G - G_target)
 *
 * "what the arrays we can command are making now, plus however far the meter is
 * from where we want it". **The load, the battery and the uncurtailable arrays
 * all cancel out.** We never measure the load, and we never reason about what
 * the battery is doing — both are already inside `G`. It is the same feedback
 * form as `S = C - net` in `net-zero.ts`, and it has the same property: a wrong
 * answer this tick is corrected on the next one instead of accumulating.
 *
 * `N` cancelling is the part that is easy to get wrong. An array nobody can
 * command is still generating, and its output is already in `G`; counting it
 * into `C` as well would ask the arrays we *can* command to give up what it is
 * producing on top of what the meter actually shows.
 *
 * ## Why the battery gets first refusal, for free
 *
 * If battery control is on and the battery has room, it soaks up the surplus and
 * drives `G` towards zero — so this computes `C_allowed ≈ C` and cuts nothing.
 * Only once the battery is full or at its power limit does the export appear on
 * the meter, and only then is anything curtailed. Charging at a negative price
 * before throwing generation away is the right order, and it falls out of the
 * arithmetic rather than needing to be coordinated.
 *
 * The gap is the few seconds before the battery ramps, where the surplus is on
 * the meter but about to be taken. That is what `settleSeconds` is for.
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

import type { CurtailmentConfig } from "./curtailment";

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
};

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
   * What a kWh put on the grid earns right now, with the contract applied.
   * Null when there is no forecast, the slot has run out, or the production
   * formula does not parse — all of which mean "we do not know", and none of
   * which mean "zero".
   */
  productionPricePerKwh: number | null;
  /** The currency those prices are in, for the log. */
  currency: string;
  config: CurtailmentConfig;
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
    array.curtailable && (array.ratedPowerW ?? 0) > 0 && array.powerW !== null
  );
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

  if (productionPricePerKwh >= priceThresholdPerKwh) {
    return releaseAll(
      input,
      `Injection at ${price(productionPricePerKwh, currency)} — at or above the ${price(priceThresholdPerKwh, currency)} threshold, nothing to curtail.`,
      `injection at ${price(productionPricePerKwh, currency)}`,
    );
  }

  // Past here the price says hold back, and only a reading can stop us.
  const priceClause = `injection at ${price(productionPricePerKwh, currency)}, below the ${price(priceThresholdPerKwh, currency)} threshold`;

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

  if (participating.length === 0) {
    return releaseAll(
      input,
      `${priceClause}, but no curtailable array has a usable power reading — releasing them.`,
      "power reading unavailable",
      { curtailing: true, warnings },
    );
  }

  const netW = gridPowerW;
  const offBy = netW - gridTargetW;
  const offTarget = Math.abs(offBy) >= deadbandW;
  const combinedAllowedW = curtailablePvW + offBy;

  const flow = netW > 0 ? "importing" : "exporting";
  const target =
    gridTargetW === 0 ? "balanced" : `a ${signed(gridTargetW)} target`;

  const decide = (
    reasonFor: (array: PvArraySnapshot) => PvArrayDecision,
  ): PvArrayDecision[] =>
    arrays.map((array) => {
      if (!array.curtailable) return hold(array, NOT_CURTAILABLE_REASON);
      if ((array.ratedPowerW ?? 0) <= 0) {
        return hold(array, "no rated power configured");
      }
      if (array.powerW === null) {
        return release(array, "power reading unavailable");
      }
      return reasonFor(array);
    });

  if (!offTarget) {
    return {
      curtailing: true,
      netW,
      curtailablePvW,
      combinedAllowedW,
      offTarget: false,
      decisions: decide((array) =>
        hold(array, `grid within the ${deadbandW} W deadband`),
      ),
      summary: `${priceClause}. Grid net ${signed(netW)} — ${target} within the ${deadbandW} W deadband, holding.`,
      warnings,
    };
  }

  // The settle rule. Both directions, not just cutting: handing generation back
  // the instant a kettle switches off would be just as twitchy, and the cost of
  // waiting is a few seconds of a fifteen-minute price slot either way.
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
      offTarget: true,
      decisions: decide((array) =>
        hold(
          array,
          `waiting for the meter to settle (${waited}s of ${config.settleSeconds}s)`,
        ),
      ),
      summary: `${priceClause}. Grid net ${signed(netW)} (${flow}) — settling, ${waited}s of ${config.settleSeconds}s.`,
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

  /** The fallback denominator, for the case where nothing is generating. */
  const ratedTotal = participating.reduce(
    (total, array) => total + (array.ratedPowerW ?? 0),
    0,
  );

  const decisions = decide((array) => {
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
      action: limitPercent >= 100 ? ("release" as const) : ("curtail" as const),
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
  });

  return {
    curtailing: true,
    netW,
    curtailablePvW,
    combinedAllowedW,
    offTarget: true,
    decisions,
    summary: `${priceClause}. Grid net ${signed(netW)} (${flow}), arrays at ${magnitude(curtailablePvW)} → allow ${magnitude(combinedAllowedW)} total.`,
    warnings,
  };
}
