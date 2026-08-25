/**
 * Everything the dashboard shows, built in one place.
 *
 * Two callers need exactly this: the home loader, which renders it, and the
 * readings stream, which pushes it whenever Home Assistant says something
 * moved. They have to agree down to the formatting — the stream's job is to
 * replace what the loader produced — so they share the function rather than the
 * intent.
 *
 * Readings are formatted here, on the server, for the reason `readings.server.ts`
 * gives: the strings are locale-dependent, and formatting them during render
 * would risk the server and the browser disagreeing.
 *
 * What comes out is typed in [dashboard.ts](dashboard.ts) rather than here, so
 * that the components drawing it can have the shape without importing a
 * `.server` module.
 */
import type { Battery } from "./batteries";
import { listBatteries } from "./batteries.server";
import type {
  DashboardPrices,
  DashboardReadings,
  PriceCurvePoint,
} from "./dashboard";
import { type Grid, isGridConfigured } from "./grid";
import { readGrid } from "./grid.server";
import { haLiveStatus } from "./ha-live.server";
import {
  formatPricePerKwh,
  formatSlotClock,
  formatSlotRange,
} from "./price-format.server";
import { priceEntityIds, readPricesFrom } from "./price-source.server";
import type { PriceConfig, PriceForecast, PriceFormulas } from "./prices";
import { parsePriceFormulas, priceSlot } from "./prices";
import { readPriceConfig } from "./prices.server";
import type { PvEntity } from "./pv-entities";
import { listPvEntities } from "./pv-entities.server";
import { publishedLimitPercent } from "./pv-limits.server";

import { toNumber, toReading } from "./readings.server";
import { readingAge, readStates, type StateRead } from "./states.server";
import { publishedTargetW } from "./targets.server";

/** The stored configuration everything on the page is derived from. */
type DashboardConfig = {
  pvEntities: PvEntity[];
  grid: Grid;
  batteries: Battery[];
  prices: PriceConfig;
};

async function readConfig(): Promise<DashboardConfig> {
  const [pvEntities, grid, batteries, prices] = await Promise.all([
    listPvEntities(),
    readGrid(),
    listBatteries(),
    readPriceConfig(),
  ]);

  return { pvEntities, grid, batteries, prices };
}

/**
 * Every entity the page's readings are built from.
 *
 * One list, and both callers derive from it: `readDashboard` reads exactly
 * these, and the stream pushes for exactly these. Spelled out twice they would
 * eventually disagree, and the failure is a quiet one — a card whose entity
 * nobody is watching renders once on load and then sits there, correct-looking
 * and stale, until something else on the page happens to move.
 *
 * Unconfigured ids are dropped rather than carried as empty strings: a grid
 * with no sensor picked yet is one fewer reading on the page, not an entity to
 * go and ask Home Assistant about.
 */
function dashboardEntityIds({
  pvEntities,
  grid,
  batteries,
  prices,
}: DashboardConfig): string[] {
  return [
    ...pvEntities.flatMap((entity) => [
      entity.powerEntityId,
      entity.energyEntityId,
    ]),
    grid.powerEntityId,
    ...batteries.flatMap((battery) => [
      battery.powerEntityId,
      battery.energyEntityId,
      battery.socEntityId,
    ]),
    // The price entity is on this list for the same reason everything else is,
    // and it is the whole of what makes prices live: its state changes at every
    // slot boundary, so the stream pushes a new card the moment the price does.
    // Nothing here polls a clock.
    ...priceEntityIds(prices),
  ].filter((id): id is string => Boolean(id));
}

/**
 * The price card, from the state this page already asked for.
 *
 * Built from the same `states` map as every other reading rather than from a
 * read of its own, which is what keeps the card and the rest of the page
 * describing the same instant.
 */
function toPrices(
  config: PriceConfig,
  states: Map<string, StateRead>,
  now: number,
): DashboardPrices {
  const read = readPricesFrom(config, states.get(config.forecastEntityId), now);

  if (!read.configured) {
    return {
      configured: false,
      consumption: null,
      production: null,
      spot: null,
      productionPerKwh: null,
      slot: null,
      coverage: null,
      currency: "EUR",
      curve: [],
      nowMinutes: null,
      error: null,
    };
  }

  const currency = read.forecast?.currency ?? "EUR";
  const first = read.forecast?.slots[0];
  const last = read.forecast?.slots.at(-1);

  // Null rather than a placeholder string, so the card can tell "no number"
  // from a number and render it muted the way a missing reading already is. A
  // leg is null when its formula no longer evaluates, which must not look like
  // a price.
  const price = (value: number | null | undefined) =>
    value === null || value === undefined
      ? null
      : formatPricePerKwh(value, currency);

  return {
    configured: true,
    consumption: price(read.now?.consumptionPerKwh),
    production: price(read.now?.productionPerKwh),
    spot: price(read.now?.spotPerKwh),
    productionPerKwh: read.now?.productionPerKwh ?? null,
    slot: read.now
      ? formatSlotClock(read.now.slot.start, read.now.slot.end)
      : null,
    coverage:
      first && last
        ? `${read.forecast?.slots.length} slots · ${formatSlotRange(first.start, last.end)}`
        : null,
    currency,
    curve: read.forecast
      ? toCurve(read.forecast, parsePriceFormulas(config), now)
      : [],
    nowMinutes: read.now ? startMinutes(read.now.slot.start) : null,
    error: read.error,
  };
}

