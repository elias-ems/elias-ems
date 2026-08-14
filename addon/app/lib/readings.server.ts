import type { EntityRange } from "./batteries";
import type { HaState } from "./ha.server";
import type { Reading } from "./readings";

/**
 * Formatted on the server rather than in the component: these strings are
 * locale-dependent, and formatting them during render would risk the server and
 * the browser disagreeing and tripping a hydration mismatch.
 */
export function toReading(
  state: HaState | null,
  updatedAt: number | null = null,
): Reading {
  if (!state) return { display: "no such entity", ok: false, updatedAt: null };
  if (state.state === "unavailable" || state.state === "unknown") {
    return { display: state.state, ok: false, updatedAt };
  }

  const value = Number(state.state);
  const shown = Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : state.state;
  const unit = state.attributes?.unit_of_measurement;

  return { display: unit ? `${shown} ${unit}` : shown, ok: true, updatedAt };
}

/**
 * The numeric value behind a state, or null when there isn't one — a missing
 * entity, `unavailable`, `unknown`, or anything else that won't parse.
 *
 * Null rather than 0 on purpose: the control loop has to be able to tell "the
 * grid is drawing nothing" from "we have no idea what the grid is doing", and
 * those lead to opposite decisions.
 */
export function toNumber(state: HaState | null): number | null {
  if (!state) return null;
  const value = Number(state.state);
  return Number.isFinite(value) ? value : null;
}

function attributeNumber(state: HaState, name: string): number | null {
  const value = Number(state.attributes?.[name]);
  // `Number(undefined)` is NaN, so a missing attribute falls out here — but
  // `Number(null)` is 0, and a range of 0 is a very different claim from one
  // that was never made.
  if (state.attributes?.[name] === null) return null;
  return Number.isFinite(value) ? value : null;
}

/**
 * The range a writable entity publishes about itself, or null when there is no
 * entity to ask.
 *
 * `number` entities always carry `min`/`max` — the platform requires them — and
 * `input_number` helpers do too, so this is nearly always populated. Each half
 * is still independently nullable: the entity may be some other domain
 * entirely, in which case saying so is better than inventing a bound.
 */
export function toRange(state: HaState | null): EntityRange | null {
  if (!state) return null;
  return {
    min: attributeNumber(state, "min"),
    max: attributeNumber(state, "max"),
  };
}
