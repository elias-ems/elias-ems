import { createHash } from "node:crypto";
import type { Battery } from "./batteries";
import { listBatteries } from "./batteries.server";
import { readControlConfig } from "./control-config.server";
import { readCurtailmentConfig } from "./curtailment-config.server";
import { readGrid } from "./grid.server";
import { readPriceConfig } from "./prices.server";
import type { PvEntity } from "./pv-entities";
import { listPvEntities } from "./pv-entities.server";

const batteryKeys = [
  "id",
  "title",
  "controlModes",
  "commandContract",
  "dischargeLimitSupported",
  "powerStepW",
  "chargeLimitPlanning",
  "chargeEfficiencyPercent",
  "capacityKwh",
  "minChargePercent",
  "maxChargePercent",
  "energyEntityId",
  "powerEntityId",
  "socEntityId",
  "steered",
  "maxChargePowerW",
  "maxDischargePowerW",
] as const satisfies readonly (keyof Battery)[];

export const pvFieldKeys = [
  "title",
  "powerEntityId",
  "energyEntityId",
  "ratedPowerW",
  "controlMode",
  "stepLimitPercent",
] as const satisfies readonly (keyof PvEntity)[];

function pick<T, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as Pick<
    T,
    K
  >;
}

export async function readSettingsApi() {
  const [batteries, pvEntities, grid, prices, control, curtailment] =
    await Promise.all([
      listBatteries(),
      listPvEntities(),
      readGrid(),
      readPriceConfig(),
      readControlConfig({ migrate: false }),
      readCurtailmentConfig(),
    ]);
  const settings = {
    batteries: batteries.map((battery) => pick(battery, batteryKeys)),
    pvEntities: pvEntities.map((entity) =>
      pick(entity, ["id", ...pvFieldKeys, "curtailable"]),
    ),
    grid,
    prices,
    control,
    curtailment,
  };
  return {
    settings,
    revision: createHash("sha256")
      .update(JSON.stringify(settings))
      .digest("hex"),
  };
}

export function apiResponse(body: unknown, status = 200, allow?: string) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (allow) headers.set("Allow", allow);
  return Response.json(body, { status, headers });
}
