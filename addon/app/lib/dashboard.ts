/**
 * What the dashboard renders, as types.
 *
 * Split from [dashboard.server.ts](dashboard.server.ts), which builds these,
 * for the reason [diagnostics.ts](diagnostics.ts) is split from its own server
 * half: the components that draw a reading need its shape, and a component may
 * not import a `.server` module. Both ends of the readings stream need this
 * contract and neither may reach into the other.
 *
 * Everything here is already formatted or already a number. Nothing in this
 * file depends on a locale, a timezone or a clock, which is what lets the
 * server render it once and the browser hydrate the same markup.
 */
import type { LiveHealth, Reading } from "./readings";

export type DashboardReadings = {
  arrays: DashboardArray[];
  grid: DashboardGrid;
  batteries: DashboardBattery[];
  prices: DashboardPrices;
  /** Why the readings are missing, when they are. Null when all is well. */
  error: string | null;
  /** How these readings reached us, and how well that path is working. */
  health: LiveHealth;
};

export type DashboardArray = {
  id: string;
  title: string;
  power: Reading | null;
  energy: Reading | null;
  /**
   * The numbers behind the strings above, for the parts of the page that draw
   * rather than print: a bar needs a fraction, and deriving one by parsing
   * `power.display` back out of a localised string would be a bug waiting for
   * the first thousands separator.
   */
  powerW: number | null;
  ratedPowerW: number | null;
  curtailable: boolean;
  /**
   * The limit this array is standing under, or null when nothing has been
   * published for it. Null and 100 are different states and the page says so:
   * 100 is "released", null is "never told".
   */
  limitPercent: number | null;
};

export type DashboardGrid = {
  configured: boolean;
  power: Reading | null;
  powerW: number | null;
};

export type DashboardBattery = {
  id: string;
  title: string;
  window: string;
  charge: Reading | null;
  power: Reading | null;
  energy: Reading | null;
  chargePercent: number | null;
  /** The target standing on the bus, which is not what this tick computed. */
  targetW: number | null;
};

/**
 * One hour of the day on the price chart.
 *
 * Hourly means rather than the 96 raw slots, and minutes-since-local-midnight
 * rather than a timestamp, for two reasons that both come down to what crosses
 * the wire. These readings are pushed on every state change, so the whole
 * quarter-hourly series would be a kilobyte of unchanged prices resent every
 * time an inverter twitched. And a plain minute offset is something the browser
 * can plot knowing nothing about timezones, which is the same reason every
 * other string on this page is built on the server.
 *
 * The *selling* leg, because that is the number curtailment's threshold is
 * compared against. A chart of the exchange price would put its zero crossing
 * in the wrong place by whatever the contract's injection fee is.
 */
export type PriceCurvePoint = {
  startMinutes: number;
  sellingPerKwh: number;
};

/**
 * The price card, formatted on the server like every other reading here.
 *
 * Strings rather than numbers for everything a person reads: what is shown
 * depends on the server's timezone and on a fixed number of decimals, and
 * deciding either during render risks the browser disagreeing with the markup
 * it is hydrating. The curve is the exception, and it is numbers because it is
 * drawn rather than read.
 */
export type DashboardPrices = {
  configured: boolean;
  /** What a kWh costs and earns right now, with the contract applied. */
  consumption: string | null;
  production: string | null;
  /** The exchange price the two were derived from, shown so they can be checked. */
  spot: string | null;
  /**
   * The selling leg again, as a number.
   *
   * So the page can ask the question it actually cares about — is this below
   * the curtailment threshold? — rather than whether the formatted string
   * happens to start with a minus. Those are the same question only for a
   * threshold of exactly zero, and the threshold is configurable precisely
   * because an injection fee puts break-even somewhere else.
   */
  productionPerKwh: number | null;
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
  /** Today's selling price hour by hour. Empty when there is nothing to draw. */
  curve: PriceCurvePoint[];
  /** Where the current slot starts on that curve, in minutes past local midnight. */
  nowMinutes: number | null;
  error: string | null;
};
