import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Battery } from "../../app/lib/batteries";
import { DEFAULT_CURTAILMENT_CONFIG } from "../../app/lib/curtailment";
import { stopHaLive } from "../../app/lib/ha-live.server";
import {
  chargeBatteryFixture,
  chargeEntityFixture,
  chargeForecastFixture,
} from "../charge-forecast-fixture.js";
import { defaultStates, startHaMock } from "../ha-mock.js";

// These tests exercise real HA requests and the full evening search (sometimes
// twice). Its horizon depends on the fixture's current time, and a shared CI
// runner can exceed Vitest's five-second default. Keep this allowance local to
// the planner plumbing tests; all behavioral assertions remain unchanged.
vi.setConfig({ testTimeout: 30_000 });

const configMocks = vi.hoisted(() => ({
  control: vi.fn(),
  curtailment: vi.fn(),
  arrays: vi.fn(),
}));
vi.mock("../../app/lib/control-config.server", () => ({
  readControlConfig: configMocks.control,
}));
vi.mock("../../app/lib/curtailment-config.server", () => ({
  readCurtailmentConfig: configMocks.curtailment,
}));
vi.mock("../../app/lib/pv-entities.server", () => ({
  listPvEntities: configMocks.arrays,
}));

vi.mock("../../app/lib/prices.server", () => ({
  readPriceConfig: async () => ({
    source: "home-assistant",
    forecastEntityId: "sensor.energi_epex_spot",
    consumptionFormula: "price + 0.15",
    productionFormula: "price",
  }),
}));
let ha: Awaited<ReturnType<typeof startHaMock>>;
beforeEach(async () => {
  vi.resetModules();
  configMocks.control.mockResolvedValue({
    enabled: false,
    strategy: "net-zero-energy",
  });
  configMocks.curtailment.mockResolvedValue(DEFAULT_CURTAILMENT_CONFIG);
  configMocks.arrays.mockResolvedValue([]);
  ha = await startHaMock({
    states: [...(await defaultStates()), chargeEntityFixture],
    commandResults: chargeForecastFixture(),
  });
  vi.stubEnv("SUPERVISOR_WS", ha.wsUrl);
  vi.stubEnv("SUPERVISOR_API", ha.apiUrl);
  vi.stubEnv("SUPERVISOR_TOKEN", ha.token);
});
afterEach(async () => {
  const live = await import("../../app/lib/ha-live.server");
  live.stopHaLive();
  stopHaLive();
  await ha.close();
  vi.unstubAllEnvs();
});
describe("forecast planning through Home Assistant", () => {
  it("shows unsupported curtailment as a hypothetical preview rather than dropping the plan", async () => {
    configMocks.curtailment.mockResolvedValue({
      ...DEFAULT_CURTAILMENT_CONFIG,
      enabled: true,
      strategy: "soft-ceiling",
    });
    const { calculateChargePlan } = await import(
      "../../app/lib/charge-planner.server"
    );
    const result = await calculateChargePlan(chargeBatteryFixture as Battery);
    expect(result.controlBlocker).toContain(
      "No PV entity matches Energy dashboard counter pv",
    );
    expect(result.plan.points.length).toBeGreaterThan(0);
  });
  it("models a fully matched threshold setup and blocks unmapped solar", async () => {
    configMocks.curtailment.mockResolvedValue({
      ...DEFAULT_CURTAILMENT_CONFIG,
      enabled: true,
      strategy: "threshold",
      minLimitPercent: 0,
      gridTargetW: 0,
      carChargingEntityId: "",
      priceThresholdPerKwh: 100,
    });
    configMocks.arrays.mockResolvedValue([
      {
        energyEntityId: "pv",
        curtailable: true,
        controlMode: "modulating",
        ratedPowerW: 5000,
      },
    ]);
    const { calculateChargePlan } = await import(
      "../../app/lib/charge-planner.server"
    );
    const result = await calculateChargePlan(chargeBatteryFixture as Battery);
    expect(result.controlBlocker).toBeNull();
    expect(result.plan.points.every((p) => p.curtailment)).toBe(true);
    configMocks.arrays.mockResolvedValue([]);
    expect(
      (await calculateChargePlan(chargeBatteryFixture as Battery))
        .controlBlocker,
    ).toContain("Hypothetical");
  });
  it("models price bands and fixed-step arrays", async () => {
    configMocks.curtailment.mockResolvedValue({
      ...DEFAULT_CURTAILMENT_CONFIG,
      enabled: true,
      strategy: "soft-ceiling",
      priceThresholdPerKwh: -1,
      gridTargetW: -250,
      minLimitPercent: 2,
      deadbandW: 50,
    });
    configMocks.arrays.mockResolvedValue([
      {
        energyEntityId: "pv",
        curtailable: true,
        controlMode: "stepped",
        ratedPowerW: 5000,
        stepLimitPercent: 5,
      },
    ]);
    const { calculateChargePlan } = await import(
      "../../app/lib/charge-planner.server"
    );
    const result = await calculateChargePlan(chargeBatteryFixture as Battery);
    expect(result.controlBlocker).toBeNull();
    expect(result.curtailmentModeled).toBe(true);
  });
  it("authenticates, consumes the selected forecast and Recorder history, and applies contract prices", async () => {
    const { calculateChargePlan } = await import(
      "../../app/lib/charge-planner.server"
    );
    const result = await calculateChargePlan(chargeBatteryFixture as Battery);
    expect(result.sources).toBe(1);
    expect(result.historyHours).toBe(336);
    expect(result.plan.points.length).toBeGreaterThan(3);
    expect(
      result.plan.points.every((p) => Math.abs(p.loadW - 500) < 0.001),
    ).toBe(true);
    expect(result.plan.points[0].buy - result.plan.points[0].sell).toBeCloseTo(
      0.15,
    );
    expect(result.forecastEnd).toBeGreaterThan(Date.now() + 5 * 86_400_000);
  });
  it("builds its boundaries from settings rather than guessing them", async () => {
    const { chargeModel } = await import("../../app/lib/charge-planner.server");
    expect(chargeModel(chargeBatteryFixture as Battery, 50)).toMatchObject({
      minW: 0,
      maxW: 2000,
      stepW: 10,
      dischargeW: 2000,
    });
    expect(() => chargeModel(chargeBatteryFixture as Battery, NaN)).toThrow();
    expect(() =>
      chargeModel(
        { ...chargeBatteryFixture, maxChargePowerW: null } as Battery,
        50,
      ),
    ).toThrow("hardware charge and discharge limits");
  });
  it("reports rejected WebSocket commands and authentication failures", async () => {
    const { haCommands } = await import("../../app/lib/ha-command.server");
    await expect(haCommands([{ type: "missing/command" }])).rejects.toThrow(
      "missing/command",
    );
    vi.stubEnv("SUPERVISOR_TOKEN", "incorrect-test-token");
    await expect(haCommands([{ type: "get_config" }])).rejects.toThrow(
      "rejected",
    );
  });
});

