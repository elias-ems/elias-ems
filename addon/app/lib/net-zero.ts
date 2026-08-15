/**
 * The "net zero energy" strategy: hold the grid meter at zero by soaking up
 * what would otherwise be exported and covering what would otherwise be
 * imported.
 *
 * Pure — no Home Assistant, no clock, no disk. Everything it needs is passed
 * in, which is what makes the arithmetic below directly testable.
 *
 * ## Why the batteries' own power is an input
 *
 * The obvious rule — "importing 800 W, so discharge 800 W" — is wrong as soon
 * as the battery is already doing something, because the grid reading *already
 * includes* the battery. Writing `charge` for power drawn by the battery and
 * `discharge` as negative:
 *
 *     net = load - pv + batteryPower
 *
 * so the setpoint that drives `net` to zero is
 *
 *     targetBatteryPower = currentBatteryPower - net
 *
 * A battery discharging at 800 W while the meter reads zero is *already* doing
 * exactly the right thing; the naive rule would tell it to stop and create an
 * 800 W import in the process. This form tells it to carry on, which is a
 * different answer to the same reading, and the correct one.
 *
 * ## Batteries that cannot be steered
 *
 * A battery with no target power entity keeps doing whatever it was doing, so
 * it gets no share of the target — but it must also be left out of the
 * `currentBatteryPower` above, which is less obvious. Writing `C` for the
 * steerable batteries' current power and `U` for the unsteerable ones':
 *
 *     net = load - pv + C + U
 *
 * and the unsteerable ones stay at `U`, so the setpoint that zeroes the meter
 * is found from `load - pv + S + U = 0`, which reduces to
 *
 *     S = C - net
 *
 * `U` cancels out entirely. Counting it into `currentBatteryPower` instead
 * would ask the steerable batteries to cover what the unsteerable ones are
 * already covering, and the meter would overshoot by exactly `U`.
 *
 * ## Power limits
 *
 * Each battery's share is capped by what its inverter can deliver, which is
 * either typed into settings or read off the target entity's own range. The
 * feedback term above is also what makes a cap safe to apply per battery and
 * leave there: whatever the cap holds back keeps the meter off zero, so the
 * next tick asks for it again and the batteries with headroom take it up over a
 * few ticks rather than in one redistributing pass.
 */

/** Below this the meter counts as balanced; chasing noise would only cycle the battery. */
export const DEADBAND_W = 25;

/** Why a battery with no target power entity sits out every plan. */
export const UNSTEERED_REASON = "no target power entity — not steered";

export type BatterySnapshot = {
  id: string;
  title: string;
  capacityKwh: number;
  minChargePercent: number;
  maxChargePercent: number;
  /** State of charge in percent, or null when the sensor isn't giving a number. */
  socPercent: number | null;
  /** Current power in W — positive charging, negative discharging — or null. */
  powerW: number | null;
  /** Most it may be asked to charge at, in W. Null when nothing constrains it. */
  maxChargeW: number | null;
  /** The same for discharging, as a positive magnitude. Null when unconstrained. */
  maxDischargeW: number | null;
  /**
   * Whether a setpoint can be written to this battery at all — false when it
   * has no target power entity. An unsteered battery is still part of the
   * house, but it is not part of the plan; see `planNetZero`.
   */
  steerable: boolean;
};

export type BatteryAction = "charge" | "discharge" | "hold";

export type BatteryDecision = {
  batteryId: string;
  title: string;
  action: BatteryAction;
  /** Where the battery should be, in W: positive charging, negative discharging. */
  setpointW: number;
  /**
   * What the split asked for before a power limit cut it down, or null when
   * nothing was cut. Kept separate from `setpointW` so the log can show both:
   * a plan that is quietly delivering less than the meter needs looks identical
   * to one that is on target unless the shortfall is stated.
   */
  cappedFromW: number | null;
  currentW: number | null;
  socPercent: number | null;
  /** Why this decision, in a few words. */
  reason: string;
  /** The whole thing as one line, for the diagnostics log. */
  message: string;
};

export type NetZeroPlan = {
  /** Grid net exchange in W: positive importing, negative exporting. Null when unreadable. */
  netW: number | null;
  /**
   * The **steerable** batteries' combined power right now, in W.
   *
   * Deliberately not every battery: this is the `C` in `S = C - net` above, and
   * including a battery nothing can command would make the arithmetic ask the
   * others to cover what it is already doing.
   */
  currentBatteryW: number;
  /** The combined setpoint that would zero the meter, or null when it can't be worked out. */
  targetBatteryW: number | null;
  decisions: BatteryDecision[];
  summary: string;
  /** Things that made the answer less trustworthy but didn't prevent one. */
  warnings: string[];
};

