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
  batteries: vi.fn(),
  grid: vi.fn(),
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
vi.mock("../../app/lib/batteries.server", () => ({
  listBatteries: configMocks.batteries,
}));
vi.mock("../../app/lib/grid.server", () => ({
  readGrid: configMocks.grid,
}));

vi.mock("../../app/lib/prices.server", () => ({
  readPriceConfig: async () => ({
    source: "home-assistant" as const,
    forecastEntityId: "sensor.energi_epex_spot",
    consumptionFormula: "price + 0.15",
    productionFormula: "price",
  }),
}));

let ha: Awaited<ReturnType<typeof startHaMock>>;

beforeEach(async () => {
  vi.resetModules();
  configMocks.control.mockResolvedValue({
    enabled: true,
    strategy: "charge-limit",
    chargeAlgorithm: "evening-target",
    eveningHour: 18,
    ceilingSwitchCost: 0.002,
  });
  configMocks.curtailment.mockResolvedValue(DEFAULT_CURTAILMENT_CONFIG);
  configMocks.arrays.mockResolvedValue([]);
  configMocks.batteries.mockResolvedValue([chargeBatteryFixture as Battery]);
  configMocks.grid.mockResolvedValue({ powerEntityId: "sensor.grid_power" });

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

describe("planner export data generation and route", () => {
  it("exports a complete dataset containing model, intervals, settings and configured devices", async () => {
    const { exportPlannerData } = await import(
      "../../app/lib/planner-export.server"
    );
    const dataset = await exportPlannerData();

    expect(dataset.schemaVersion).toBe(1);
    expect(dataset.kind).toBe("forecast-snapshot");
    expect(dataset.id).toMatch(/^household-export-/);
    expect(dataset.timeZone).toBe("Europe/Brussels");
    expect(dataset.currency).toBe("EUR");
    expect(dataset.slots.length).toBeGreaterThan(0);

    for (const slot of dataset.slots) {
      expect(Number.isFinite(slot.start)).toBe(true);
      expect(Number.isFinite(slot.end)).toBe(true);
      expect(Number.isFinite(slot.solarW)).toBe(true);
      expect(Number.isFinite(slot.loadW)).toBe(true);
      expect(Number.isFinite(slot.buy)).toBe(true);
      expect(Number.isFinite(slot.sell)).toBe(true);
    }

    expect(dataset.model.capacityKwh).toBe(chargeBatteryFixture.capacityKwh);
    expect(dataset.model.minSoc).toBe(chargeBatteryFixture.minChargePercent);
    expect(dataset.model.maxSoc).toBe(chargeBatteryFixture.maxChargePercent);
    expect(dataset.model.maxW).toBe(2000);
    expect(dataset.terminalReserveKwh).toBeGreaterThan(0);

    expect(dataset.settings.algorithm).toBe("evening-target");
    expect(dataset.settings.targetSoc).toBe(
      chargeBatteryFixture.maxChargePercent,
    );
    expect(dataset.settings.deadline).toBeDefined();

    expect(dataset.devices.battery.id).toBe(chargeBatteryFixture.id);
    expect(dataset.devices.batteries).toHaveLength(1);
    expect(dataset.devices.grid.powerEntityId).toBe("sensor.grid_power");
    expect(dataset.settings.algorithm).toBe("evening-target");
    expect(dataset.devices.control.strategy).toBe("charge-limit");
    expect(dataset.devices.curtailment).toBeDefined();
    expect(dataset.devices.prices.forecastEntityId).toBe(
      "sensor.energi_epex_spot",
    );

    expect(dataset.assumptions.length).toBeGreaterThan(3);
  });

  it("throws when no battery is configured", async () => {
    configMocks.batteries.mockResolvedValue([]);
    const { exportPlannerData } = await import(
      "../../app/lib/planner-export.server"
    );
    await expect(exportPlannerData()).rejects.toThrow(
      "No battery is configured",
    );
  });

  it("serves the export route with proper attachment headers", async () => {
    const { loader } = await import(
      "../../app/routes/api.planner-export[.]json"
    );
    const request = new Request("http://localhost/api/planner-export.json");
    const response = await loader({
      request,
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toMatch(
      /attachment; filename="elias-planner-export-.*\.json"/,
    );

    const data = await response.json();
    expect(data.schemaVersion).toBe(1);
    expect(data.kind).toBe("forecast-snapshot");
    expect(data.slots.length).toBeGreaterThan(0);
  });

  it("returns 400 error on the route when export fails", async () => {
    configMocks.batteries.mockResolvedValue([]);
    const { loader } = await import(
      "../../app/routes/api.planner-export[.]json"
    );
    const request = new Request("http://localhost/api/planner-export.json");
    const response = await loader({
      request,
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("No battery is configured");
  });
});