/** Minutes past local midnight for an ISO instant, or null when it won't parse. */
function startMinutes(iso: string): number | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : at.getHours() * 60 + at.getMinutes();
}

/**
 * Today's slots, averaged into one point per hour.
 *
 * Today only: the forecast carries tomorrow as soon as it is published, and a
 * chart that silently grew a second day would make every hour half as wide
 * halfway through the afternoon.
 *
 * Bucketed by the hour each slot *starts* in rather than by an index, for the
 * reason `PriceSlot` carries explicit boundaries at all — providers publish
 * quarter-hourly or hourly and a DST day has neither 96 nor 24 of them, so any
 * arithmetic over a position in the array is wrong twice a year.
 */
function toCurve(
  forecast: PriceForecast,
  formulas: PriceFormulas,
  now: number,
): PriceCurvePoint[] {
  const today = new Date(now).toDateString();
  const buckets = new Map<number, number[]>();

  for (const slot of forecast.slots) {
    const at = new Date(slot.start);
    if (Number.isNaN(at.getTime()) || at.toDateString() !== today) continue;

    // A slot whose selling leg does not evaluate is left out rather than
    // charted as zero: the gap says "no number here", which is true, and a
    // zero would sit exactly on the threshold line and read as a decision.
    const selling = priceSlot(slot, formulas).productionPerKwh;
    if (selling === null) continue;

    const hour = at.getHours() * 60;
    const bucket = buckets.get(hour);
    if (bucket) bucket.push(selling);
    else buckets.set(hour, [selling]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startMinutes, values]) => ({
      startMinutes,
      sellingPerKwh:
        values.reduce((sum, value) => sum + value, 0) / values.length,
    }));
}

export async function readDashboard(): Promise<DashboardReadings> {
  const config = await readConfig();
  const { pvEntities, grid, batteries } = config;

  const { states, error } = await readStates(dashboardEntityIds(config));

  // Null rather than a reading when the read never happened, so the card shows
  // a dash instead of claiming the entity is missing.
  const reading = (id: string) => {
    const read = states.get(id);
    return read ? toReading(read.state, read.updatedAt) : null;
  };

  /** The same read as a number, for the bars and meters rather than the labels. */
  const value = (id: string) => toNumber(states.get(id)?.state ?? null);

  const status = haLiveStatus();
  const now = Date.now();

  return {
    arrays: pvEntities.map((entity) => ({
      id: entity.id,
      title: entity.title,
      power: reading(entity.powerEntityId),
      energy: reading(entity.energyEntityId),
      powerW: value(entity.powerEntityId),
      ratedPowerW: entity.ratedPowerW,
      curtailable: entity.curtailable,
      limitPercent: publishedLimitPercent(entity.id),
    })),
    grid: {
      configured: isGridConfigured(grid),
      power: grid.powerEntityId ? reading(grid.powerEntityId) : null,
      powerW: grid.powerEntityId ? value(grid.powerEntityId) : null,
    },
    batteries: batteries.map((battery) => ({
      id: battery.id,
      title: battery.title,
      window: `${battery.minChargePercent}–${battery.maxChargePercent}% of ${battery.capacityKwh} kWh`,
      charge: reading(battery.socEntityId),
      power: reading(battery.powerEntityId),
      energy: reading(battery.energyEntityId),
      chargePercent: value(battery.socEntityId),
      targetW: publishedTargetW(battery.id),
    })),
    prices: toPrices(config.prices, states, now),
    error,
    health: {
      connected: status.connected,
      lastEventAt: status.lastEventAt,
      connectedSince: status.connectedSince,
      lastError: status.lastError,
      reconnects: status.reconnects,
      source: readingAge(states).source,
    },
  };
}

/**
 * The entity ids a set of readings was built from — what the stream watches to
 * decide whether a change is worth pushing. Derived from the configuration
 * rather than remembered, because it changes whenever settings are saved.
 */
export async function watchedEntityIds(): Promise<Set<string>> {
  return new Set(dashboardEntityIds(await readConfig()));
}
