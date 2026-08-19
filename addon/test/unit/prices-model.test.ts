/**
 * The prices model: config validation, and turning a Home Assistant price
 * entity's attributes into a forecast.
 *
 * The attribute payloads here are a real capture from an Energi Data Service
 * EPEX Spot entity for the Belgian bidding zone — the scalar attributes in
 * full, and the head and tail of the series it published, exactly as read off
 * the entity. The longer synthetic series further down are for the cases a
 * single day's capture cannot show: a provider still on hourly, and the two
 * days a year that aren't 96 quarter-hours long.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_CONFIG,
  forecastEnd,
  isPriceConfigured,
  normalizePriceConfig,
  type PriceForecast,
  parsePriceConfig,
  parsePriceForecast,
  parsePriceFormulas,
  priceSlot,
  slotAt,
} from "../../app/lib/prices";

/**
 * The observed head of `raw_today`, 00:00 through 06:15 on 2026-08-18, and its
 * tail from 22:00 to the end of the day. The key really is called `hour` and
 * the entries really are fifteen minutes apart — that pairing is the single
 * most load-bearing fact in this file.
 */
const RAW_TODAY = [
  { hour: "2026-08-18T00:00:00+02:00", price: 0.1879 },
  { hour: "2026-08-18T00:15:00+02:00", price: 0.18 },
  { hour: "2026-08-18T00:30:00+02:00", price: 0.1678 },
  { hour: "2026-08-18T00:45:00+02:00", price: 0.1586 },
  { hour: "2026-08-18T01:00:00+02:00", price: 0.1671 },
  { hour: "2026-08-18T01:15:00+02:00", price: 0.1619 },
  { hour: "2026-08-18T01:30:00+02:00", price: 0.16 },
  { hour: "2026-08-18T01:45:00+02:00", price: 0.1501 },
  { hour: "2026-08-18T02:00:00+02:00", price: 0.1526 },
  { hour: "2026-08-18T02:15:00+02:00", price: 0.1501 },
  { hour: "2026-08-18T02:30:00+02:00", price: 0.1497 },
  { hour: "2026-08-18T02:45:00+02:00", price: 0.1509 },
  { hour: "2026-08-18T22:00:00+02:00", price: 0.2002 },
  { hour: "2026-08-18T22:15:00+02:00", price: 0.195 },
  { hour: "2026-08-18T22:30:00+02:00", price: 0.1883 },
  { hour: "2026-08-18T22:45:00+02:00", price: 0.1821 },
  { hour: "2026-08-18T23:00:00+02:00", price: 0.1915 },
  { hour: "2026-08-18T23:15:00+02:00", price: 0.1779 },
  { hour: "2026-08-18T23:30:00+02:00", price: 0.1742 },
  { hour: "2026-08-18T23:45:00+02:00", price: 0.1649 },
];

const RAW_TOMORROW = [
  { hour: "2026-08-19T00:00:00+02:00", price: 0.192 },
  { hour: "2026-08-19T00:15:00+02:00", price: 0.1791 },
  { hour: "2026-08-19T00:30:00+02:00", price: 0.1744 },
  { hour: "2026-08-19T00:45:00+02:00", price: 0.1609 },
  { hour: "2026-08-19T01:00:00+02:00", price: 0.1635 },
];

/** Every scalar attribute the entity carried, verbatim. */
const ENERGI_ATTRIBUTES: Record<string, unknown> = {
  current_price: 0.18,
  unit: "kWh",
  currency: "EUR",
  region: "Belgium",
  region_code: "BE",
  tomorrow_valid: true,
  next_data_update: "13:39:27",
  raw_today: RAW_TODAY,
  raw_tomorrow: RAW_TOMORROW,
  today_min: { hour: "2026-08-18T13:45:00+02:00", price: 0.1293 },
  today_max: { hour: "2026-08-18T21:15:00+02:00", price: 0.2088 },
  today_mean: 0.16,
  use_cent: false,
  state_class: "Total",
  attribution: "Data sourced from Nord Pool",
  unit_of_measurement: "EUR/kWh",
  device_class: "monetary",
  friendly_name: "Energi Epex Spot Epex Spot",
};

