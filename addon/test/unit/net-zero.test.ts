/**
 * The strategy is a pure function, so these are plain arithmetic assertions —
 * no Home Assistant, no clock, no disk. That is the point of keeping it pure:
 * the decisions this makes are the whole feature, and they should be checkable
 * without booting anything.
 */
import { describe, expect, it } from "vitest";
import {
  type BatterySnapshot,
  DEADBAND_W,
  planNetZero,
} from "../../app/lib/net-zero";

function battery(overrides: Partial<BatterySnapshot> = {}): BatterySnapshot {
  return {
    id: "b1",
    title: "Home battery",
    capacityKwh: 10,
    minChargePercent: 10,
    maxChargePercent: 90,
    socPercent: 50,
    powerW: 0,
    maxChargeW: null,
    maxDischargeW: null,
    ...overrides,
  };
}

describe("planNetZero", () => {
  it("discharges to cover what would otherwise be imported", () => {
    const plan = planNetZero({
      gridPowerW: 800,
      batteries: [battery()],
    });

    expect(plan.netW).toBe(800);
    expect(plan.targetBatteryW).toBe(-800);
    expect(plan.decisions[0]).toMatchObject({
      action: "discharge",
      setpointW: -800,
    });
  });

  it("charges with what would otherwise be exported", () => {
    // Negative is the export half of the sign convention, and the only thing
    // that distinguishes the two directions now that it is one sensor.
    const plan = planNetZero({
      gridPowerW: -1200,
      batteries: [battery()],
    });

    expect(plan.netW).toBe(-1200);
    expect(plan.decisions[0]).toMatchObject({
      action: "charge",
      setpointW: 1200,
    });
  });

  it("counts the battery's own power as part of the reading it is correcting", () => {
    // The meter reads zero *because* the battery is already covering the load.
    // The naive rule — "net is zero, so idle" — would stop it and create an
    // 800 W import out of nothing. This is the case that makes the battery's
    // current power an input rather than an afterthought.
    const plan = planNetZero({
      gridPowerW: 0,
      batteries: [battery({ powerW: -800 })],
    });

    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      setpointW: -800,
    });
  });

  it("adds to a battery that is already charging when there is still export", () => {
    const plan = planNetZero({
      gridPowerW: -1200,
      batteries: [battery({ powerW: 500 })],
    });

    expect(plan.currentBatteryW).toBe(500);
    expect(plan.targetBatteryW).toBe(1700);
    expect(plan.decisions[0].setpointW).toBe(1700);
  });

  it("holds inside the deadband rather than chasing meter noise", () => {
    const plan = planNetZero({
      gridPowerW: DEADBAND_W - 1,
      batteries: [battery({ powerW: -300 })],
    });

    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      setpointW: -300,
    });
    expect(plan.summary).toContain("deadband");
  });

  it("holds inside the deadband on the export side too", () => {
    // The deadband is on the magnitude, so a small export has to be as quiet as
    // a small import. A one-sided check would let the battery cycle on noise in
    // exactly one direction, which is the sort of asymmetry a signed reading
    // makes easy to introduce.
    const plan = planNetZero({
      gridPowerW: -(DEADBAND_W - 1),
      batteries: [battery({ powerW: -300 })],
    });

    expect(plan.decisions[0]).toMatchObject({
      action: "hold",
      setpointW: -300,
    });
    expect(plan.summary).toContain("deadband");
  });

  it("will not discharge a battery that is at its floor", () => {
    const plan = planNetZero({
      gridPowerW: 800,
      batteries: [battery({ socPercent: 10, minChargePercent: 10 })],
    });

    expect(plan.decisions[0]).toMatchObject({ action: "hold", setpointW: 0 });
    expect(plan.decisions[0].reason).toContain("10% floor");
    expect(plan.summary).toContain("every battery is at its limit");
  });

  it("will not charge a battery that is at its ceiling", () => {
    const plan = planNetZero({
      gridPowerW: -800,
      batteries: [battery({ socPercent: 95, maxChargePercent: 90 })],
    });

    expect(plan.decisions[0]).toMatchObject({ action: "hold", setpointW: 0 });
    expect(plan.decisions[0].reason).toContain("90% ceiling");
  });

  it("holds a battery whose state of charge cannot be read", () => {
    // Guessing here would mean guessing about the one limit that protects the
    // hardware, so an unreadable SoC takes the battery out of the plan.
    const plan = planNetZero({
      gridPowerW: 800,
      batteries: [battery({ socPercent: null })],
    });

    expect(plan.decisions[0]).toMatchObject({ action: "hold", setpointW: 0 });
    expect(plan.decisions[0].reason).toBe("state of charge unknown");
  });

  it("splits the target across batteries in proportion to capacity", () => {
    const plan = planNetZero({
      gridPowerW: 1000,
      batteries: [
        battery({ id: "small", title: "Small", capacityKwh: 5 }),
        battery({ id: "big", title: "Big", capacityKwh: 15 }),
      ],
    });

    // 5 kWh and 15 kWh, so a quarter and three quarters — not half each.
    expect(plan.decisions.map((decision) => decision.setpointW)).toEqual([
      -250, -750,
    ]);
  });

  it("gives the whole target to the batteries that can still take part", () => {
    const plan = planNetZero({
      gridPowerW: 1000,
      batteries: [
        battery({ id: "empty", capacityKwh: 5, socPercent: 10 }),
        battery({ id: "usable", capacityKwh: 15, socPercent: 80 }),
      ],
    });

    expect(plan.decisions[0].setpointW).toBe(0);
    expect(plan.decisions[1].setpointW).toBe(-1000);
  });

  it("holds everything when the grid sensor is unreadable", () => {
    const plan = planNetZero({
      gridPowerW: null,
      batteries: [battery({ powerW: 400 })],
    });

    expect(plan.netW).toBeNull();
    expect(plan.targetBatteryW).toBeNull();
    expect(plan.decisions[0]).toMatchObject({ action: "hold", setpointW: 400 });
    expect(plan.summary).toContain("grid power sensor is not readable");
  });

  it("warns about an unreadable battery power reading but still decides", () => {
    // Without the battery's contribution the target is only approximately
    // right, which is worth flagging — but refusing to act on a house that is
    // visibly importing would be worse.
    const plan = planNetZero({
      gridPowerW: 800,
      batteries: [battery({ powerW: null })],
    });

    expect(plan.warnings).toEqual([
      "Home battery: power reading unavailable, assuming 0 W",
    ]);
    expect(plan.decisions[0].action).toBe("discharge");
  });

  it("says there is nothing to control when no battery is configured", () => {
    const plan = planNetZero({
      gridPowerW: 800,
      batteries: [],
    });

    expect(plan.decisions).toEqual([]);
    expect(plan.summary).toContain("No batteries configured");
  });

  it("caps a discharge at what the inverter can deliver", () => {
    const plan = planNetZero({
      gridPowerW: 4000,
      batteries: [battery({ maxDischargeW: 2500 })],
    });

    // The target is still the honest answer to the meter; the setpoint is what
    // the battery can actually be asked for.
    expect(plan.targetBatteryW).toBe(-4000);
    expect(plan.decisions[0]).toMatchObject({
      action: "discharge",
      setpointW: -2500,
      cappedFromW: -4000,
    });
    expect(plan.decisions[0].message).toContain("capped from 4000 W");
  });

  it("caps a charge the same way", () => {
    const plan = planNetZero({
      gridPowerW: -6000,
      batteries: [battery({ maxChargeW: 3000 })],
    });

    expect(plan.decisions[0]).toMatchObject({
      action: "charge",
      setpointW: 3000,
      cappedFromW: 6000,
    });
  });

  it("leaves a setpoint inside the limit alone", () => {
    const plan = planNetZero({
      gridPowerW: 800,
      batteries: [battery({ maxDischargeW: 2500 })],
    });

    expect(plan.decisions[0]).toMatchObject({
      setpointW: -800,
      cappedFromW: null,
    });
    expect(plan.decisions[0].message).not.toContain("capped");
  });

  it("applies each direction's limit only to that direction", () => {
    // An inverter that charges at 3 kW and discharges at 5 kW is ordinary, and
    // one limit leaking into the other direction would be invisible in the log.
    const plan = planNetZero({
      gridPowerW: -9000,
      batteries: [battery({ maxChargeW: 3000, maxDischargeW: 5000 })],
    });

    expect(plan.decisions[0].setpointW).toBe(3000);
  });

  it("takes a battery limited to 0 W out of the plan entirely", () => {
    // What an input_number left on its default 0–100 range looks like from
    // here: it cannot express a discharge at all. Holding at 0 W with a
    // "discharge" action would read as though it were doing something.
    const plan = planNetZero({
      gridPowerW: 1000,
      batteries: [battery({ maxDischargeW: 0 })],
    });

    expect(plan.decisions[0]).toMatchObject({ action: "hold", setpointW: 0 });
    expect(plan.decisions[0].reason).toBe("discharge power limited to 0 W");
    expect(plan.summary).toContain("every battery is at its limit");
  });

  it("gives the whole target to a battery whose neighbour is limited to 0 W", () => {
    const plan = planNetZero({
      gridPowerW: 1000,
      batteries: [
        battery({ id: "capped", capacityKwh: 10, maxDischargeW: 0 }),
        battery({ id: "free", capacityKwh: 10 }),
      ],
    });

    // Not 500 each: the capped one is out of the split, not in it with a zero.
    expect(plan.decisions[0].setpointW).toBe(0);
    expect(plan.decisions[1].setpointW).toBe(-1000);
  });

  it("reports the room left, so a setpoint can be sanity-checked next to it", () => {
    const plan = planNetZero({
      gridPowerW: 500,
      batteries: [
        battery({ capacityKwh: 10, socPercent: 50, minChargePercent: 10 }),
      ],
    });

    // 40% of 10 kWh is left above the floor.
    expect(plan.decisions[0].message).toBe(
      "Home battery: discharge at 500 W (SoC 50%, 4.0 kWh to 10%)",
    );
  });
});
