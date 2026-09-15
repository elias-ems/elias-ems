import type { Battery } from "./batteries";
import { evening } from "./charge-evening";
import {
  type ChargeInterval,
  type ChargeModel,
  optimizeCharge,
} from "./charge-plan";
import { readControlConfig } from "./control-config.server";
import { readCurtailmentConfig } from "./curtailment-config.server";
import { localHour } from "./energy-forecast";
import { readEnergyForecast } from "./energy-forecast.server";
import type { HaState } from "./ha.server";
import { readPrices } from "./price-source.server";
import { parsePriceFormulas, priceSlot } from "./prices";
import { listPvEntities } from "./pv-entities.server";
import { publishedLimitPercent } from "./pv-limits.server";
import { readStates } from "./states.server";

export function numericState(state: HaState | null | undefined): number | null {
  if (!state?.state.trim()) return null;
  const value = Number(state.state);
  return Number.isFinite(value) ? value : null;
}

export function chargeModel(
  battery: Battery,
  state: HaState | null | undefined,
  soc: number | null,
): ChargeModel {
  const a = state?.attributes;
  const min = a?.min;
  const max = a?.max;
  const step = a?.step;
  if (
    !state?.entity_id.startsWith("number.") ||
    a?.unit_of_measurement !== "W" ||
    typeof min !== "number" ||
    typeof max !== "number" ||
    typeof step !== "number" ||
    ![min, max, step].every(Number.isFinite) ||
    min < 0 ||
    max <= min ||
    step <= 0 ||
    numericState(state) === null
  ) {
    throw new Error(
      "The maximum charge limit must be an available number entity in W with valid min, max and step attributes.",
    );
  }
  if (soc === null || !Number.isFinite(soc) || soc < 0 || soc > 100)
    throw new Error(
      "Battery state of charge is unavailable or outside 0–100%.",
    );
  if (!battery.maxChargePowerW || !battery.maxDischargePowerW)
    throw new Error(
      "Configure hardware charge and discharge limits before planning.",
    );
  const maxW = Math.min(max, battery.maxChargePowerW);
  if (maxW < min)
    throw new Error(
      "The hardware charge ceiling is below the entity's minimum.",
    );
  return {
    capacityKwh: battery.capacityKwh,
    minSoc: battery.minChargePercent,
    maxSoc: battery.maxChargePercent,
    soc,
    minW: min,
    maxW,
    stepW: step,
    dischargeW: battery.maxDischargePowerW,
    efficiency: (battery.chargeEfficiencyPercent ?? 95) / 100,
    wearPerKwh: battery.chargeWearPerKwh ?? 0,
  };
}