function parsed(attributes: Record<string, unknown>): PriceForecast {
  const result = parsePriceForecast(attributes);
  if (!result.ok) throw new Error(result.error);
  return result.forecast;
}

/** `count` slots of `intervalMinutes`, starting at `startIso`. */
function series(
  startIso: string,
  count: number,
  intervalMinutes: number,
): Array<{ hour: string; price: number }> {
  const startMs = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => ({
    hour: new Date(startMs + index * intervalMinutes * 60_000).toISOString(),
    price: 0.1 + index / 10_000,
  }));
}

describe("reading a Home Assistant price entity", () => {
  it("reads the captured Energi Data Service entity", () => {
    const forecast = parsed(ENERGI_ATTRIBUTES);

    expect(forecast.shape).toBe("raw_today");
    expect(forecast.currency).toBe("EUR");
    expect(forecast.region).toBe("Belgium");
    expect(forecast.attribution).toBe("Data sourced from Nord Pool");
    expect(forecast.tomorrowIncluded).toBe(true);
    expect(forecast.slots).toHaveLength(RAW_TODAY.length + RAW_TOMORROW.length);
  });

  it("keeps the prices as published, in currency per kWh", () => {
    // 0.1821 EUR/kWh is 182.1 EUR/MWh — the unit the raw APIs publish and the
    // one a formula must never see, since evcc-style formulas are per kWh.
    const forecast = parsed(ENERGI_ATTRIBUTES);
    const slot = slotAt(forecast, Date.parse("2026-08-18T22:50:00+02:00"));

    expect(slot?.spotPerKwh).toBe(0.1821);
  });

  it("derives each slot's end from the next slot's start", () => {
    // The attribute states no end at all. Fifteen minutes here, and the value
    // is measured from the series rather than assumed.
    const forecast = parsed(ENERGI_ATTRIBUTES);

    expect(forecast.slots[0]).toEqual({
      start: "2026-08-17T22:00:00.000Z",
      end: "2026-08-17T22:15:00.000Z",
      spotPerKwh: 0.1879,
    });
  });

  it("gives the very last slot one interval, since nothing follows it", () => {
    const forecast = parsed(ENERGI_ATTRIBUTES);
    const last = forecast.slots.at(-1);

    expect(last?.start).toBe("2026-08-18T23:00:00.000Z");
    expect(last?.end).toBe("2026-08-18T23:15:00.000Z");
    expect(forecastEnd(forecast)).toBe("2026-08-18T23:15:00.000Z");
  });

  it("appends tomorrow, in order, after today", () => {
    const forecast = parsed(ENERGI_ATTRIBUTES);
    const starts = forecast.slots.map((slot) => slot.start);

    expect([...starts].sort()).toEqual(starts);
    expect(starts.at(-RAW_TOMORROW.length)).toBe("2026-08-18T22:00:00.000Z");
  });
});

describe("the traps in that payload", () => {
  it("does not believe the `hour` key, which holds quarter hours", () => {
    const forecast = parsed(ENERGI_ATTRIBUTES);
    const [first, second] = forecast.slots;

    expect(Date.parse(second.start) - Date.parse(first.start)).toBe(
      15 * 60_000,
    );
  });

  it("honours tomorrow_valid: false and drops raw_tomorrow entirely", () => {
    // Energi populates raw_tomorrow whether or not it means anything. Reading
    // it ungated means planning tonight against yesterday's shape.
    const forecast = parsed({
      ...ENERGI_ATTRIBUTES,
      tomorrow_valid: false,
    });

    expect(forecast.tomorrowIncluded).toBe(false);
    expect(forecast.slots).toHaveLength(RAW_TODAY.length);
  });

  it("scales cents to the major unit when use_cent is set", () => {
    // Same payload, same shape, values a hundred times bigger. Missing this is
    // a 100x error in a number a battery would act on.
    const forecast = parsed({
      ...ENERGI_ATTRIBUTES,
      use_cent: true,
      raw_today: RAW_TODAY.map((entry) => ({
        ...entry,
        price: entry.price * 100,
      })),
      raw_tomorrow: [],
    });

    expect(forecast.slots[0].spotPerKwh).toBeCloseTo(0.1879, 10);
  });

  it("ignores the entity's own state and derived min/max attributes", () => {
    // `current_price` is 0.18 while the slot covering that instant is 0.1821.
    // Deriving from the series is what stops the two disagreeing.
    const forecast = parsed(ENERGI_ATTRIBUTES);
    const slot = slotAt(forecast, Date.parse("2026-08-18T22:45:30+02:00"));

    expect(slot?.spotPerKwh).toBe(0.1821);
    expect(slot?.spotPerKwh).not.toBe(ENERGI_ATTRIBUTES.current_price);
  });
});

