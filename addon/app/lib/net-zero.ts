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
 */

/** Below this the meter counts as balanced; chasing noise would only cycle the battery. */
export const DEADBAND_W = 25;

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
};

export type BatteryAction = "charge" | "discharge" | "hold";

export type BatteryDecision = {
  batteryId: string;
  title: string;
  action: BatteryAction;
  /** Where the battery should be, in W: positive charging, negative discharging. */
  setpointW: number;
  currentW: number | null;
  socPercent: number | null;
  /** Why this decision, in a few words. */
  reason: string;
  /** The whole thing as one line, for the debug log. */
  message: string;
};

export type NetZeroPlan = {
  /** Grid net exchange in W: positive importing, negative exporting. Null when unreadable. */
  netW: number | null;
  /** The batteries' combined power right now, in W. */
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
 * strings end up in the debug log, which is compared against in tests and read
 * by whoever is diagnosing an installation, and neither wants the separators to
 * depend on the server's locale.
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

  // A battery whose power sensor is down still counts as present, but its
  // contribution to the meter reading is a guess, so say so.
  let currentBatteryW = 0;
  for (const battery of batteries) {
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

  if (gridPowerW === null) {
    return {
      netW: null,
      currentBatteryW,
      targetBatteryW: null,
      decisions: batteries.map((battery) =>
        hold(
          battery,
          "no grid reading to balance against",
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
        hold(battery, "grid already balanced", battery.powerW ?? 0),
      ),
      summary: `Grid net ${signed(netW)} — balanced within the ${DEADBAND_W} W deadband, holding.`,
      warnings,
    };
  }

  const targetBatteryW = currentBatteryW - netW;
  const direction: "charge" | "discharge" =
    targetBatteryW > 0 ? "charge" : "discharge";

  // Only the batteries that still have somewhere to go share the target. The
  // split is proportional to capacity, so a 5 kWh unit isn't asked for as much
  // as a 20 kWh one standing next to it.
  const eligible = batteries.filter(
    (battery) => blockedReason(battery, direction) === null,
  );
  const eligibleCapacity = eligible.reduce(
    (total, battery) => total + battery.capacityKwh,
    0,
  );

  const decisions = batteries.map((battery): BatteryDecision => {
    const blocked = blockedReason(battery, direction);
    if (blocked) return hold(battery, blocked, 0);

    // Equal shares when capacities are unusable — the form validates capacity
    // above zero, but a hand-edited file can still get here.
    const share =
      eligibleCapacity > 0
        ? battery.capacityKwh / eligibleCapacity
        : 1 / eligible.length;
    const setpointW = targetBatteryW * share;
    const room = headroomKwh(battery, direction);
    const limit =
      direction === "charge"
        ? `${battery.maxChargePercent}%`
        : `${battery.minChargePercent}%`;
    const soc = `SoC ${battery.socPercent}%`;
    const reason = `${direction} at ${magnitude(setpointW)} (${soc}, ${kwh(room)} to ${limit})`;

    return {
      batteryId: battery.id,
      title: battery.title,
      action: direction,
      setpointW,
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