function signed(watts: number): string {
  const rounded = Math.round(watts);
  return `${rounded > 0 ? "+" : ""}${rounded} W`;
}

function magnitude(watts: number): string {
  return `${Math.abs(Math.round(watts))} W`;
}

/**
 * Formatted with a fixed number of decimals rather than `toLocaleString`: these
 * strings end up in the diagnostics log, which is compared against in tests and
 * read by whoever is diagnosing an installation, and neither wants the
 * separators to depend on the server's locale.
 */
function kwh(value: number): string {
  return `${value.toFixed(1)} kWh`;
}

/** Room left before the ceiling (charging) or above the floor (discharging), in kWh. */
function headroomKwh(
  battery: BatterySnapshot,
  direction: "charge" | "discharge",
): number {
  const soc = battery.socPercent ?? 0;
  const span =
    direction === "charge"
      ? battery.maxChargePercent - soc
      : soc - battery.minChargePercent;
  return Math.max(0, (battery.capacityKwh * span) / 100);
}

/** The cap on this direction, as a positive magnitude. Null when uncapped. */
function limitFor(
  battery: BatterySnapshot,
  direction: "charge" | "discharge",
): number | null {
  return direction === "charge" ? battery.maxChargeW : battery.maxDischargeW;
}

/** Null when this battery can't take part, with the reason it can't. */
function blockedReason(
  battery: BatterySnapshot,
  direction: "charge" | "discharge",
): string | null {
  if (battery.socPercent === null) return "state of charge unknown";

  if (
    direction === "charge" &&
    battery.socPercent >= battery.maxChargePercent
  ) {
    return `at the ${battery.maxChargePercent}% ceiling`;
  }
  if (
    direction === "discharge" &&
    battery.socPercent <= battery.minChargePercent
  ) {
    return `at the ${battery.minChargePercent}% floor`;
  }

  // A limit of zero takes the battery out of the plan rather than leaving it in
  // with a 0 W share: it cannot contribute either way, and dropping it here is
  // what lets the batteries that *can* help take the whole target. This is the
  // shape a target entity that cannot express the direction arrives in — an
  // `input_number` left on its default 0–100 range, say — so it wants a reason
  // that points at the limit rather than at the battery.
  const limit = limitFor(battery, direction);
  if (limit === 0) return `${direction} power limited to 0 W`;

  return null;
}

function hold(
  battery: BatterySnapshot,
  reason: string,
  setpointW: number,
): BatteryDecision {
  return {
    batteryId: battery.id,
    title: battery.title,
    action: "hold",
    setpointW,
    cappedFromW: null,
    currentW: battery.powerW,
    socPercent: battery.socPercent,
    reason,
    message: `${battery.title}: hold — ${reason}`,
  };
}

