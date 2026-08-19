/**
 * The one door in front of wherever prices come from.
 *
 * Today there is one source — a Home Assistant entity — and the point of the
 * door is that nothing downstream knows that. A built-in energy-charts or
 * ENTSO-E client arrives as another branch in `readPricesFrom` and changes
 * nothing above it, the same way `states.server.ts` puts one door in front of
 * the live cache and REST.
 *
 * No transport of its own, deliberately. A price entity is read through
 * `readStates()` like every other entity, which means it arrives over the
 * WebSocket cache with no round trip, degrades to REST when that is down, and
 * carries the same provenance as everything else on the page.
 */
import { formatPricePerKwh, formatSlotRange } from "./price-format.server";
import {
  isPriceConfigured,
  type PriceConfig,
  type PriceForecast,
  type PricePoint,
  type PriceSourceSummary,
  parsePriceForecast,
  parsePriceFormulas,
  priceSlot,
  slotAt,
} from "./prices";
import { readPriceConfig } from "./prices.server";
import { readStates, type StateRead } from "./states.server";

export type PriceRead = {
  configured: boolean;
  /** Null when unconfigured, unreadable, or the entity carried no series. */
  forecast: PriceForecast | null;
  /** The slot covering now, with the contract applied. Null outside coverage. */
  now: PricePoint | null;
  /**
   * Why there are no prices, when there are none. Null when all is well.
   *
   * One message rather than a state to branch on: every caller shows it and
   * none acts on the difference between "no such entity" and "that entity isn't
   * a price feed".
   */
  error: string | null;
  /** How old the entity's state is, in epoch ms, or null when unknown. */
  updatedAt: number | null;
};

/**
 * Whichever entities prices need, for the caller building the page's single
 * entity list.
 *
 * A list rather than the id, so that a second source needing two entities — or
 * none, once a built-in client exists — doesn't change the shape of this call.
 * Unconfigured returns nothing to read, which is what keeps an empty setting
 * from becoming a request to Home Assistant for the entity id `""`.
 */
export function priceEntityIds(config: PriceConfig): string[] {
  return isPriceConfigured(config) ? [config.forecastEntityId] : [];
}

/**
 * Build the price read from a state that has already been fetched.
 *
 * Split from `readPrices` so the dashboard can pass in the state it already
 * asked for. The alternative — a second `readStates` call from here — would
 * mean the card and the rest of the page could disagree about what Home
 * Assistant is saying, which is exactly the drift `dashboard.server.ts` builds
 * one entity list to avoid.
 */
export function readPricesFrom(
  config: PriceConfig,
  read: StateRead | undefined,
  now: number = Date.now(),
): PriceRead {
  if (!isPriceConfigured(config)) {
    return {
      configured: false,
      forecast: null,
      now: null,
      error: null,
      updatedAt: null,
    };
  }

  const empty = {
    configured: true,
    forecast: null,
    now: null,
    updatedAt: read?.updatedAt ?? null,
  };

  if (!read) {
    return { ...empty, error: "Home Assistant could not be reached." };
  }
  if (!read.state) {
    return {
      ...empty,
      error: `Home Assistant has no entity called ${config.forecastEntityId}.`,
    };
  }

  const parsed = parsePriceForecast(read.state.attributes);
  if (!parsed.ok) return { ...empty, error: parsed.error };

  const slot = slotAt(parsed.forecast, now);

  return {
    configured: true,
    forecast: parsed.forecast,
    now: slot ? priceSlot(slot, parsePriceFormulas(config)) : null,
    // Not an error: a forecast that hasn't reached the current instant is what
    // a stale entity looks like, and the card says so with the coverage it does
    // have rather than with a failure.
    error: slot
      ? null
      : "That entity's prices don't cover right now — it may not have refreshed.",
    updatedAt: read.updatedAt,
  };
}

/**
 * Read prices on their own — the settings page, which needs to say what it
 * found the moment an entity is picked, and has no dashboard read to borrow.
 *
 * Returns the configuration alongside the read because the caller needs both
 * and this already had to load it; asking the file twice would be two answers
 * to one question with a window in between for them to differ.
 */
export async function readPrices(): Promise<{
  config: PriceConfig;
  read: PriceRead;
}> {
  const config = await readPriceConfig();
  const ids = priceEntityIds(config);

  if (ids.length === 0) {
    return { config, read: readPricesFrom(config, undefined) };
  }

  const { states } = await readStates(ids);
  return {
    config,
    read: readPricesFrom(config, states.get(config.forecastEntityId)),
  };
}

const NOTHING = {
  spot: null,
  consumption: null,
  production: null,
  spotPerKwh: null,
  currency: "EUR",
};

/**
 * Describe what was found at the configured entity.
 *
 * A price entity is a needle in a haystack of hundreds of sensors, and the
 * failure this guards against is picking a plausible neighbour — an EPEX Spot
 * integration publishes both a market price and a *total* price that already
 * includes markups, and pointing a markup formula at the second one
 * double-counts into a number that still looks like a price.
 */
export function summarizePrices(read: PriceRead): PriceSourceSummary {
  if (!read.configured) {
    return { ok: false, detail: "No source picked yet.", ...NOTHING };
  }

  if (!read.forecast) {
    return {
      ok: false,
      detail: read.error ?? "No prices could be read from that entity.",
      ...NOTHING,
    };
  }

  const { forecast } = read;
  const minutes = forecast.slots.length
    ? Math.round(
        (Date.parse(forecast.slots[0].end) -
          Date.parse(forecast.slots[0].start)) /
          60_000,
      )
    : 0;

  const parts = [
    `${forecast.slots.length} slots of ${minutes} minutes`,
    forecast.slots.length
      ? formatSlotRange(
          forecast.slots[0].start,
          forecast.slots.at(-1)?.end ?? "",
        )
      : null,
    forecast.tomorrowIncluded ? "tomorrow included" : "today only",
    forecast.region,
  ].filter((part): part is string => Boolean(part));

  return {
    ok: true,
    detail: parts.join(" · "),
    spot: read.now
      ? formatPricePerKwh(read.now.spotPerKwh, forecast.currency)
      : null,
    consumption: read.now
      ? formatPricePerKwh(read.now.consumptionPerKwh, forecast.currency)
      : null,
    production: read.now
      ? formatPricePerKwh(read.now.productionPerKwh, forecast.currency)
      : null,
    spotPerKwh: read.now?.spotPerKwh ?? null,
    currency: forecast.currency,
  };
}
