import {
  DEFAULT_PRICE_CONFIG,
  normalizePriceConfig,
  type PriceConfig,
} from "./prices";
import { readJson, writeJson } from "./store.server";

const FILE_NAME = "prices.json";

/**
 * Only the configuration is stored, never the forecast.
 *
 * While the source is a Home Assistant entity, Home Assistant *is* the store:
 * it fetched the day-ahead prices, it persists them, and it restates them after
 * a restart. A second copy here would be a cache with nothing to add and its
 * own way of going stale. That changes the day a built-in fetcher lands — at
 * which point losing tomorrow's prices to a restart at 23:00 becomes a real
 * failure and this file grows a forecast beside the config.
 */
export async function readPriceConfig(): Promise<PriceConfig> {
  return normalizePriceConfig(
    await readJson<Partial<PriceConfig>>(FILE_NAME, DEFAULT_PRICE_CONFIG),
  );
}

export async function savePriceConfig(config: PriceConfig): Promise<void> {
  await writeJson(FILE_NAME, config);
}
