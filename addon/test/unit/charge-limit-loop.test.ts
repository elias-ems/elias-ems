import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChargePlanCard from "../../app/components/dashboard/ChargePlanCard";
import type { Battery } from "../../app/lib/batteries";
import type { ChargeLimitsData } from "../../app/lib/charge-limit-status";

const renderPlan = (initial: ChargeLimitsData) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ChargePlanCard, { initial }),
    ),
  );

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  set: vi.fn(),
  calculate: vi.fn(),
  curtail: vi.fn(),
}));
vi.mock("../../app/lib/ha.server", () => ({
  fetchHaState: mocks.fetch,
  setHaChargeLimit: mocks.set,
}));
vi.mock("../../app/lib/charge-planner.server", () => ({
  calculateChargePlan: mocks.calculate,
  numericState: (s: { state: string } | null) =>
    s && Number.isFinite(Number(s.state)) ? Number(s.state) : null,
}));
vi.mock("../../app/lib/curtailment-config.server", () => ({
  readCurtailmentConfig: mocks.curtail,
}));
let directory: string;
let current = 2000;
let now: number;
const battery: Battery = {
  id: "one",
  title: "Home",
  capacityKwh: 5,
  minChargePercent: 10,
  maxChargePercent: 95,
  energyEntityId: "sensor.energy",
  powerEntityId: "sensor.power",
  socEntityId: "sensor.soc",
  steered: false,
  maxChargePowerW: 2000,
  maxDischargePowerW: 2000,
  chargeLimitEntityId: "number.charge_limit",
  chargeLimitMode: "active",
};
const saveBattery = (b: Battery) =>
  writeFile(path.join(directory, "batteries.json"), JSON.stringify([b]));

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), "elias-charge-test-"));
  vi.stubEnv("DATA_DIR", directory);
  now = Date.now();
  current = 2000;
  mocks.fetch.mockImplementation(async () => ({
    entity_id: "number.charge_limit",
    state: String(current),
    attributes: { min: 0, max: 2000, step: 10, unit_of_measurement: "W" },
  }));
  mocks.set.mockImplementation(async (_id: string, w: number) => {
    current = w;
  });
  mocks.curtail.mockResolvedValue({ enabled: false });
  mocks.calculate.mockImplementation(async () => ({
    controlBlocker: (await mocks.curtail()).enabled
      ? "Hypothetical curtailment preview; control blocked."
      : null,
    plan: {
      points: [{ start: now, end: now + 900_000, limitW: 400 }],
      reason: "Wait for midday solar.",
      cost: 1,
      baselineCost: 2,
      terminalReserveKwh: 1,
    },
    reportedW: current,
    currency: "EUR",
    timeZone: "Europe/Brussels",
    forecastEnd: now + 86_400_000,
    sources: 1,
    historyHours: 72,
    reserveCovered: true,
  }));
  await saveBattery(battery);
  await writeFile(
    path.join(directory, "control.json"),
    JSON.stringify({
      enabled: true,
      strategy: "charge-limit",
      intervalSeconds: 5,
    }),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("charge limit execution and recovery", () => {
  it("reports saved authorization before planning and while the execution lock waits for history", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    const initial = await loop.readChargeLimits();
    expect(initial.batteries[0].control.state).toBe("enabled");
    expect(initial.batteries[0].state).toBe("waiting");
    expect(mocks.calculate).not.toHaveBeenCalled();
    expect(renderPlan(initial)).toContain("no settings need to be saved");
    expect(renderPlan(initial)).not.toContain('role="alert"');

    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calculate = mocks.calculate.getMockImplementation();
    mocks.calculate.mockImplementationOnce(async () => {
      enter();
      await pending;
      return calculate?.();
    });
    const tick = loop.withChargeLimitLock(() => loop.chargeLimitTick(now));
    try {
      await entered;
      const waiting = await loop.readChargeLimits();
      expect(waiting.batteries[0].control.state).toBe("enabled");
      expect(waiting.batteries[0].plan).toBeNull();
      expect(renderPlan(waiting)).not.toContain('role="alert"');
      expect(mocks.set).not.toHaveBeenCalled();
    } finally {
      release();
      await tick;
    }
    expect((await loop.readChargeLimits()).batteries[0].state).toBe("active");

    vi.resetModules();
    const restarted = await import("../../app/lib/charge-limit-loop.server");
    expect(
      (await restarted.readChargeLimits()).batteries[0].control.state,
    ).toBe("enabled");
    await restarted.chargeLimitTick(now + 30_000);
    expect((await restarted.readChargeLimits()).batteries[0].state).toBe(
      "active",
    );
  });

  it("reports disabled, conflicting and paused settings without calculating a plan", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await saveBattery({ ...battery, steered: true });
    let data = await loop.readChargeLimits();
    expect(data.batteries[0].control.state).toBe("blocked");
    expect(renderPlan(data)).toContain("Edit battery");
    await saveBattery(battery);
    await writeFile(
      path.join(directory, "charge-limit-leases.json"),
      JSON.stringify([
        {
          batteryId: battery.id,
          entityId: battery.chargeLimitEntityId,
          originalW: 2000,
          previousW: 2000,
          requestedW: 400,
          at: now,
          paused: true,
        },
      ]),
    );
    data = await loop.readChargeLimits();
    expect(data.batteries[0].control.state).toBe("paused");
    expect(renderPlan(data)).toContain("Save battery settings");
    await writeFile(
      path.join(directory, "control.json"),
      JSON.stringify({ enabled: false, strategy: "charge-limit" }),
    );
    data = await loop.readChargeLimits();
    expect(data.batteries[0].control.state).toBe("disabled");
    expect(renderPlan(data)).toContain("Configure battery control");
    expect(mocks.calculate).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("shows planning failures without telling an enabled user to enable control again", async () => {
    mocks.calculate.mockRejectedValueOnce(new Error("Forecast gap"));
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    const data = await loop.readChargeLimits();
    expect(data.batteries[0].control.state).toBe("enabled");
    const html = renderPlan(data);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Forecast gap");
    expect(html).not.toContain("Configure battery control");
    expect(html).not.toContain("Save battery settings");
  });

  it("publishes active status only after the charge-limit write completes", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.set.mockImplementationOnce(async (_id: string, w: number) => {
      enter();
      await pending;
      current = w;
    });
    const loop = await import("../../app/lib/charge-limit-loop.server");
    const tick = loop.chargeLimitTick(now);
    try {
      await entered;
      const status = (await loop.readChargeLimits()).batteries[0];
      expect(status.state).toBe("waiting");
      expect(status.requestedW).toBeNull();
      expect(current).toBe(2000);
    } finally {
      release();
      await tick;
    }
    const status = (await loop.readChargeLimits()).batteries[0];
    expect(status.state).toBe("active");
    expect(status.requestedW).toBe(400);
    expect(current).toBe(400);
  });
  it("ignores legacy active mode after upgrade until the new strategy is enabled", async () => {
    await writeFile(
      path.join(directory, "control.json"),
      JSON.stringify({ enabled: false, strategy: "net-zero-energy" }),
    );
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(mocks.calculate).toHaveBeenCalledOnce();
    expect(mocks.set).not.toHaveBeenCalled();
    expect((await loop.readChargeLimits()).batteries[0].state).toBe("preview");
  });
  it("keeps a hypothetical plan and live readback when curtailment blocks writes", async () => {
    mocks.curtail.mockResolvedValue({ enabled: true });
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    const status = (await loop.readChargeLimits()).batteries[0];
    expect(status.plan).not.toBeNull();
    expect(status.reportedW).toBe(2000);
    expect(status.message).toContain("Hypothetical");
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("does not write in preview and works without target steering", async () => {
    await writeFile(
      path.join(directory, "control.json"),
      JSON.stringify({ enabled: false, strategy: "charge-limit" }),
    );
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(mocks.calculate).toHaveBeenCalledOnce();
    expect(mocks.set).not.toHaveBeenCalled();
    expect((await loop.readChargeLimits()).batteries[0].state).toBe("preview");
  });
  it("writes a cap, confirms readback, throttles and restores the previous value on disable", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(mocks.set).toHaveBeenCalledWith("number.charge_limit", 400);
    await loop.chargeLimitTick(now + 30_000);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect((await loop.readChargeLimits()).batteries[0].reportedW).toBe(400);
    await writeFile(
      path.join(directory, "control.json"),
      JSON.stringify({ enabled: false, strategy: "charge-limit" }),
    );
    await loop.chargeLimitTick(now + 60_000);
    expect(current).toBe(2000);
  });
  it("restores on forecast failure and keeps a failed restoration for retry", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    mocks.calculate.mockRejectedValueOnce(new Error("Forecast gap"));
    mocks.set.mockRejectedValueOnce(new Error("Disconnected"));
    await loop.chargeLimitTick(now + 300_000);
    expect((await loop.readChargeLimits()).batteries[0].message).toContain(
      "Restoration will be retried",
    );
    await loop.chargeLimitTick(now + 330_000);
    expect(current).toBe(2000);
    expect(
      JSON.parse(
        await readFile(
          path.join(directory, "charge-limit-leases.json"),
          "utf8",
        ),
      ),
    ).toEqual([]);
  });
  it("respects manual edits and pauses until settings are saved", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    current = 800;
    await loop.chargeLimitTick(now + 90_000);
    await loop.chargeLimitTick(now + 300_000);
    expect(current).toBe(800);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect((await loop.readChargeLimits()).batteries[0].state).toBe("preview");
    await loop.releaseChargeLimit(battery.id);
    expect(current).toBe(800);
  });
  it("recovers an outstanding limit after process restart", async () => {
    current = 400;
    await writeFile(
      path.join(directory, "charge-limit-leases.json"),
      JSON.stringify([
        {
          batteryId: "one",
          entityId: "number.charge_limit",
          originalW: 2000,
          previousW: 2000,
          requestedW: 400,
          at: now - 300_000,
        },
      ]),
    );
    await writeFile(
      path.join(directory, "control.json"),
      JSON.stringify({ enabled: false, strategy: "charge-limit" }),
    );
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(current).toBe(2000);
  });
  it("blocks conflicting steering, curtailment and multiple batteries", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await saveBattery({ ...battery, steered: true });
    await loop.chargeLimitTick(now);
    expect(mocks.set).not.toHaveBeenCalled();
    expect((await loop.readChargeLimits()).batteries[0].message).toContain(
      "steering",
    );
    await saveBattery(battery);
    mocks.curtail.mockResolvedValue({ enabled: true });
    await loop.chargeLimitTick(now + 300_000);
    expect((await loop.readChargeLimits()).batteries[0].message).toContain(
      "curtailment",
    );
  });
});

