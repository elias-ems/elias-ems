/**
 * Reading entity states, from whichever source can answer.
 *
 * Both things that need live values go through here — the dashboard and the
 * control loop — so that "where did this number come from, and how old is it"
 * has one answer rather than one per caller. The live subscription answers from
 * memory when it is connected; REST is the fallback for the moment before the
 * socket comes up, and for every run outside Home Assistant.
 */

import { fetchHaState, type HaState } from "./ha.server";
import { liveStates } from "./ha-live.server";

export type StateSource = "live" | "rest";

export type StateRead = {
  /** Null when Home Assistant has no such entity — the id may have gone stale. */
  state: HaState | null;
  /**
   * When this value last changed, in epoch milliseconds, or null when the state
   * carries no timestamp.
   *
   * Taken from the state's own `last_updated` rather than from the moment we
   * read it, including on the REST path: a value fetched a millisecond ago can
   * still be an hour old, and reporting the read time as the value's age would
   * be exactly the reassuring lie this exists to prevent.
   */
  updatedAt: number | null;
  source: StateSource;
};

function updatedAt(state: HaState | null): number | null {
  const stamp = state?.last_updated ?? state?.last_changed;
  if (!stamp) return null;

  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The states for `ids`, deduplicated — the same sensor can legitimately be
 * configured in two places.
 *
 * A Home Assistant that can't be reached is reported once, for the whole read,
 * rather than turning into one failure per entity: the cause is the same for
 * all of them, and each caller has its own way of saying "no value".
 */
export async function readStates(ids: string[]): Promise<{
  states: Map<string, StateRead>;
  error: string | null;
}> {
  const unique = [...new Set(ids)];

  const live = liveStates(unique);
  if (live) {
    return {
      states: new Map(
        [...live].map(([id, state]) => [
          id,
          { state, updatedAt: updatedAt(state), source: "live" as const },
        ]),
      ),
      error: null,
    };
  }

  try {
    const entries = await Promise.all(
      unique.map(async (id) => {
        const state = await fetchHaState(id);
        return [
          id,
          { state, updatedAt: updatedAt(state), source: "rest" as const },
        ] as const;
      }),
    );
    return { states: new Map(entries), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { states: new Map(), error: message };
  }
}

/**
 * How old the oldest of these reads is, in seconds, and which source they came
 * from — the provenance a decision or a card is worth stamping with.
 *
 * Ages are advisory. A sensor that has genuinely stopped reporting and one that
 * has simply held the same value for an hour look identical from here, which is
 * why nothing branches on this; it is for the log and for the page, where a
 * person can tell the difference.
 */
export function readingAge(states: Map<string, StateRead>): {
  source: StateSource | null;
  oldestSeconds: number | null;
} {
  let oldest: number | null = null;
  let source: StateSource | null = null;

  for (const read of states.values()) {
    source ??= read.source;
    if (read.updatedAt === null) continue;
    // Clamped at zero: Home Assistant stamps these on its own clock, and a
    // container whose clock runs behind would otherwise report the future.
    const age = Math.max(0, Date.now() - read.updatedAt);
    oldest = oldest === null ? age : Math.max(oldest, age);
  }

  return {
    source,
    oldestSeconds: oldest === null ? null : Math.round(oldest / 1000),
  };
}
