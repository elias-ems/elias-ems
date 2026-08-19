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
 */
import type { Battery } from "./batteries";
import { listBatteries } from "./batteries.server";
import { type Grid, isGridConfigured } from "./grid";
import { readGrid } from "./grid.server";
import { haLiveStatus } from "./ha-live.server";
import {
  formatPricePerKwh,
  formatSlotClock,
  formatSlotRange,
} from "./price-format.server";
import { priceEntityIds, readPricesFrom } from "./price-source.server";
import type { PriceConfig } from "./prices";
import { readPriceConfig } from "./prices.server";
import type { PvEntity } from "./pv-entities";
import { listPvEntities } from "./pv-entities.server";
import type { LiveHealth, Reading } from "./readings";
import { toReading } from "./readings.server";
import { readingAge, readStates, type StateRead } from "./states.server";

export type DashboardReadings = {
  arrays: Array<{
    id: string;
    title: string;
    power: Reading | null;
    energy: Reading | null;
  }>;
  grid: {
    configured: boolean;
    power: Reading | null;
  };
  batteries: Array<{
    id: string;
    title: string;
    window: string;
    charge: Reading | null;
    power: Reading | null;
    energy: Reading | null;
  }>;
  prices: DashboardPrices;
  /** Why the readings are missing, when they are. Null when all is well. */
  error: string | null;
  /** How these readings reached us, and how well that path is working. */
  health: LiveHealth;
};

/**
 * The price card, formatted on the server like every other reading here.
 *
 * Strings rather than numbers, for the reason at the top of this file: what is
 * shown depends on the server's timezone and on a fixed number of decimals, and
 * deciding either during render risks the browser disagreeing with the markup
 * it is hydrating.
 */
export type DashboardPrices = {
  configured: boolean;
  /** What a kWh costs and earns right now, with the contract applied. */
  consumption: string | null;
  production: string | null;
  /** The exchange price the two were derived from, shown so they can be checked. */
  spot: string | null;
  /** Which quarter hour those are for, e.g. `22:45–23:00`. */
  slot: string | null;
  /** How far the forecast reaches, and whether tomorrow has been published. */
  coverage: string | null;
  /**
   * What currency the strings above are in, so anything else on the page that
   * has to render a price — curtailment's threshold — agrees with this card
   * rather than guessing at EUR.
   */
  currency: string;
  error: string | null;
};

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
): DashboardPrices {
  const read = readPricesFrom(config, states.get(config.forecastEntityId));

  if (!read.configured) {
    return {
      configured: false,
      consumption: null,
      production: null,
      spot: null,
      slot: null,
      coverage: null,
      currency: "EUR",
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
    slot: read.now
      ? formatSlotClock(read.now.slot.start, read.now.slot.end)
      : null,
    coverage:
      first && last
        ? `${read.forecast?.slots.length} slots · ${formatSlotRange(first.start, last.end)}`
        : null,
    currency,
    error: read.error,
  };
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

  const status = haLiveStatus();

  return {
    arrays: pvEntities.map((entity) => ({
      id: entity.id,
      title: entity.title,
      power: reading(entity.powerEntityId),
      energy: reading(entity.energyEntityId),
    })),
    grid: {
      configured: isGridConfigured(grid),
      power: grid.powerEntityId ? reading(grid.powerEntityId) : null,
    },
    batteries: batteries.map((battery) => ({
      id: battery.id,
      title: battery.title,
      window: `${battery.minChargePercent}–${battery.maxChargePercent}% of ${battery.capacityKwh} kWh`,
      charge: reading(battery.socEntityId),
      power: reading(battery.powerEntityId),
      energy: reading(battery.energyEntityId),
    })),
    prices: toPrices(config.prices, states),
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
