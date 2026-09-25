import type { Battery } from "./batteries";
import { listBatteries } from "./batteries.server";
import type { ChargeInterval, ChargeModel } from "./charge-plan";
import { preparePlannerInputs } from "./charge-planner.server";
import type { ControlConfig } from "./control";
import { readControlConfig } from "./control-config.server";
import type { CurtailmentConfig } from "./curtailment";
import { readCurtailmentConfig } from "./curtailment-config.server";
import type { Grid } from "./grid";
import { readGrid } from "./grid.server";
import type { PriceConfig } from "./prices";
import { readPriceConfig } from "./prices.server";
import type { PvEntity } from "./pv-entities";
import { listPvEntities } from "./pv-entities.server";

export type PlannerExportDataset = {
  schemaVersion: 1;
  id: string;
  timeZone: string;
  currency: string;
  kind: "forecast-snapshot";
  capturedAt: string;
  requestedEnd: string;
  actualEnd: string;
  model: ChargeModel;
  terminalReserveKwh: number;
  assumptions: string[];
  slots: ChargeInterval[];
  settings: {
    deadline: string;
    targetSoc: number;
    solarHaircut: number;
    switchCost: number;
    passes: number;
    spikeBufferKwh: number;
    algorithm: "cost-optimized" | "evening-target";
    algorithms: ["cost-optimized", "evening-target"];
  };
  devices: {
    battery: Battery;
    batteries: Battery[];
    pvEntities: PvEntity[];
    grid: Grid;
    curtailment: CurtailmentConfig;
    control: ControlConfig;
    prices: PriceConfig;
  };
  context?: {
    loadProfile?: {
      timeZone: string;
      hours: number;
      watts: number[];
    };
    rawSolarForecast?: Array<{ start: number; wh: number }>;
    solarBySource?: Array<{
      energyEntityId?: string | null;
      hours: Array<{ start: number; wh: number }>;
    }>;
  };
};

export async function exportPlannerData(
  batteryId?: string,
  now = Date.now(),
): Promise<PlannerExportDataset> {
  const batteries = await listBatteries();
  if (!batteries.length) {
    throw new Error(
      "No battery is configured. Configure a battery in Settings before exporting.",
    );
  }
  const battery =
    (batteryId ? batteries.find((b) => b.id === batteryId) : undefined) ||
    batteries.find((b) => Boolean(b.chargeLimitEntityId)) ||
    batteries[0];

  const [inputs, pvEntities, grid, control, curtailment, priceConfig] =
    await Promise.all([
      preparePlannerInputs(battery, now),
      listPvEntities(),
      readGrid(),
      readControlConfig(),
      readCurtailmentConfig(),
      readPriceConfig(),
    ]);

  const assumptions = [
    `Forecast snapshot exported from Home Assistant on ${new Date(now).toISOString()}.`,
    `Solar forecast from Energy dashboard: ${inputs.sources} source(s) spanning ${Math.round(inputs.slots.length / 4)} hours.`,
    `Household demand profile derived from 14-day history (${inputs.historyHours} hours of data).`,
    `Tariffs evaluated using configured dynamic price rules (currency: ${inputs.currency}).`,
    inputs.curtailmentModeled
      ? `PV curtailment modeled with strategy "${curtailment.strategy}" across ${pvEntities.length} configured PV array(s).`
      : "PV curtailment unmodeled or disabled.",
    `Battery "${battery.title}": ${battery.capacityKwh} kWh capacity, ${inputs.model.minSoc}%–${inputs.model.maxSoc}% SoC window, initial SoC ${inputs.model.soc.toFixed(1)}%.`,
    inputs.reserveCovered
      ? "Terminal reserve valued based on forecasted load deficit before the next solar recovery."
      : "Full terminal reserve valued because next solar recovery is not covered in the horizon.",
  ];

  return {
    schemaVersion: 1,
    id: `household-export-${new Date(now).toISOString().slice(0, 10)}-${now}`,
    timeZone: inputs.timeZone,
    currency: inputs.currency,
    kind: "forecast-snapshot",
    capturedAt: new Date(now).toISOString(),
    requestedEnd: new Date(inputs.forecastEnd).toISOString(),
    actualEnd: inputs.slots.length
      ? new Date(inputs.slots[inputs.slots.length - 1].end).toISOString()
      : new Date(now).toISOString(),
    model: inputs.model,
    terminalReserveKwh: inputs.reserve,
    assumptions,
    slots: inputs.slots,
    settings: inputs.settings,
    devices: {
      battery,
      batteries,
      pvEntities,
      grid,
      curtailment,
      control,
      prices: priceConfig,
    },
    context: {
      loadProfile: inputs.raw.energy.profile,
      rawSolarForecast: inputs.raw.energy.solar,
      solarBySource: inputs.raw.energy.solarBySource,
    },
  };
}
