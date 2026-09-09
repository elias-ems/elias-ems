import type { Battery } from "./batteries";
import {
  type ChargeInterval,
  type ChargeModel,
  optimizeCharge,
} from "./charge-plan";
import { localHour } from "./energy-forecast";
import { readEnergyForecast } from "./energy-forecast.server";
import type { HaState } from "./ha.server";
import { readPrices } from "./price-source.server";
import { parsePriceFormulas, priceSlot } from "./prices";
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

export async function calculateChargePlan(battery: Battery, now = Date.now()) {
  const [energy, prices, readings] = await Promise.all([
    readEnergyForecast(now),
    readPrices(),
    readStates([battery.socEntityId, battery.chargeLimitEntityId || ""]),
  ]);
  const state = readings.states.get(battery.chargeLimitEntityId || "")?.state;
  const socState = readings.states.get(battery.socEntityId)?.state;
  if (socState?.attributes?.unit_of_measurement !== "%")
    throw new Error("The SoC entity must report percent.");
  const model = chargeModel(battery, state, numericState(socState));
  if (!prices.read.forecast || prices.read.error)
    throw new Error(
      prices.read.error || "Configure dynamic purchase and export prices.",
    );
  const margin = battery.solarMarginPercent ?? 20;
  if (!Number.isFinite(margin) || margin < 0 || margin > 80)
    throw new Error("Invalid solar forecast margin.");
  const solar = new Map(
    energy.solar.map((s) => [s.start, s.wh * (1 - margin / 100)]),
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
    slots.push({
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
  const plan = await optimizeCharge(slots, model, reserve);
  return {
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
