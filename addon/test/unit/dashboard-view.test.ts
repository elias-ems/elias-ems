/**
 * What the two strategy rows say, given readings.
 *
 * The cases that matter here are the ones where a label and the truth can come
 * apart: an array that has never been told anything reads the same as one told
 * to generate freely unless the rule distinguishes them, and a loop that is
 * enabled but not running would otherwise claim to be armed.
 */
import { describe, expect, it } from "vitest";
import type { DashboardArray, DashboardBattery } from "../../app/lib/dashboard";
import {
  batteryControlSummary,
  curtailmentSummary,
  groupThousands,
  signedWatts,
} from "../../app/lib/dashboard-view";

const RUNNING = { enabled: true, running: true };

function array(over: Partial<DashboardArray> = {}): DashboardArray {
  return {
    id: "a1",
    title: "South roof",
    power: null,
    energy: null,
    powerW: null,
    ratedPowerW: 5000,
    curtailable: true,
    limitPercent: null,
    ...over,
  };
}

function battery(over: Partial<DashboardBattery> = {}): DashboardBattery {
  return {
    id: "b1",
    title: "Home battery",
    window: "10–95% of 12 kWh",
    charge: null,
    power: null,
    energy: null,
    chargePercent: 78,
    targetW: null,
    ...over,
  };
}

describe("groupThousands", () => {
  it("groups without asking the runtime what a locale is", () => {
    expect(groupThousands(0)).toBe("0");
    expect(groupThousands(999)).toBe("999");
    expect(groupThousands(1000)).toBe("1,000");
    expect(groupThousands(2100)).toBe("2,100");
    expect(groupThousands(1234567)).toBe("1,234,567");
  });

  it("keeps the sign outside the grouping", () => {
    expect(groupThousands(-1980)).toBe("-1,980");
    expect(signedWatts(2100)).toBe("+2,100");
    expect(signedWatts(-2100)).toBe("-2,100");
    // Zero is neither charging nor discharging, so it gets no plus.
    expect(signedWatts(0)).toBe("0");
  });
});

describe("curtailmentSummary", () => {
  it("says so when the feature is switched off", () => {
    const summary = curtailmentSummary([array()], {
      enabled: false,
      running: false,
    });
    expect(summary.state).toBe("Disabled");
    expect(summary.tone).toBe("off");
    expect(summary.percent).toBeNull();
  });

  it("separates enabled from actually deciding", () => {
    const summary = curtailmentSummary([array()], {
      enabled: true,
      running: false,
    });
    expect(summary.state).toBe("Loop stopped");
    expect(summary.tone).toBe("warn");
  });

  it("distinguishes never-told from told-to-generate-freely", () => {
    // Both are armed, but only one of them is a decision the add-on made, and
    // the device table reports them separately — so the row must not claim the
    // array is released when nothing has gone out to it.
    const untold = curtailmentSummary([array({ limitPercent: null })], RUNNING);
    expect(untold.state).toBe("Armed");
    expect(untold.value).toBeNull();
    expect(untold.percent).toBeNull();
    expect(untold.caption).toContain("nothing published yet");

    const released = curtailmentSummary(
      [array({ limitPercent: 100 })],
      RUNNING,
    );
    expect(released.value).toBe("100");
    expect(released.caption).toContain("released");
  });

  it("reports the watts a limit works out to", () => {
    const summary = curtailmentSummary([array({ limitPercent: 42 })], RUNNING);
    expect(summary.state).toBe("Curtailing");
    expect(summary.tone).toBe("pv");
    expect(summary.value).toBe("42");
    expect(summary.percent).toBe(42);
    expect(summary.caption).toBe("limit on South roof · 2,100 W of 5,000 W");
  });

  it("names the most limited array and counts the rest", () => {
    const summary = curtailmentSummary(
      [
        array({ id: "a1", title: "South roof", limitPercent: 60 }),
        array({
          id: "a2",
          title: "Carport",
          limitPercent: 30,
          ratedPowerW: 2000,
        }),
      ],
      RUNNING,
    );
    expect(summary.percent).toBe(30);
    expect(summary.caption).toContain("Carport");
    expect(summary.caption).toContain("1 more held back");
  });

  it("ignores arrays that are not steerable", () => {
    // Ticked but unrated, and rated but unticked: neither can ever be limited,
    // so a page reporting them as armed would be promising something.
    const summary = curtailmentSummary(
      [
        array({ id: "a1", curtailable: true, ratedPowerW: null }),
        array({ id: "a2", curtailable: false, ratedPowerW: 3000 }),
      ],
      RUNNING,
    );
    expect(summary.state).toBe("Nothing to steer");
    expect(summary.tone).toBe("idle");
  });
});

describe("batteryControlSummary", () => {
  it("says so when the feature is switched off", () => {
    const summary = batteryControlSummary([battery()], {
      enabled: false,
      running: false,
    });
    expect(summary.state).toBe("Disabled");
    // The charge is still worth drawing: the battery has one whether or not
    // anything is steering it.
    expect(summary.percent).toBe(78);
  });

  it("is armed until a target has actually gone out", () => {
    const summary = batteryControlSummary(
      [battery({ targetW: null })],
      RUNNING,
    );
    expect(summary.state).toBe("Armed");
    expect(summary.value).toBeNull();
    expect(summary.caption).toContain("no target published");
  });

  it("reads the direction off the sign of the target", () => {
    expect(
      batteryControlSummary([battery({ targetW: 2100 })], RUNNING).state,
    ).toBe("Charging");
    expect(
      batteryControlSummary([battery({ targetW: -900 })], RUNNING).state,
    ).toBe("Discharging");
    expect(
      batteryControlSummary([battery({ targetW: 0 })], RUNNING).state,
    ).toBe("Holding");
  });

  it("sums several batteries and means their charge", () => {
    const summary = batteryControlSummary(
      [
        battery({ id: "b1", targetW: 1500, chargePercent: 80 }),
        battery({ id: "b2", targetW: 600, chargePercent: 60 }),
      ],
      RUNNING,
    );
    expect(summary.value).toBe("+2,100");
    expect(summary.percent).toBe(70);
    expect(summary.caption).toContain("2 batteries");
  });

  it("has nothing to say with no batteries configured", () => {
    for (const loop of [RUNNING, { enabled: false, running: false }]) {
      const summary = batteryControlSummary([], loop);
      expect(summary.state).toBe("No batteries");
      expect(summary.percent).toBeNull();
      // Not "mean state of charge across 0 batteries", which is what a check
      // ordered after the enabled/disabled branches produced.
      expect(summary.caption).not.toContain("0 batteries");
    }
  });
});