export function planNetZero(input: {
  /** Net grid power in W: positive importing, negative exporting. Null when unreadable. */
  gridPowerW: number | null;
  batteries: BatterySnapshot[];
}): NetZeroPlan {
  const { gridPowerW, batteries } = input;
  const warnings: string[] = [];
  const steerable = batteries.filter((battery) => battery.steerable);

  // Only the steerable batteries' readings matter to the arithmetic — an
  // unsteerable one's power cancels out of `S = C - net` — so an unreadable
  // sensor on a battery nothing can command is not worth a warning.
  let currentBatteryW = 0;
  for (const battery of steerable) {
    if (battery.powerW === null) {
      warnings.push(
        `${battery.title}: power reading unavailable, assuming 0 W`,
      );
    } else {
      currentBatteryW += battery.powerW;
    }
  }

  if (batteries.length === 0) {
    return {
      netW: gridPowerW,
      currentBatteryW: 0,
      targetBatteryW: null,
      decisions: [],
      summary: "No batteries configured — nothing to control.",
      warnings,
    };
  }

  // Reachable even though the settings form refuses to enable control without
  // one: the target can be cleared from a battery afterwards.
  if (steerable.length === 0) {
    return {
      netW: gridPowerW,
      currentBatteryW: 0,
      targetBatteryW: null,
      decisions: batteries.map((battery) =>
        hold(battery, UNSTEERED_REASON, battery.powerW ?? 0),
      ),
      summary: "No battery has a target power entity — nothing to steer.",
      warnings,
    };
  }

  if (gridPowerW === null) {
    return {
      netW: null,
      currentBatteryW,
      targetBatteryW: null,
      decisions: batteries.map((battery) =>
        hold(
          battery,
          battery.steerable
            ? "no grid reading to balance against"
            : UNSTEERED_REASON,
          battery.powerW ?? 0,
        ),
      ),
      summary: "The grid power sensor is not readable — holding.",
      warnings,
    };
  }

  const netW = gridPowerW;

  if (Math.abs(netW) < DEADBAND_W) {
    return {
      netW,
      currentBatteryW,
      targetBatteryW: currentBatteryW,
      decisions: batteries.map((battery) =>
        hold(
          battery,
          battery.steerable ? "grid already balanced" : UNSTEERED_REASON,
          battery.powerW ?? 0,
        ),
      ),
      summary: `Grid net ${signed(netW)} — balanced within the ${DEADBAND_W} W deadband, holding.`,
      warnings,
    };
  }

  const targetBatteryW = currentBatteryW - netW;
  const direction: "charge" | "discharge" =
    targetBatteryW > 0 ? "charge" : "discharge";

  // Only the batteries that can be commanded *and* still have somewhere to go
  // share the target. The split is proportional to capacity, so a 5 kWh unit
  // isn't asked for as much as a 20 kWh one standing next to it.
  const eligible = steerable.filter(
    (battery) => blockedReason(battery, direction) === null,
  );
  const eligibleCapacity = eligible.reduce(
    (total, battery) => total + battery.capacityKwh,
    0,
  );

  const decisions = batteries.map((battery): BatteryDecision => {
    // Held at what it is already doing, not at 0: the other holds below are a
    // decision to stop, and this one is the absence of any decision at all.
    // Nothing can be written here, so nothing is being asked for.
    if (!battery.steerable) {
      return hold(battery, UNSTEERED_REASON, battery.powerW ?? 0);
    }

    const blocked = blockedReason(battery, direction);
    if (blocked) return hold(battery, blocked, 0);

    // Equal shares when capacities are unusable — the form validates capacity
    // above zero, but a hand-edited file can still get here.
    const share =
      eligibleCapacity > 0
        ? battery.capacityKwh / eligibleCapacity
        : 1 / eligible.length;
    const requestedW = targetBatteryW * share;

    // The inverter's rating, applied last: the split above divides the target
    // by capacity, and a small battery's share can easily exceed what its
    // inverter can actually deliver. What the cap leaves undelivered is not
    // handed to the others here — the loop's feedback term picks it up on the
    // next tick, since the meter will still be off by the shortfall.
    const powerLimitW = limitFor(battery, direction);
    const setpointW =
      powerLimitW === null
        ? requestedW
        : Math.sign(requestedW) * Math.min(Math.abs(requestedW), powerLimitW);
    const cappedFromW = setpointW === requestedW ? null : requestedW;

    const room = headroomKwh(battery, direction);
    const limit =
      direction === "charge"
        ? `${battery.maxChargePercent}%`
        : `${battery.minChargePercent}%`;
    const soc = `SoC ${battery.socPercent}%`;
    const capped =
      cappedFromW === null ? "" : `, capped from ${magnitude(cappedFromW)}`;
    const reason = `${direction} at ${magnitude(setpointW)}${capped} (${soc}, ${kwh(room)} to ${limit})`;

    return {
      batteryId: battery.id,
      title: battery.title,
      action: direction,
      setpointW,
      cappedFromW,
      currentW: battery.powerW,
      socPercent: battery.socPercent,
      reason,
      message: `${battery.title}: ${reason}`,
    };
  });

  const flow = netW > 0 ? "importing" : "exporting";
  const summary =
    eligible.length === 0
      ? `Grid net ${signed(netW)} (${flow}) wants ${direction} ${magnitude(targetBatteryW)}, but every battery is at its limit — holding.`
      : `Grid net ${signed(netW)} (${flow}), batteries at ${signed(currentBatteryW)} → ${direction} ${magnitude(targetBatteryW)} total.`;

  return {
    netW,
    currentBatteryW,
    targetBatteryW,
    decisions,
    summary,
    warnings,
  };
}