it("uses evening planning even for a retired cost-optimized selection", async () => {
  configMocks.control.mockResolvedValue({
    enabled: false,
    strategy: "charge-limit",
    chargeAlgorithm: "cost-optimized",
  });
  const { calculateChargePlan } = await import(
    "../../app/lib/charge-planner.server"
  );
  const report = vi.fn();
  const result = await calculateChargePlan(
    chargeBatteryFixture as Battery,
    Date.now(),
    report,
  );
  expect(result.plan.reason).toContain("Evening target");
  expect(report).toHaveBeenCalledWith(
    "algorithm",
    expect.stringContaining("18:00"),
  );
  expect(
    result.plan.points.every((p) => p.limitW >= 0 && p.limitW <= 2000),
  ).toBe(true);
});

it("ignores planning settings stored before they were hardcoded", async () => {
  configMocks.control.mockResolvedValue({
    enabled: false,
    strategy: "charge-limit",
    eveningHour: 7,
    ceilingSwitchCost: 1,
    spikeBufferKwh: 3,
    solarMarginPercent: 60,
    chargeWearPerKwh: 2,
  });
  const { calculateChargePlan } = await import(
    "../../app/lib/charge-planner.server"
  );
  const report = vi.fn();
  const result = await calculateChargePlan(
    {
      ...chargeBatteryFixture,
      solarMarginPercent: 50,
      chargeWearPerKwh: 1,
    } as Battery,
    Date.now(),
    report,
  );
  expect(result.solarMarginPercent).toBe(20);
  expect(result.model.wearPerKwh).toBe(0.05);
  expect(report).toHaveBeenCalledWith(
    "algorithm",
    expect.stringContaining("18:00"),
  );
});

it("keeps ordinary curtailment planning available with an unpredictable EV override", async () => {
  configMocks.curtailment.mockResolvedValue({
    ...DEFAULT_CURTAILMENT_CONFIG,
    enabled: true,
    strategy: "soft-ceiling",
    carChargingEntityId: "binary_sensor.ev_charging",
    chargerPowerW: 11000,
    gridTargetW: -250,
    minLimitPercent: 2,
  });
  configMocks.arrays.mockResolvedValue([
    {
      energyEntityId: "pv",
      curtailable: true,
      controlMode: "modulating",
      ratedPowerW: 5000,
    },
  ]);
  const { calculateChargePlan } = await import(
    "../../app/lib/charge-planner.server"
  );
  const report = vi.fn();
  const result = await calculateChargePlan(
    chargeBatteryFixture as Battery,
    Date.now(),
    report,
  );
  expect(result.controlBlocker).toBeNull();
  expect(result.curtailmentModeled).toBe(true);
  expect(result.planningNote).toContain("EV charging is not forecast");
  expect(report).toHaveBeenCalledWith("ev-charging", result.planningNote);
  configMocks.arrays.mockResolvedValue([]);
  expect(
    (await calculateChargePlan(chargeBatteryFixture as Battery)).controlBlocker,
  ).toContain("No PV entity matches");
});

it("plans an AC output boundary only when the battery can limit discharge", async () => {
  const { chargeModel } = await import("../../app/lib/charge-planner.server");
  expect(chargeModel(chargeBatteryFixture as Battery, 60)).not.toHaveProperty(
    "dischargeStepW",
  );
  expect(
    chargeModel(
      { ...chargeBatteryFixture, dischargeLimitSupported: true } as Battery,
      60,
    ),
  ).toMatchObject({
    dischargeW: 2000,
    dischargeMinW: 0,
    dischargeStepW: 10,
  });
});
