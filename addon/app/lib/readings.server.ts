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

/**
 * The boolean behind a state, or null when there isn't one.
 *
 * Deliberately narrow: `on` and `off` and nothing else. Home Assistant's own
 * `unavailable` and `unknown` fall through to null, as does a numeric or textual
 * state that happens to be truthy — a sensor that reads `charging` is not a
 * binary sensor, and quietly agreeing that it is would let a decision rest on a
 * string nobody checked.
 *
 * Null rather than false for the same reason `toNumber` returns null rather than
 * 0: a caller has to be able to tell "no car" from "we have no idea", and the
 * two do not lead to the same decision.
 */
export function toBoolean(state: HaState | null): boolean | null {
  if (!state) return null;
  if (state.state === "on") return true;
  if (state.state === "off") return false;
  return null;
}
