/**
 * Dynamic energy prices: what the settings form edits, what a forecast is, and
 * how a Home Assistant price entity's attributes become one.
 *
 * Pure, so the settings UI can share the types, the validation and the formula
 * preview with the server that stores the result. Reading and writing live in
 * `prices.server.ts`, and turning a read entity into a priced forecast lives in
 * `price-source.server.ts`.
 *
 * The exchange price is an input to a contract, not the number on a bill: a
 * dynamic tariff is `(spot x slope + markup) x VAT + charges` for consumption
 * and a *different* formula for injection. So a slot stores what the market
 * said and nothing else, and both retail legs are derived from it on the way
 * out — see `applyPrices` below for why that happens at read time.
 */

import { evaluateFormula, type Formula, parseFormula } from "./price-formula";

/**
 * Where prices come from.
 *
 * A string enum with one real member rather than a boolean, for the same reason
 * `StrategyId` is one: adding a built-in energy-charts or ENTSO-E client later
 * should be one more entry here and one more branch in
 * `price-source.server.ts`, with nothing already on disk needing to change.
 */
export type PriceSourceKind = "none" | "home-assistant";

export const PRICE_SOURCES: Array<{
  id: PriceSourceKind;
  label: string;
  description: string;
}> = [
  {
    id: "none",
    label: "Not configured",
    description: "No prices are imported.",
  },
  {
    id: "home-assistant",
    label: "Home Assistant entity",
    description:
      "Read the day-ahead prices off a sensor an integration already publishes — Energi Data Service, EPEX Spot, Nord Pool and friends. Nothing extra to install, and no API token to manage.",
  },
];

export type PriceConfig = {
  source: PriceSourceKind;
  /** `home-assistant` only: the sensor carrying the forecast. */
  forecastEntityId: string;
  /** Currency/kWh a kWh off the grid costs, as a formula over `price`. */
  consumptionFormula: string;
  /** Currency/kWh a kWh onto the grid earns, as a formula over `price`. */
  productionFormula: string;
};

/**
 * Both formulas default to the identity, which reports the raw market price.
 *
 * Honest rather than helpful: a default carrying some markup we guessed at
 * would be a wrong number presented as a right one, and the whole point of the
 * formula is that only the person holding the contract knows it.
 */
export const DEFAULT_PRICE_CONFIG: PriceConfig = {
  source: "none",
  forecastEntityId: "",
  consumptionFormula: "price",
  productionFormula: "price",
};

export function isPriceSourceKind(value: unknown): value is PriceSourceKind {
  return PRICE_SOURCES.some((source) => source.id === value);
}

export function normalizePriceConfig(
  stored: Partial<PriceConfig> | null,
): PriceConfig {
  return {
    source: isPriceSourceKind(stored?.source)
      ? stored.source
      : DEFAULT_PRICE_CONFIG.source,
    forecastEntityId: stored?.forecastEntityId?.trim() ?? "",
    // Left exactly as stored, including a formula that no longer parses. What
    // to do about that is `applyPrices`'s decision, and it is deliberately not
    // "quietly substitute the default" — see there.
    consumptionFormula:
      stored?.consumptionFormula?.trim() ||
      DEFAULT_PRICE_CONFIG.consumptionFormula,
    productionFormula:
      stored?.productionFormula?.trim() ||
      DEFAULT_PRICE_CONFIG.productionFormula,
  };
}

/** Whether prices can be read at all — a source picked, and something to read. */
export function isPriceConfigured(config: PriceConfig): boolean {
  return config.source === "home-assistant" && Boolean(config.forecastEntityId);
}

export type PriceErrors = Partial<Record<keyof PriceConfig, string>>;