describe("other providers' shapes", () => {
  it("reads the EPEX Spot `data` shape, which states its own ends", () => {
    const forecast = parsed({
      currency: "EUR",
      data: [
        {
          start_time: "2026-08-18T00:00:00+02:00",
          end_time: "2026-08-18T01:00:00+02:00",
          price_per_kwh: 0.1879,
        },
        {
          start_time: "2026-08-18T01:00:00+02:00",
          end_time: "2026-08-18T02:00:00+02:00",
          price_per_kwh: 0.1671,
        },
      ],
    });

    expect(forecast.shape).toBe("data");
    expect(forecast.slots[1]).toEqual({
      start: "2026-08-17T23:00:00.000Z",
      end: "2026-08-18T00:00:00.000Z",
      spotPerKwh: 0.1671,
    });
  });

  it("reads an hourly provider without being told the cadence", () => {
    const forecast = parsed({
      raw_today: series("2026-08-18T00:00:00Z", 24, 60),
    });

    expect(forecast.slots).toHaveLength(24);
    expect(forecast.slots.at(-1)?.end).toBe("2026-08-19T00:00:00.000Z");
  });
});

describe("the days that are not 96 quarter hours long", () => {
  it("keeps all 100 slots when the clocks go back", () => {
    // 25 October 2026: 02:00+02:00 and 02:00+01:00 are an hour apart. Parsing
    // as wall-clock time would fold them together and lose an hour of prices.
    const autumn = [
      ...series("2026-10-24T22:00:00Z", 16, 15),
      ...series("2026-10-25T02:00:00Z", 84, 15),
    ];
    const forecast = parsed({ raw_today: autumn });

    expect(forecast.slots).toHaveLength(100);
    expect(new Set(forecast.slots.map((slot) => slot.start)).size).toBe(100);
  });

  it("keeps all 92 slots when the clocks go forward", () => {
    // 29 March 2026: the local day is 23 hours long, so there is simply one
    // fewer hour of prices. Nothing should invent the missing four.
    const spring = series("2026-03-28T23:00:00Z", 92, 15);
    const forecast = parsed({ raw_today: spring });

    expect(forecast.slots).toHaveLength(92);
    expect(forecast.slots.at(-1)?.end).toBe("2026-03-29T22:00:00.000Z");
  });

  it("measures the interval with a median, so one odd gap can't skew it", () => {
    // A series with an hour-long hole in the middle still ends its last slot
    // fifteen minutes after it starts, rather than 75.
    const withHole = [
      ...series("2026-08-18T00:00:00Z", 8, 15),
      ...series("2026-08-18T03:00:00Z", 8, 15),
    ];
    const forecast = parsed({ raw_today: withHole });

    expect(forecast.slots.at(-1)?.start).toBe("2026-08-18T04:45:00.000Z");
    expect(forecast.slots.at(-1)?.end).toBe("2026-08-18T05:00:00.000Z");
  });

  it("leaves a hole in the series a hole, rather than one long slot", () => {
    // The slot before the gap must not stretch across it: every read through
    // those hours would otherwise answer with a price nobody published.
    const withHole = [
      ...series("2026-08-18T00:00:00Z", 8, 15),
      ...series("2026-08-18T03:00:00Z", 8, 15),
    ];
    const forecast = parsed({ raw_today: withHole });
    const lastBeforeGap = forecast.slots[7];

    expect(lastBeforeGap.start).toBe("2026-08-18T01:45:00.000Z");
    expect(lastBeforeGap.end).toBe("2026-08-18T02:45:00.000Z");
    expect(slotAt(forecast, Date.parse("2026-08-18T02:50:00Z"))).toBeNull();
  });

  it("lets an hourly slot inside a quarter-hourly series keep its hour", () => {
    // Home Assistant's Nord Pool integration publishes both cadences side by
    // side while its markets migrate, so this is a real payload rather than a
    // hypothetical one. The hour-long cap is exactly what accommodates it.
    const mixed = [
      { hour: "2026-08-18T00:00:00Z", price: 0.1 },
      ...series("2026-08-18T01:00:00Z", 8, 15),
    ];
    const forecast = parsed({ raw_today: mixed });

    expect(forecast.slots[0]).toEqual({
      start: "2026-08-18T00:00:00.000Z",
      end: "2026-08-18T01:00:00.000Z",
      spotPerKwh: 0.1,
    });
  });
});

