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
  fire: vi.fn(),
  calculate: vi.fn(),
  curtail: vi.fn(),
}));
vi.mock("../../app/lib/ha.server", () => ({
  fetchHaState: mocks.fetch,
  setHaChargeLimit: mocks.set,
  fireHaEvent: mocks.fire,
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
/** A power-limit entity an earlier version wrote, for the migration cases. */
let legacyLimit = 400;
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
  steered: true,
  controlModes: ["balance", "hold", "charge", "discharge"],
  dischargeLimitSupported: false,
  powerStepW: 10,
  chargeLimitPlanning: true,
  commandContract: 1,
  maxChargePowerW: 2000,
  maxDischargePowerW: 2000,
};
const saveBattery = (b: Battery) =>
  writeFile(path.join(directory, "batteries.json"), JSON.stringify([b]));
const saveControl = (enabled: boolean, strategy = "charge-limit") =>
  writeFile(
    path.join(directory, "control.json"),
    JSON.stringify({ enabled, strategy, intervalSeconds: 5 }),
  );

/** Every battery command fired so far, as payloads. */
const commands = (): Array<Record<string, unknown>> =>
  mocks.fire.mock.calls
    .filter(([type]) => String(type).endsWith("_battery_command"))
    .map(([, data]) => data as Record<string, unknown>);

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), "elias-charge-test-"));
  vi.stubEnv("DATA_DIR", directory);
  now = Date.now();
  legacyLimit = 400;
  mocks.fire.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async (id: string) => ({
    entity_id: id,
    state: String(legacyLimit),
    attributes: { min: 0, max: 2000, step: 10, unit_of_measurement: "W" },
  }));
  mocks.set.mockImplementation(async (_id: string, w: number) => {
    legacyLimit = w;
  });
  mocks.curtail.mockResolvedValue({ enabled: false });
  mocks.calculate.mockImplementation(async () => ({
    controlBlocker: (await mocks.curtail()).enabled
      ? "Hypothetical curtailment preview; control blocked."
      : null,
    plan: {
      points: [
        {
          start: now,
          end: now + 900_000,
          limitW: 400,
          dischargeLimitW: 100,
        },
      ],
      reason: "Wait for midday solar.",
      cost: 1,
      baselineCost: 2,
      terminalReserveKwh: 1,
    },
    currency: "EUR",
    timeZone: "Europe/Brussels",
    forecastEnd: now + 86_400_000,
    sources: 1,
    historyHours: 72,
    reserveCovered: true,
  }));
  await saveBattery(battery);
  await saveControl(true);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("charge limit commands", () => {
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
      expect(commands()).toEqual([]);
    } finally {
      release();
      await tick;
    }
    expect((await loop.readChargeLimits()).batteries[0].state).toBe("active");
  });

  it("publishes the current interval as a balance command with its boundaries", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);

    expect(mocks.fire).toHaveBeenCalledWith(
      "elias_ems_home_battery_command",
      expect.any(Object),
    );
    expect(commands()).toEqual([
      expect.objectContaining({
        action: "apply",
        strategy: "charge-limit",
        mode: "balance",
        setpoint_w: null,
        charge_limit_w: 400,
        // Without discharge limiting the battery's output stays native, and
        // the command says so rather than repeating the plan's ceiling.
        discharge_limit_w: null,
        valid_from: new Date(now).toISOString(),
        valid_until: new Date(
          now + 900_000 + loop.COMMAND_GRACE_MS,
        ).toISOString(),
      }),
    ]);
    const status = (await loop.readChargeLimits()).batteries[0];
    expect(status.state).toBe("active");
    expect(status.requestedW).toBe(400);
    expect(status.requestedDischargeW).toBeNull();
    // Nothing is written to an entity any more.
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("carries the AC output boundary when the battery can limit discharge", async () => {
    await saveBattery({ ...battery, dischargeLimitSupported: true });
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);

    expect(commands()[0]).toMatchObject({
      charge_limit_w: 400,
      discharge_limit_w: 100,
    });
    expect(
      (await loop.readChargeLimits()).batteries[0].requestedDischargeW,
    ).toBe(100);
  });

  it("does not repeat an unchanged command when it replans inside the interval", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    loop.invalidateChargePlans();
    await loop.chargeLimitTick(now + 30_000);

    expect(mocks.calculate).toHaveBeenCalledTimes(2);
    expect(commands()).toHaveLength(1);
  });

  it("reports disabled and conflicting settings without calculating a plan", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await saveBattery({ ...battery, steered: false });
    let data = await loop.readChargeLimits();
    expect(data.batteries[0].control.state).toBe("blocked");
    expect(renderPlan(data)).toContain("Edit battery");
    await saveBattery(battery);
    await saveControl(false);
    data = await loop.readChargeLimits();
    expect(data.batteries[0].control.state).toBe("disabled");
    expect(renderPlan(data)).toContain("Configure battery control");
    expect(mocks.calculate).not.toHaveBeenCalled();
    expect(commands()).toEqual([]);
  });

  it("only plans batteries opted in to charge-limit planning", async () => {
    await saveBattery({ ...battery, chargeLimitPlanning: false });
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(mocks.calculate).not.toHaveBeenCalled();
    expect((await loop.readChargeLimits()).batteries).toEqual([]);
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
  });

  it("publishes active status only after the command has gone out", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.fire.mockImplementationOnce(async () => {
      enter();
      await pending;
    });
    const loop = await import("../../app/lib/charge-limit-loop.server");
    const tick = loop.chargeLimitTick(now);
    try {
      await entered;
      const status = (await loop.readChargeLimits()).batteries[0];
      expect(status.state).toBe("waiting");
      expect(status.requestedW).toBeNull();
    } finally {
      release();
      await tick;
    }
    const status = (await loop.readChargeLimits()).batteries[0];
    expect(status.state).toBe("active");
    expect(status.requestedW).toBe(400);
  });

  it("reports a command that did not go out as an error", async () => {
    mocks.fire.mockRejectedValue(new Error("Disconnected"));
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    const status = (await loop.readChargeLimits()).batteries[0];
    expect(status.state).toBe("error");
    expect(status.message).toContain("Disconnected");
  });

  it("previews without publishing while the strategy is disabled or another is active", async () => {
    await saveControl(false, "net-zero-energy");
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(mocks.calculate).toHaveBeenCalledOnce();
    expect(commands()).toEqual([]);
    expect((await loop.readChargeLimits()).batteries[0].state).toBe("preview");
  });

  it("previews without publishing when the battery is not steered", async () => {
    await saveBattery({ ...battery, steered: false });
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(commands()).toEqual([]);
    const status = (await loop.readChargeLimits()).batteries[0];
    expect(status.state).toBe("preview");
    expect(status.message).toContain("Steer this battery");
  });

  it("keeps a hypothetical plan without publishing when curtailment blocks control", async () => {
    mocks.curtail.mockResolvedValue({ enabled: true });
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    const status = (await loop.readChargeLimits()).batteries[0];
    expect(status.plan).not.toBeNull();
    expect(status.message).toContain("Hypothetical");
    expect(commands()).toEqual([]);
  });

  it("releases the battery when steering is unchecked between plans", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    await saveBattery({ ...battery, steered: false });
    await loop.chargeLimitTick(now + 30_000);

    expect(commands().at(-1)).toMatchObject({
      action: "release",
      release_reason: "unsteered",
      strategy: "charge-limit",
    });
    expect((await loop.readChargeLimits()).batteries[0].control.state).toBe(
      "blocked",
    );
  });

  it("releases the battery once, when the strategy is disabled", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    await saveControl(false);
    await loop.chargeLimitTick(now + 30_000);
    await loop.chargeLimitTick(now + 60_000);

    expect(commands().map((c) => c.action)).toEqual(["apply", "release"]);
    expect(commands()[1]).toMatchObject({ release_reason: "disabled" });
  });

  it("does not release a battery it never commanded", async () => {
    await saveControl(true, "net-zero-energy");
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    expect(commands()).toEqual([]);
  });

  it("releases the battery when planning fails", async () => {
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);
    mocks.calculate.mockRejectedValueOnce(new Error("Forecast gap"));
    await loop.chargeLimitTick(now + 300_000);

    expect(commands().at(-1)).toMatchObject({
      action: "release",
      release_reason: "failure",
    });
    expect((await loop.readChargeLimits()).batteries[0].message).toContain(
      "Released the battery",
    );
  });
});