export function parsePriceConfig(
  formData: FormData,
): { ok: true; config: PriceConfig } | { ok: false; errors: PriceErrors } {
  const source = formData.get("source")?.toString() ?? "";
  const forecastEntityId =
    formData.get("forecastEntityId")?.toString().trim() ?? "";
  const consumptionFormula =
    formData.get("consumptionFormula")?.toString().trim() ?? "";
  const productionFormula =
    formData.get("productionFormula")?.toString().trim() ?? "";

  if (!isPriceSourceKind(source)) {
    return { ok: false, errors: { source: "Pick where prices come from." } };
  }

  // Nothing else is required while no source is picked: the fields are hidden,
  // so validating them would reject a form the user cannot see to fix.
  if (source === "none") {
    return {
      ok: true,
      config: { ...DEFAULT_PRICE_CONFIG, source, forecastEntityId },
    };
  }

  const errors: PriceErrors = {};

  if (!forecastEntityId) {
    errors.forecastEntityId = "Pick the sensor carrying the day-ahead prices.";
  }

  // Validated here, before anything reaches disk, so that a formula which first
  // fails at 03:00 is impossible. The read path still has to cope with one that
  // no longer parses, because a hand-edited file never came through here.
  for (const [field, formula] of [
    ["consumptionFormula", consumptionFormula],
    ["productionFormula", productionFormula],
  ] as const) {
    const parsed = parseFormula(formula);
    if (!parsed.ok) errors[field] = parsed.error;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      source,
      forecastEntityId,
      consumptionFormula,
      productionFormula,
    },
  };
}

/**
 * One market interval.
 *
 * `start` and `end` are ISO instants in UTC, and they are carried explicitly
 * rather than derived from an index for two reasons that both bite. The
 * day-ahead auction has cleared in 15-minute intervals across the coupled
 * European bidding zones since 1 October 2025, but providers are still
 * migrating and some publish hourly, so the cadence is not a constant. And a
 * DST day has 92 or 100 quarter-hours rather than 96, which no arithmetic over
 * an hour-of-day index survives.
 */
export type PriceSlot = {
  start: string;
  end: string;
  /** What the market cleared at, in `currency` per kWh. No contract applied. */
  spotPerKwh: number;
};

/** Which attribute layout an entity turned out to be publishing. */
export type PriceAttributeShape = "raw_today" | "data";

export type PriceForecast = {
  /** ISO 4217, as the entity reports it. Assumed EUR when it doesn't. */
  currency: string;
  shape: PriceAttributeShape;
  /** Ordered by start, today first, tomorrow appended when it is valid. */
  slots: PriceSlot[];
  /** Whether the entity said tomorrow's prices had been published yet. */
  tomorrowIncluded: boolean;
  /** Display-only provenance, shown so a picked entity can be recognised. */
  region: string | null;
  attribution: string | null;
};

/**
 * A slot with the contract applied — what a person or a strategy actually wants.
 *
 * Both legs are nullable because a stored formula can fail to produce a number
 * (a division by zero, or a hand-edited file whose formula no longer parses),
 * and reporting the raw spot instead would be a wrong number wearing a right
 * one's label.
 */
export type PricePoint = {
  slot: PriceSlot;
  spotPerKwh: number;
  consumptionPerKwh: number | null;
  productionPerKwh: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * An entry's instant, in epoch milliseconds, or null when it isn't one.
 *
 * The timestamps these entities publish carry an offset — `2026-08-18T00:00:00+02:00`
 * — which is what makes them unambiguous. It is also what makes the October DST
 * day work: it has 100 quarter-hours, and `02:00+02:00` and `02:00+01:00` are
 * different instants an hour apart. Parsing them as local wall-clock times
 * would collapse the two into one and silently lose an hour of prices.
 */
function toInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

type RawPoint = { startMs: number; endMs: number | null; price: number };

/**
 * `[{ hour, price }]` — Energi Data Service, and the older custom Nordpool
 * component.
 *
 * **The key is called `hour` and the cadence is fifteen minutes.** A Belgian
 * entity publishes `00:00`, `00:15`, `00:30`, `00:45` under that name. The
 * field name is a leftover from when the day-ahead market was hourly; nothing
 * here may believe it, which is why the interval is measured from the data in
 * `deriveEnds` rather than assumed anywhere.
 */
function readHourPoints(entries: unknown[]): RawPoint[] {
  const points: RawPoint[] = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;

    const startMs = toInstant(record.hour ?? record.start ?? record.start_time);
    const price = toFiniteNumber(record.price);
    if (startMs === null || price === null) continue;

    points.push({ startMs, endMs: null, price });
  }

  return points;
}

/**
 * `[{ start_time, end_time, price_per_kwh }]` — the EPEX Spot integration.
 *
 * The one shape that states its own end, so nothing has to be derived for it.
 */
function readDataPoints(entries: unknown[]): RawPoint[] {
  const points: RawPoint[] = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;

    const startMs = toInstant(record.start_time);
    const price = toFiniteNumber(record.price_per_kwh ?? record.price);
    if (startMs === null || price === null) continue;

    points.push({ startMs, endMs: toInstant(record.end_time), price });
  }

  return points;
}