describe("slotAt", () => {
  const forecast = parsed(ENERGI_ATTRIBUTES);

  it("includes its own start and excludes its own end", () => {
    // The boundary belongs to exactly one slot, or a price flickers between two
    // at every quarter hour.
    expect(
      slotAt(forecast, Date.parse("2026-08-18T00:15:00+02:00"))?.spotPerKwh,
    ).toBe(0.18);
    expect(
      slotAt(forecast, Date.parse("2026-08-18T00:14:59.999+02:00"))?.spotPerKwh,
    ).toBe(0.1879);
  });

  it("returns null outside the forecast", () => {
    expect(slotAt(forecast, Date.parse("2026-08-17T12:00:00Z"))).toBeNull();
    expect(slotAt(forecast, Date.parse("2026-08-25T12:00:00Z"))).toBeNull();
  });

  it("returns null inside a gap the provider left", () => {
    // The captured series jumps from 02:45 to 22:00. Nothing should stretch a
    // slot across that, because we do not know what the price was.
    expect(
      slotAt(forecast, Date.parse("2026-08-18T12:00:00+02:00")),
    ).toBeNull();
  });
});

describe("rejecting what isn't a forecast", () => {
  it("rejects an entity with no attributes at all", () => {
    expect(parsePriceForecast(undefined)).toMatchObject({ ok: false });
  });

  it("names both shapes it knows when it recognises neither", () => {
    const result = parsePriceForecast({ friendly_name: "Kitchen temperature" });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/raw_today.*data/s);
  });

  it("rejects a series whose entries are all unreadable", () => {
    expect(
      parsePriceForecast({ raw_today: [{ hour: "not a date", price: "x" }] }),
    ).toMatchObject({ ok: false });
  });

  it("skips unreadable entries but keeps the rest", () => {
    const forecast = parsed({
      raw_today: [
        { hour: "2026-08-18T00:00:00+02:00", price: 0.1 },
        { hour: "2026-08-18T00:15:00+02:00", price: null },
        { hour: "2026-08-18T00:30:00+02:00", price: 0.3 },
      ],
    });

    expect(forecast.slots.map((slot) => slot.spotPerKwh)).toEqual([0.1, 0.3]);
  });
});