describe("paired charge and AC output limits", () => {
  let output: number;
  beforeEach(async () => {
    output = 2000;
    await saveBattery({
      ...battery,
      dischargeLimitEntityId: "number.ac_output",
    });
    mocks.fetch.mockImplementation(async (id: string) => ({
      entity_id: id,
      state: String(id === "number.ac_output" ? output : current),
      attributes: { min: 0, max: 2000, step: 10, unit_of_measurement: "W" },
    }));
    mocks.set.mockImplementation(async (id: string, w: number) => {
      if (id === "number.ac_output") output = w;
      else current = w;
    });
    const calculate = mocks.calculate.getMockImplementation();
    mocks.calculate.mockImplementation(async () => {
      const result = await calculate?.();
      result.plan.points[0].dischargeLimitW = 100;
      result.reportedDischargeW = output;
      return result;
    });
  });
  it("writes, monitors and independently restores both original values", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(current).toBe(400);
    expect(output).toBe(100);
    await loop.chargeLimitTick(now + 30_000);
    expect(
      (await loop.readChargeLimits()).batteries[0].reportedDischargeW,
    ).toBe(100);
    expect(mocks.set).toHaveBeenCalledTimes(2);
    await loop.releaseChargeLimit(battery.id);
    expect(current).toBe(2000);
    expect(output).toBe(2000);
    expect(
      JSON.parse(
        await readFile(
          path.join(directory, "charge-limit-leases.json"),
          "utf8",
        ),
      ),
    ).toEqual([]);
  });
  it("rolls back the charge cap if the output write fails", async () => {
    mocks.set.mockImplementation(async (id: string, w: number) => {
      if (id === "number.ac_output") throw new Error("Output unavailable");
      current = w;
    });
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(current).toBe(2000);
    expect(output).toBe(2000);
    expect((await loop.readChargeLimits()).batteries[0].state).toBe("error");
  });
  it("preserves a manual output edit and releases the charge cap", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    output = 900;
    await loop.chargeLimitTick(now + 90_000);
    expect(output).toBe(900);
    expect(current).toBe(2000);
    await loop.chargeLimitTick(now + 300_000);
    expect((await loop.readChargeLimits()).batteries[0].state).toBe("preview");
    expect(output).toBe(900);
    await loop.releaseChargeLimit(battery.id);
    expect(output).toBe(900);
  });
  it("recovers both limits after restart", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    vi.resetModules();
    await writeFile(
      path.join(directory, "control.json"),
      JSON.stringify({ enabled: false, strategy: "charge-limit" }),
    );
    const restarted = await import("../../app/lib/charge-limit-loop.server");
    await restarted.chargeLimitTick(now + 30_000);
    expect(current).toBe(2000);
    expect(output).toBe(2000);
  });
  it("restores output even if charge restoration fails, then retries charge", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    const fetch = mocks.fetch.getMockImplementation();
    if (!fetch) throw new Error("Missing HA fetch mock");
    mocks.fetch.mockImplementation(async (id: string) =>
      id === "number.charge_limit" ? null : fetch?.(id),
    );
    await expect(loop.releaseChargeLimit(battery.id)).rejects.toThrow(
      "unavailable",
    );
    expect(output).toBe(2000);
    expect(current).toBe(400);
    const records = JSON.parse(
      await readFile(path.join(directory, "charge-limit-leases.json"), "utf8"),
    );
    expect(records).toHaveLength(1);
    expect(records[0].entityId).toBe("number.charge_limit");
    expect(records[0].restoring).toBe(true);
    mocks.fetch.mockImplementation(fetch);
    await loop.releaseChargeLimit(battery.id);
    expect(current).toBe(2000);
  });
  it("never writes either limit in preview", async () => {
    await writeFile(
      path.join(directory, "control.json"),
      JSON.stringify({ enabled: false, strategy: "charge-limit" }),
    );
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