export async function calculateChargePlan(
  battery: Battery,
  now = Date.now(),
  report: (key: string, message: string) => void = () => {},
) {
  const control = await readControlConfig();
  battery = {
    ...battery,
    solarMarginPercent:
      control.solarMarginPercent ?? battery.solarMarginPercent,
    chargeWearPerKwh: control.chargeWearPerKwh ?? battery.chargeWearPerKwh,
  };
  const checked = async <T>(key: string, task: Promise<T>): Promise<T> => {
    try {
      const result = await task;
      report(key, "Available");
      return result;
    } catch (error) {
      report(key, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const results = await Promise.allSettled([
    checked("history", readEnergyForecast(now, report)),
    checked(
      "prices",
      readPrices().then((result) => {
        if (result.read.error || !result.read.forecast)
          throw new Error(result.read.error || "Configure dynamic prices.");
        return result;
      }),
    ),
    checked(
      "battery",
      readStates([battery.socEntityId, battery.chargeLimitEntityId || ""]).then(
        (readings) => {
          const soc = readings.states.get(battery.socEntityId)?.state;
          if (soc?.attributes?.unit_of_measurement !== "%")
            throw new Error("The SoC entity must report percent.");
          chargeModel(
            battery,
            readings.states.get(battery.chargeLimitEntityId || "")?.state,
            numericState(soc),
          );
          return readings;
        },
      ),
    ),
  ] as const);
  const [e, p, r] = results;
  if (e.status === "rejected") throw e.reason;
  if (p.status === "rejected") throw p.reason;
  if (r.status === "rejected") throw r.reason;
  const [energy, prices, readings] = [e.value, p.value, r.value] as const;
  const state = readings.states.get(battery.chargeLimitEntityId || "")?.state;
  const socState = readings.states.get(battery.socEntityId)?.state;
  if (socState?.attributes?.unit_of_measurement !== "%")
    throw new Error("The SoC entity must report percent.");
  const model = chargeModel(battery, state, numericState(socState));
  const [curtailment, arrays] = await Promise.all([
    readCurtailmentConfig(),
    listPvEntities(),
  ]);
  const solarSources =
    energy.preferences?.energy_sources.filter((s) => s.type === "solar") || [];
  // Keep each source's forecast attached to its inverter. Shared providers
  // cannot be attributed to two different arrays without double-counting.
  const mappedArrays = solarSources.map((source) =>
    arrays.find((array) => array.energyEntityId === source.stat_energy_from),
  );
  const curtailmentModeled =
    curtailment.enabled &&
    !curtailment.carChargingEntityId &&
    solarSources.length > 0 &&
    new Set(
      solarSources.flatMap((source) => [
        ...new Set(source.config_entry_solar_forecast || []),
      ]),
    ).size ===
      solarSources.reduce(
        (sum, source) =>
          sum + new Set(source.config_entry_solar_forecast || []).size,
        0,
      ) &&
    mappedArrays.every((array) => (array?.ratedPowerW ?? 0) > 0);
  const controlBlocker =
    curtailment.enabled && !curtailmentModeled
      ? "Hypothetical preview: assumes uncurtailed solar. This PV curtailment configuration is not yet modeled; charge-limit control is blocked."
      : null;
  report(
    "curtailment",
    curtailmentModeled
      ? "PV limits are modeled using each array's forecast and inverter rating; controller transients are not predicted."
      : controlBlocker || "Disabled",
  );
  if (!prices.read.forecast || prices.read.error)
    throw new Error(
      prices.read.error || "Configure dynamic purchase and export prices.",
    );
  const margin = battery.solarMarginPercent ?? 20;
  if (!Number.isFinite(margin) || margin < 0 || margin > 80)
    throw new Error("Invalid solar forecast margin.");
  const solar = new Map(
    energy.solar.map((s) => [
      s.start,
      s.wh *
        (control.chargeAlgorithm === "evening-target" ? 1 : 1 - margin / 100),
    ]),
  );
  const priced = prices.read.forecast.slots.map((s) => ({
    ...priceSlot(s, parsePriceFormulas(prices.config)),
    start: Date.parse(s.start),
    end: Date.parse(s.end),
  }));
  const end = Math.min(
    now + 48 * 3_600_000,
    energy.forecastEnd,
    priced.at(-1)?.end || now,
  );
  const slots: ChargeInterval[] = [];
  let initialEpisode = true;
  for (let t = now; t < end; ) {
    const hour = Math.floor(t / 3_600_000) * 3_600_000;
    const pv = solar.get(hour);
    const p = priced.find((s) => s.start <= t && t < s.end);
    if (
      pv === undefined ||
      !p ||
      p.consumptionPerKwh === null ||
      p.productionPerKwh === null
    )
      throw new Error(
        "Forecast or price coverage has a gap. Waiting for complete data.",
      );
    const next = Math.min(end, p.end, (Math.floor(t / 900_000) + 1) * 900_000);
    const arrayForecastW = (array: (typeof mappedArrays)[number]) => {
      const source = energy.solarBySource.find(
        (source) => source.energyEntityId === array?.energyEntityId,
      );
      const wh = source?.hours.find((item) => item.start === hour)?.wh ?? 0;
      return (
        wh *
        (control.chargeAlgorithm === "evening-target" ? 1 : 1 - margin / 100)
      );
    };
    const above = p.productionPerKwh - curtailment.priceThresholdPerKwh;
    if (above >= 0) initialEpisode = false;
    const band =
      above >= 0 && curtailment.strategy !== "threshold"
        ? curtailment.bands.find((candidate) => above < candidate.abovePerKwh)
        : undefined;
    const activelyCurtailed =
      curtailmentModeled && (above < 0 || band !== undefined);
    const fixedW = mappedArrays.reduce((sum, array) => {
      if (!array) return sum;
      const availableW = arrayForecastW(array);
      if (!array.curtailable) return sum + availableW;
      if (array.controlMode !== "stepped") return sum;
      // Stepped arrays participate below the threshold and are released in all
      // marginal bands, matching the live controller's write-saving policy.
      return (
        sum +
        (above < 0
          ? Math.min(
              availableW,
              ((array.stepLimitPercent ?? 100) * (array.ratedPowerW ?? 0)) /
                100,
            )
          : availableW)
      );
    }, 0);
    const modulating = mappedArrays.filter(
      (array) => array?.curtailable && array.controlMode === "modulating",
    );
    const modulatingRatedW = modulating.reduce(
      (sum, array) => sum + (array?.ratedPowerW ?? 0),
      0,
    );
    const availableW = modulating.reduce(
      (sum, array) => sum + arrayForecastW(array),
      0,
    );
    const floorW = Math.min(
      availableW,
      (modulatingRatedW * curtailment.minLimitPercent) / 100,
    );
    slots.push({
      curtailment: activelyCurtailed
        ? {
            fixedW,
            deadbandW: curtailment.deadbandW,
            fixedArrays: mappedArrays
              .filter(
                (array) =>
                  array &&
                  (!array.curtailable || array.controlMode === "stepped"),
              )
              .map((array) => ({
                availableW: arrayForecastW(array),
                ceilingW: array?.ratedPowerW ?? 0,
                stepW:
                  array?.curtailable && above < 0
                    ? ((array.ratedPowerW ?? 0) *
                        (array.stepLimitPercent ?? 100)) /
                      100
                    : undefined,
                initiallyStepped:
                  initialEpisode &&
                  array !== undefined &&
                  (publishedLimitPercent(array.id) ?? 100) < 100,
              })),
            availableW,
            modulatingArrays: modulating.map((array) => ({
              availableW: arrayForecastW(array),
              floorW:
                ((array?.ratedPowerW ?? 0) * curtailment.minLimitPercent) / 100,
              ceilingW:
                above >= 0 && curtailment.strategy === "soft-ceiling" && band
                  ? ((array?.ratedPowerW ?? 0) *
                      Math.max(
                        curtailment.minLimitPercent,
                        band.ceilingPercent,
                      )) /
                    100
                  : undefined,
            })),
            floorW,
            ceilingW:
              above >= 0 && curtailment.strategy === "soft-ceiling" && band
                ? (modulatingRatedW *
                    Math.max(
                      curtailment.minLimitPercent,
                      band.ceilingPercent,
                    )) /
                  100
                : undefined,
            gridTargetW: curtailment.gridTargetW,
            exportAllowanceW:
              above >= 0 && curtailment.strategy === "graded-export" && band
                ? (modulatingRatedW * band.exportPercent) / 100
                : 0,
          }
        : undefined,
      start: t,
      end: next,
      solarW: pv,
      loadW: energy.profile.watts[localHour(t, energy.profile.timeZone)],
      buy: p.consumptionPerKwh,
      sell: p.productionPerKwh,
      estimatedPrice: false,
    });
    t = next;
  }
  if (end - now < 3_600_000)
    throw new Error(
      "Less than one hour of complete price and solar coverage remains.",
    );
  // Value energy beyond published prices by the demand before the next solar
  // recovery. No fabricated future tariff is inserted into the financial chart.
  let deficit = 0;
  let reserve = 0;
  let reserveCovered = false;
  for (let t = end; t < end + 24 * 3_600_000; t += 900_000) {
    const pv = solar.get(Math.floor(t / 3_600_000) * 3_600_000);
    if (pv === undefined) break;
    const load = energy.profile.watts[localHour(t, energy.profile.timeZone)];
    deficit += (load - pv) / 4000;
    reserve = Math.max(reserve, deficit / model.efficiency);
    if (deficit <= 0 && pv > load) {
      reserveCovered = true;
      break;
    }
  }
  // If tomorrow's recovery is not covered, retain a conservative full-window
  // terminal value rather than treating the end of the forecast as free energy.
  if (!reserveCovered)
    reserve = (model.capacityKwh * (model.maxSoc - model.minSoc)) / 100;
  let plan:
    | Awaited<ReturnType<typeof optimizeCharge>>
    | Awaited<ReturnType<typeof evening>>;
  if (control.chargeAlgorithm === "evening-target") {
    const hour = control.eveningHour ?? 18;
    const switchCost = control.ceilingSwitchCost ?? 0.002;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23)
      throw new Error("Invalid evening deadline hour.");
    // Search real instants, rather than adding 24h, to respect HA timezone/DST.
    const deadlineSlot = slots.find(
      (s) =>
        new Intl.DateTimeFormat("en-GB", {
          timeZone: energy.profile.timeZone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(s.end) === `${String(hour).padStart(2, "0")}:00`,
    );
    if (!deadlineSlot)
      throw new Error(
        "Waiting for solar and price coverage through the next evening deadline.",
      );
    const eveningPlan = await evening(
      { slots, model, terminalReserveKwh: reserve },
      {
        deadline: new Date(deadlineSlot.end).toISOString(),
        targetSoc: model.maxSoc,
        solarHaircut: margin / 100,
        switchCost,
        spikeBufferKwh: control.spikeBufferKwh ?? 0.54,
        passes: 4,
      },
    );
    plan = eveningPlan;
    report(
      "algorithm",
      `Evening target: ${model.maxSoc}% by ${hour}:00; reachable nominal/reduced-solar SoC ${eveningPlan.target.reachableSoc.map((s) => s.toFixed(1)).join(" / ")}%`,
    );
  } else {
    plan = await optimizeCharge(slots, model, reserve);
    report("algorithm", "Cost optimized");
  }
  return {
    controlBlocker,
    curtailmentModeled,
    plan,
    model,
    reportedW: numericState(state),
    currency: prices.read.forecast.currency,
    forecastEnd: energy.forecastEnd,
    sources: energy.sources.length,
    historyHours: energy.profile.hours,
    timeZone: energy.profile.timeZone,
    solarMarginPercent: margin,
    reserveCovered,
  };
}