/**
 * The typical gap between consecutive starts, in milliseconds.
 *
 * The median rather than the first gap or the mean: a DST day contains one gap
 * that is an hour longer or shorter than the rest, and a series that spans a
 * provider's switch from hourly to quarter-hourly contains both cadences at
 * once. The median is the one summary that neither of those drags off the
 * actual interval.
 */
function medianInterval(points: RawPoint[]): number {
  const gaps = points
    .slice(1)
    .map((point, index) => point.startMs - points[index].startMs)
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b);

  if (gaps.length === 0) return 60 * 60 * 1000;
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * The longest a single slot may run.
 *
 * No coupled European day-ahead market publishes a product longer than an hour
 * — 15 minutes across SDAC since October 2025, 30 in Ireland, 60 in the zones
 * still to migrate — so a gap wider than this is missing data rather than a
 * long slot. That distinction is what this constant exists to draw; see
 * `deriveEnds`.
 */
const MAX_SLOT_MS = 60 * 60 * 1000;

/**
 * Give every point an end.
 *
 * A slot ends where the next one begins. Only the last has nothing to lean on,
 * and it gets one median interval — the honest guess, and the one place the
 * cadence is inferred rather than observed. A shape that states its own
 * `end_time` keeps it.
 *
 * **Capped at an hour, which is what stops a hole in the series becoming a
 * price.** A provider that publishes nothing between 03:00 and 22:00 would
 * otherwise leave a nineteen-hour slot holding the 03:00 price, and every read
 * through the afternoon would answer confidently with a number nobody
 * published. Capping leaves the gap a gap, and `slotAt` returns null inside it
 * — which is the difference between "we don't know" and a stale number
 * presented as current.
 *
 * The cap is also what makes a mixed-cadence series work, which is not
 * hypothetical: Home Assistant's Nord Pool integration warns that it publishes
 * hourly and quarter-hourly entries side by side while its markets migrate. An
 * hourly slot in a mostly-quarter-hourly series ends exactly where the next one
 * starts, because that gap is at the cap rather than past it.
 */
function deriveEnds(points: RawPoint[]): PriceSlot[] {
  const interval = medianInterval(points);

  return points.map((point, index) => {
    const next = points[index + 1];
    const endMs = point.endMs ?? next?.startMs ?? point.startMs + interval;

    return {
      start: new Date(point.startMs).toISOString(),
      end: new Date(Math.min(endMs, point.startMs + MAX_SLOT_MS)).toISOString(),
      spotPerKwh: point.price,
    };
  });
}

export type ForecastParseResult =
  | { ok: true; forecast: PriceForecast }
  | { ok: false; error: string };

/**
 * Turn a price entity's attributes into a forecast.
 *
 * Takes the attributes rather than the whole state so that this module stays
 * free of anything server-only, and because the state itself is not used: the
 * current price is derived from whichever slot contains the current instant, so
 * that the number shown and the series it came from cannot disagree.
 *
 * Detection is by **shape, not by integration name**. `raw_today` covers Energi
 * Data Service and the older custom Nordpool component; `data` covers EPEX
 * Spot. Naming integrations would mean a new branch for every fork of one.
 */
export function parsePriceForecast(
  attributes: Record<string, unknown> | undefined,
): ForecastParseResult {
  if (!attributes) {
    return {
      ok: false,
      error:
        "That entity publishes no attributes, so there are no prices on it to read.",
    };
  }

  const shape: PriceAttributeShape | null = Array.isArray(attributes.raw_today)
    ? "raw_today"
    : Array.isArray(attributes.data)
      ? "data"
      : null;

  if (!shape) {
    return {
      ok: false,
      error:
        "That entity carries no price series. Expected a `raw_today` attribute (Energi Data Service, Nordpool) or a `data` attribute (EPEX Spot).",
    };
  }

  // Populated whether or not it means anything, so the flag is what decides.
  // Trusting it ungated means planning tonight against yesterday's shape.
  const tomorrowValid = attributes.tomorrow_valid === true;
  const tomorrow =
    shape === "raw_today" &&
    tomorrowValid &&
    Array.isArray(attributes.raw_tomorrow)
      ? attributes.raw_tomorrow
      : [];

  const read = shape === "raw_today" ? readHourPoints : readDataPoints;
  const points = [
    ...read(attributes[shape] as unknown[]),
    ...read(tomorrow),
  ].sort((a, b) => a.startMs - b.startMs);

  if (points.length === 0) {
    return {
      ok: false,
      error: `That entity's \`${shape}\` attribute holds no readable price entries.`,
    };
  }

  // A factor-100 error waiting to happen: the same integration publishes
  // cents when this is set, with everything else about the payload identical.
  const scale = attributes.use_cent === true ? 0.01 : 1;
  const slots = deriveEnds(points).map((slot) => ({
    ...slot,
    spotPerKwh: slot.spotPerKwh * scale,
  }));

  return {
    ok: true,
    forecast: {
      currency:
        typeof attributes.currency === "string" ? attributes.currency : "EUR",
      shape,
      slots,
      tomorrowIncluded: tomorrow.length > 0,
      region: typeof attributes.region === "string" ? attributes.region : null,
      attribution:
        typeof attributes.attribution === "string"
          ? attributes.attribution
          : null,
    },
  };
}

