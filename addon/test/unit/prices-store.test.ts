/**
 * Persisting the price configuration, and the door in front of whatever source
 * it names.
 *
 * `DATA_DIR` is read per call by store.server.ts, so setting the variable is
 * enough — no `vi.resetModules()` needed.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  priceEntityIds,
  readPricesFrom,
  summarizePrices,
} from "../../app/lib/price-source.server";
import { DEFAULT_PRICE_CONFIG, type PriceConfig } from "../../app/lib/prices";
import { readPriceConfig, savePriceConfig } from "../../app/lib/prices.server";
import type { StateRead } from "../../app/lib/states.server";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "elias-ems-prices-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

const configured: PriceConfig = {
  source: "home-assistant",
  forecastEntityId: "sensor.energi_epex_spot",
  consumptionFormula: "((price * 1.02) + 0.1272) * 1.06",
  productionFormula: "max(price * 0.98 - 0.015, 0)",
};

/** Quarter-hourly slots either side of `aroundIso`, as the entity publishes them. */
function entityState(aroundIso: string, prices: number[]): StateRead {
  const startMs = Date.parse(aroundIso);
  return {
    state: {
      entity_id: "sensor.energi_epex_spot",
      state: String(prices[0]),
      attributes: {
        currency: "EUR",
        region: "Belgium",
        tomorrow_valid: false,
        unit_of_measurement: "EUR/kWh",
        raw_today: prices.map((price, index) => ({
          hour: new Date(startMs + index * 15 * 60_000).toISOString(),
          price,
        })),
      },
    },
    updatedAt: startMs,
    source: "live",
  };
}

describe("the stored configuration", () => {
  it("reads an unconfigured default before anything is saved", async () => {
    expect(await readPriceConfig()).toEqual(DEFAULT_PRICE_CONFIG);
  });

  it("round trips", async () => {
    await savePriceConfig(configured);
    expect(await readPriceConfig()).toEqual(configured);
  });

  it("normalizes a hand-edited file", async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "prices.json"),
      JSON.stringify({
        source: "home-assistant",
        forecastEntityId: "  sensor.prices  ",
      }),
    );

    const config = await readPriceConfig();

    expect(config.forecastEntityId).toBe("sensor.prices");
    expect(config.consumptionFormula).toBe("price");
  });

  it("stores only the configuration, never the forecast", async () => {
    // Home Assistant already holds and persists the prices; a second copy here
    // would be a cache with nothing to add and its own way of going stale.
    await savePriceConfig(configured);
    const stored = await readPriceConfig();

    expect(Object.keys(stored).sort()).toEqual([
      "consumptionFormula",
      "forecastEntityId",
      "productionFormula",
      "source",
    ]);
  });
});

describe("which entities prices need", () => {
  it("asks for the configured sensor", () => {
    expect(priceEntityIds(configured)).toEqual(["sensor.energi_epex_spot"]);
  });

  it("asks for nothing while unconfigured", () => {
    // An empty setting must not become a request for the entity id "".
    expect(priceEntityIds(DEFAULT_PRICE_CONFIG)).toEqual([]);
    expect(priceEntityIds({ ...configured, forecastEntityId: "" })).toEqual([]);
  });
});

describe("reading through the door", () => {
  const at = "2026-08-18T22:00:00.000Z";
  const read = entityState(at, [0.1821, 0.1915, 0.1779]);

  it("applies both formulas to the slot covering now", () => {
    const result = readPricesFrom(
      configured,
      read,
      Date.parse("2026-08-18T22:05:00.000Z"),
    );

    expect(result.now?.spotPerKwh).toBe(0.1821);
    expect(result.now?.consumptionPerKwh).toBeCloseTo(0.331719, 6);
    expect(result.now?.productionPerKwh).toBeCloseTo(0.163458, 6);
    expect(result.error).toBeNull();
  });

  it("follows the clock into the next slot without anything refetching", () => {
    // The entity's state changes at each boundary, which is what pushes a new
    // read; but the slot the forecast answers with is chosen by the instant.
    const later = readPricesFrom(
      configured,
      read,
      Date.parse("2026-08-18T22:20:00.000Z"),
    );

    expect(later.now?.spotPerKwh).toBe(0.1915);
  });

  it("reports nothing at all while unconfigured, and calls it no error", () => {
    const result = readPricesFrom(DEFAULT_PRICE_CONFIG, undefined);

    expect(result).toMatchObject({
      configured: false,
      forecast: null,
      now: null,
      error: null,
    });
  });

  it("says which entity is missing when Home Assistant doesn't know it", () => {
    const result = readPricesFrom(configured, {
      state: null,
      updatedAt: null,
      source: "live",
    });

    expect(result.error).toContain("sensor.energi_epex_spot");
  });

  it("reports an unreachable Home Assistant rather than an empty forecast", () => {
    expect(readPricesFrom(configured, undefined).error).toMatch(
      /could not be reached/,
    );
  });

  it("explains an entity that is not a price feed", () => {
    const result = readPricesFrom(configured, {
      state: {
        entity_id: "sensor.energi_epex_spot",
        state: "21.5",
        attributes: { unit_of_measurement: "°C" },
      },
      updatedAt: null,
      source: "live",
    });

    expect(result.error).toMatch(/raw_today|data/);
    expect(result.now).toBeNull();
  });

  it("keeps the forecast but reports no current price outside its coverage", () => {
    // A feed that stopped refreshing still has yesterday's shape to show. The
    // absent *current* price is the part worth saying out loud.
    const result = readPricesFrom(
      configured,
      read,
      Date.parse("2026-08-20T12:00:00.000Z"),
    );

    expect(result.forecast).not.toBeNull();
    expect(result.now).toBeNull();
    expect(result.error).toMatch(/don't cover right now/);
  });

  it("leaves a leg empty rather than reporting spot under its label", () => {
    const result = readPricesFrom(
      { ...configured, consumptionFormula: "price / 0" },
      read,
      Date.parse("2026-08-18T22:05:00.000Z"),
    );

    expect(result.now?.consumptionPerKwh).toBeNull();
    expect(result.now?.productionPerKwh).not.toBeNull();
  });
});

describe("what the settings page shows back", () => {
  it("describes the series so the right sensor can be recognised", () => {
    const summary = summarizePrices(
      readPricesFrom(
        configured,
        entityState("2026-08-18T22:00:00.000Z", [0.1821, 0.1915, 0.1779]),
        Date.parse("2026-08-18T22:05:00.000Z"),
      ),
    );

    expect(summary.ok).toBe(true);
    expect(summary.detail).toContain("3 slots of 15 minutes");
    expect(summary.detail).toContain("today only");
    expect(summary.detail).toContain("Belgium");
  });

  it("shows both derived prices next to the raw one", () => {
    // The check against a bill, and the thing that makes picking a *total*
    // price sensor by mistake visible rather than plausible.
    const summary = summarizePrices(
      readPricesFrom(
        configured,
        entityState("2026-08-18T22:00:00.000Z", [0.1821]),
        Date.parse("2026-08-18T22:05:00.000Z"),
      ),
    );

    expect(summary.spot).toBe("0.1821 EUR/kWh");
    expect(summary.consumption).toBe("0.3317 EUR/kWh");
    expect(summary.production).toBe("0.1635 EUR/kWh");
  });

  it("reports why nothing was found instead of an empty summary", () => {
    const summary = summarizePrices(readPricesFrom(configured, undefined));

    expect(summary.ok).toBe(false);
    expect(summary.detail).toMatch(/could not be reached/);
  });
});