describe("applying the contract", () => {
  const config = {
    ...DEFAULT_PRICE_CONFIG,
    source: "home-assistant" as const,
    forecastEntityId: "sensor.energi_epex_spot",
    consumptionFormula: "((price * 1.02) + 0.1272) * 1.06",
    productionFormula: "max(price * 0.98 - 0.015, 0)",
  };

  it("derives both legs from the same spot price", () => {
    const forecast = parsed(ENERGI_ATTRIBUTES);
    const slot = slotAt(forecast, Date.parse("2026-08-18T22:50:00+02:00"));
    if (!slot) throw new Error("expected a slot");

    const point = priceSlot(slot, parsePriceFormulas(config));

    expect(point.spotPerKwh).toBe(0.1821);
    expect(point.consumptionPerKwh).toBeCloseTo(0.331719, 6);
    expect(point.productionPerKwh).toBeCloseTo(0.163458, 6);
  });

  it("keeps a negative spot from becoming a negative consumption price", () => {
    // The whole reason the two legs are separate. Grid fees and VAT mean a
    // household still pays to import at -0.05/kWh, while the export leg floors
    // at zero — which is what PV curtailment will eventually key off.
    const point = priceSlot(
      { start: "x", end: "y", spotPerKwh: -0.05 },
      parsePriceFormulas(config),
    );

    expect(point.consumptionPerKwh).toBeGreaterThan(0);
    expect(point.productionPerKwh).toBe(0);
  });

  it("leaves a leg null when its formula no longer parses", () => {
    // A hand-edited file never went through the settings action. Falling back
    // to the raw spot would report an exchange price as a retail one.
    const formulas = parsePriceFormulas({
      ...config,
      consumptionFormula: "price * ",
    });
    const point = priceSlot(
      { start: "x", end: "y", spotPerKwh: 0.2 },
      formulas,
    );

    expect(point.consumptionPerKwh).toBeNull();
    expect(point.productionPerKwh).not.toBeNull();
    expect(formulas.errors.consumptionFormula).toBeTruthy();
  });
});

describe("the stored configuration", () => {
  function form(fields: Record<string, string>): FormData {
    const formData = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      formData.append(name, value);
    }
    return formData;
  }

  const validForm = {
    source: "home-assistant",
    forecastEntityId: "sensor.energi_epex_spot",
    consumptionFormula: "((price * 1.02) + 0.1272) * 1.06",
    productionFormula: "price * 0.98 - 0.015",
  };

  it("accepts a complete form", () => {
    const result = parsePriceConfig(form(validForm));

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.config).toEqual(validForm);
  });

  it("requires an entity when the source is Home Assistant", () => {
    const result = parsePriceConfig(
      form({ ...validForm, forecastEntityId: "" }),
    );

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors.forecastEntityId).toBeTruthy();
  });

  it("rejects a formula that doesn't parse, before it reaches disk", () => {
    const result = parsePriceConfig(
      form({ ...validForm, productionFormula: "price * spot" }),
    );

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors.productionFormula).toMatch(/spot/);
  });

  it("asks for nothing else when the source is none", () => {
    // The other fields are hidden in that state, so validating them would
    // reject a form nobody can see to fix.
    const result = parsePriceConfig(
      form({ source: "none", forecastEntityId: "", consumptionFormula: "" }),
    );

    expect(result).toMatchObject({ ok: true });
  });

  it("normalizes an absent file to an unconfigured source", () => {
    expect(normalizePriceConfig(null)).toEqual(DEFAULT_PRICE_CONFIG);
    expect(isPriceConfigured(DEFAULT_PRICE_CONFIG)).toBe(false);
  });

  it("falls back to the identity formula for a record written without one", () => {
    const config = normalizePriceConfig({
      source: "home-assistant",
      forecastEntityId: "sensor.prices",
    });

    expect(config.consumptionFormula).toBe("price");
    expect(config.productionFormula).toBe("price");
    expect(isPriceConfigured(config)).toBe(true);
  });

  it("keeps a stored formula that no longer parses rather than replacing it", () => {
    // Substituting the default here would hide the problem and report the raw
    // spot as a retail price. It is kept, and `parsePriceFormulas` reports it.
    const config = normalizePriceConfig({
      source: "home-assistant",
      forecastEntityId: "sensor.prices",
      consumptionFormula: "price * ",
    });

    expect(config.consumptionFormula).toBe("price *");
    expect(parsePriceFormulas(config).errors.consumptionFormula).toBeTruthy();
  });

  it("treats an unknown stored source as unconfigured", () => {
    expect(normalizePriceConfig({ source: "entsoe" as never }).source).toBe(
      "none",
    );
  });
});