/** The slot covering `atMs`, or null when the forecast doesn't reach it. */
export function slotAt(
  forecast: PriceForecast,
  atMs: number,
): PriceSlot | null {
  return (
    forecast.slots.find(
      (slot) => Date.parse(slot.start) <= atMs && atMs < Date.parse(slot.end),
    ) ?? null
  );
}

/** When the forecast runs out — the end of its last slot, or null if empty. */
export function forecastEnd(forecast: PriceForecast): string | null {
  return forecast.slots.at(-1)?.end ?? null;
}

/**
 * Apply the contract to one slot.
 *
 * At read time rather than at import time, and that is a deliberate reversal of
 * the obvious design. Deriving the two legs once and storing them beside the
 * spot would leave every stored slot stale the moment a formula is edited on
 * the settings page, in exchange for saving arithmetic over a couple of hundred
 * numbers. So what is stored is what the market said, and the contract is
 * applied on the way out — which makes editing a formula take effect on the
 * next render, as anyone would expect a settings field to.
 */
export function priceSlot(
  slot: PriceSlot,
  formulas: { consumption: Formula | null; production: Formula | null },
): PricePoint {
  return {
    slot,
    spotPerKwh: slot.spotPerKwh,
    consumptionPerKwh: formulas.consumption
      ? evaluateFormula(formulas.consumption, slot.spotPerKwh)
      : null,
    productionPerKwh: formulas.production
      ? evaluateFormula(formulas.production, slot.spotPerKwh)
      : null,
  };
}

/**
 * What the settings page shows back after an entity is picked: proof that the
 * right sensor was chosen, before anything depends on it.
 *
 * Here rather than beside the function that builds it, for the reason a JSON
 * endpoint's response type lives in `lib/` rather than in its route: both ends
 * need it, and a component may not import from a `.server` module.
 */
export type PriceSourceSummary = {
  ok: boolean;
  /** One line describing what was found, or why nothing was. */
  detail: string;
  /** The current slot's prices, formatted, so the formulas can be checked. */
  spot: string | null;
  consumption: string | null;
  production: string | null;
  /**
   * The same spot price as a number, so the form can re-evaluate a formula as
   * it is typed without a round trip. The browser runs the identical evaluator
   * the server will, which is what makes the preview a promise rather than an
   * illustration.
   */
  spotPerKwh: number | null;
  currency: string;
};

export type PriceFormulas = {
  consumption: Formula | null;
  production: Formula | null;
  /** Why a leg is null, ready to show — one message per broken formula. */
  errors: PriceErrors;
};

/**
 * Parse both formulas out of a stored config.
 *
 * A formula that no longer parses leaves its leg null and its reason in
 * `errors`, and does **not** fall back to the identity. Reporting the raw
 * exchange price under the label "consumption" would be a plausible-looking
 * number that is wrong by the whole of the grid fees and VAT — precisely the
 * failure that is hardest to notice and most expensive to act on.
 */
export function parsePriceFormulas(config: PriceConfig): PriceFormulas {
  const consumption = parseFormula(config.consumptionFormula);
  const production = parseFormula(config.productionFormula);
  const errors: PriceErrors = {};

  if (!consumption.ok) errors.consumptionFormula = consumption.error;
  if (!production.ok) errors.productionFormula = production.error;

  return {
    consumption: consumption.ok ? consumption.formula : null,
    production: production.ok ? production.formula : null,
    errors,
  };
}