describe("limits written by an earlier version", () => {
  const lease = (entityId: string, extra = {}) => ({
    batteryId: "one",
    entityId,
    originalW: 2000,
    previousW: 2000,
    requestedW: 400,
    at: now - 300_000,
    ...extra,
  });
  const leases = async () =>
    JSON.parse(
      await readFile(path.join(directory, "charge-limit-leases.json"), "utf8"),
    );

  it("restores an outstanding limit before publishing any command", async () => {
    await writeFile(
      path.join(directory, "charge-limit-leases.json"),
      JSON.stringify([lease("number.charge_limit")]),
    );
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);

    expect(mocks.set).toHaveBeenCalledWith("number.charge_limit", 2000);
    expect(legacyLimit).toBe(2000);
    expect(await leases()).toEqual([]);
    // Restored in the same tick, so the command goes out straight after.
    expect(commands()).toHaveLength(1);
    expect(mocks.set.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fire.mock.invocationCallOrder[0],
    );
  });

  it("holds commands back while a restoration keeps failing, and retries it", async () => {
    await writeFile(
      path.join(directory, "charge-limit-leases.json"),
      JSON.stringify([lease("number.charge_limit")]),
    );
    mocks.set.mockRejectedValueOnce(new Error("Disconnected"));
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);

    expect(commands()).toEqual([]);
    const data = await loop.readChargeLimits();
    expect(data.batteries[0].control.state).toBe("migrating");
    expect(data.batteries[0].message).toContain("earlier version");

    loop.invalidateChargePlans();
    await loop.chargeLimitTick(now + 30_000);
    expect(legacyLimit).toBe(2000);
    expect(await leases()).toEqual([]);
    expect(commands()).toHaveLength(1);
  });

  it("leaves a value somebody changed by hand alone", async () => {
    legacyLimit = 800;
    await writeFile(
      path.join(directory, "charge-limit-leases.json"),
      JSON.stringify([lease("number.charge_limit", { paused: true })]),
    );
    await saveControl(false);
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);

    expect(mocks.set).not.toHaveBeenCalled();
    expect(legacyLimit).toBe(800);
    expect(await leases()).toEqual([]);
  });

  it("restores each direction independently", async () => {
    await writeFile(
      path.join(directory, "charge-limit-leases.json"),
      JSON.stringify([lease("number.charge_limit"), lease("number.ac_output")]),
    );
    const fetch = mocks.fetch.getMockImplementation();
    mocks.fetch.mockImplementation(async (id: string) =>
      id === "number.charge_limit" ? null : fetch?.(id),
    );
    await saveControl(false);
    const loop = await import("../../app/lib/charge-limit-loop.server");
    await loop.chargeLimitTick(now);

    expect(mocks.set).toHaveBeenCalledWith("number.ac_output", 2000);
    expect(
      (await leases()).map((l: { entityId: string }) => l.entityId),
    ).toEqual(["number.charge_limit"]);
  });
});
