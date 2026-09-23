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
    expect(result.reportedW).toBe(2000);
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
    expect(result.reportedW).toBe(2000);
  });
  it("rejects the wrong unit or invalid range instead of applying guessed bounds", async () => {
    const { chargeModel } = await import("../../app/lib/charge-planner.server");
    expect(() =>
      chargeModel(
        chargeBatteryFixture as Battery,
        {
          ...chargeEntityFixture,
          attributes: {
            ...chargeEntityFixture.attributes,
            unit_of_measurement: "%",
          },
        },
        50,
      ),
    ).toThrow("in W");
    expect(() =>
      chargeModel(chargeBatteryFixture as Battery, chargeEntityFixture, NaN),
    ).toThrow();
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

it("uses evening planning even for a retired cost-optimized selection", {
  timeout: 15_000,
}, async () => {
  configMocks.control.mockResolvedValue({
    enabled: false,
    strategy: "charge-limit",
    chargeAlgorithm: "cost-optimized",
    eveningHour: 18,
    solarMarginPercent: 20,
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

it("validates the AC output entity and caps its range at the hardware limit", async () => {
  const { chargeModel } = await import("../../app/lib/charge-planner.server");
  const battery = {
    ...chargeBatteryFixture,
    dischargeLimitEntityId: "number.ac_output",
  } as Battery;
  const output = {
    ...chargeEntityFixture,
    entity_id: "number.ac_output",
    attributes: {
      ...chargeEntityFixture.attributes,
      min: 50,
      max: 3000,
      step: 50,
    },
  };
  expect(chargeModel(battery, chargeEntityFixture, 60, output)).toMatchObject({
    dischargeW: 2000,
    dischargeMinW: 50,
    dischargeStepW: 50,
  });
  for (const invalid of [
    undefined,
    { ...output, state: "unavailable" },
    {
      ...output,
      attributes: { ...output.attributes, unit_of_measurement: "%" },
    },
    { ...output, attributes: { ...output.attributes, step: 0 } },
    { ...output, attributes: { ...output.attributes, min: 2500 } },
  ]) {
    expect(() =>
      chargeModel(battery, chargeEntityFixture, 60, invalid),
    ).toThrow();
  }
});
