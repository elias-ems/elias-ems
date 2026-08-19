/**
 * Turning prices and slot boundaries into the strings a page shows.
 *
 * Server-side, for the reason `readings.server.ts` gives about readings: a slot
 * boundary rendered during hydration would be formatted in the *browser's*
 * timezone, and the server's is the one that matches Home Assistant. Supervisor
 * gives an add-on container Home Assistant's own timezone, which is why local
 * time here is the right local time without asking anyone.
 *
 * The shapes themselves are locale-independent — `toFixed` and a sliced
 * `toTimeString`, the same choice `net-zero.ts` and `diagnostics.server.ts`
 * made — so what a person reads doesn't depend on which machine rendered it.
 */

/**
 * Four decimals, because two is not enough.
 *
 * A quarter-hour price moves in tenths of a cent, and `0.18` for three
 * different slots reads as a broken feed rather than as rounding. Four is also
 * what the entities themselves publish.
 */
const PRICE_DECIMALS = 4;

/**
 * `0.3317 EUR/kWh`, or a dash when there is no number.
 *
 * Per kWh rather than per MWh or in cents, matching both the unit the formulas
 * are written in and the `unit_of_measurement` the source entity carries. One
 * unit end to end is what keeps a formula ported from evcc — or read off a
 * contract — from being wrong by a factor of a hundred or a thousand.
 */
export function formatPricePerKwh(
  value: number | null,
  currency: string,
): string {
  if (value === null) return "—";
  return `${value.toFixed(PRICE_DECIMALS)} ${currency}/kWh`;
}

/** Local `HH:MM`, the same stable shape `diagnostics.server.ts` uses. */
function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "?" : at.toTimeString().slice(0, 5);
}

/** Local `D MMM`, for a span that crosses midnight into tomorrow's prices. */
function day(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "?";
  return at.toDateString().slice(4, 10);
}

/** `22:45–23:00` — one slot, which never crosses a day boundary. */
export function formatSlotClock(startIso: string, endIso: string): string {
  return `${clock(startIso)}–${clock(endIso)}`;
}

/**
 * `Aug 18 00:00 → Aug 19 00:00` — how far a whole forecast reaches.
 *
 * Carries the date because the entire point of the string is to show whether
 * tomorrow arrived, which a pair of times alone cannot say.
 */
export function formatSlotRange(startIso: string, endIso: string): string {
  return `${day(startIso)} ${clock(startIso)} → ${day(endIso)} ${clock(endIso)}`;
}
