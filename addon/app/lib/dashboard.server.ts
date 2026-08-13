/**
 * Everything the dashboard shows, built in one place.
 *
 * Two callers need exactly this: the home loader, which renders it, and the
 * readings stream, which pushes it whenever Home Assistant says something
 * moved. They have to agree down to the formatting — the stream's job is to
 * replace what the loader produced — so they share the function rather than the
 * intent.
 *
 * Readings are formatted here, on the server, for the reason `readings.server.ts`
 * gives: the strings are locale-dependent, and formatting them during render
 * would risk the server and the browser disagreeing.
 */
import type { Battery } from "./batteries";
import { listBatteries } from "./batteries.server";
import { type Grid, isGridConfigured } from "./grid";
import { readGrid } from "./grid.server";
import { fetchHaState, type HaState } from "./ha.server";
import { liveStates } from "./ha-live.server";
import type { PvEntity } from "./pv-entities";
import { listPvEntities } from "./pv-entities.server";
import type { Reading } from "./readings";
import { toReading } from "./readings.server";

export type DashboardReadings = {
  arrays: Array<{
    id: string;
    title: string;
    power: Reading | null;
    energy: Reading | null;
  }>;
  grid: {
    configured: boolean;
    power: Reading | null;
  };
  batteries: Array<{
    id: string;
    title: string;
    window: string;
    charge: Reading | null;
    power: Reading | null;
    energy: Reading | null;
  }>;
  /** Why the readings are missing, when they are. Null when all is well. */
  error: string | null;
};

/** The stored configuration everything on the page is derived from. */
type DashboardConfig = {
  pvEntities: PvEntity[];
  grid: Grid;
  batteries: Battery[];
};

async function readConfig(): Promise<DashboardConfig> {
  const [pvEntities, grid, batteries] = await Promise.all([
    listPvEntities(),
    readGrid(),
    listBatteries(),
  ]);

  return { pvEntities, grid, batteries };
}

/**
 * Every entity the page's readings are built from.
 *
 * One list, and both callers derive from it: `readDashboard` reads exactly
 * these, and the stream pushes for exactly these. Spelled out twice they would
 * eventually disagree, and the failure is a quiet one — a card whose entity
 * nobody is watching renders once on load and then sits there, correct-looking
 * and stale, until something else on the page happens to move.
 *
 * Unconfigured ids are dropped rather than carried as empty strings: a grid
 * with no sensor picked yet is one fewer reading on the page, not an entity to
 * go and ask Home Assistant about.
 */
function dashboardEntityIds({
  pvEntities,
  grid,
  batteries,
}: DashboardConfig): string[] {
  return [
    ...pvEntities.flatMap((entity) => [
      entity.powerEntityId,
      entity.energyEntityId,
    ]),
    grid.powerEntityId,
    ...batteries.flatMap((battery) => [
      battery.powerEntityId,
      battery.energyEntityId,
      battery.socEntityId,
    ]),
  ].filter((id): id is string => Boolean(id));
}

/**
 * Reads every entity the page needs, deduplicated — the same sensor can
 * legitimately be configured in two places.
 *
 * The live subscription answers when it can, from memory and with no round
 * trip at all. It cannot always: the socket takes a moment to come up after a
 * restart, and outside Home Assistant it never does. The REST fallback is what
 * makes those cases a normal page rather than an empty one.
 *
 * A Home Assistant that can't be reached is reported once, for the whole page,
 * rather than turning into one failure per card: the cause is the same for all
 * of them, and every reading falls back to "—".
 */
async function readStates(ids: string[]): Promise<{
  states: Map<string, HaState | null>;
  error: string | null;
}> {
  const unique = [...new Set(ids)];

  const live = liveStates(unique);
  if (live) return { states: live, error: null };

  try {
    const entries = await Promise.all(
      unique.map(async (id) => [id, await fetchHaState(id)] as const),
    );
    return { states: new Map(entries), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { states: new Map(), error: message };
  }
}

export async function readDashboard(): Promise<DashboardReadings> {
  const config = await readConfig();
  const { pvEntities, grid, batteries } = config;

  const { states, error } = await readStates(dashboardEntityIds(config));

  // Null rather than a reading when the read never happened, so the card shows
  // a dash instead of claiming the entity is missing.
  const reading = (id: string) =>
    states.has(id) ? toReading(states.get(id) ?? null) : null;

  return {
    arrays: pvEntities.map((entity) => ({
      id: entity.id,
      title: entity.title,
      power: reading(entity.powerEntityId),
      energy: reading(entity.energyEntityId),
    })),
    grid: {
      configured: isGridConfigured(grid),
      power: grid.powerEntityId ? reading(grid.powerEntityId) : null,
    },
    batteries: batteries.map((battery) => ({
      id: battery.id,
      title: battery.title,
      window: `${battery.minChargePercent}–${battery.maxChargePercent}% of ${battery.capacityKwh} kWh`,
      charge: reading(battery.socEntityId),
      power: reading(battery.powerEntityId),
      energy: reading(battery.energyEntityId),
    })),
    error,
  };
}

/**
 * The entity ids a set of readings was built from — what the stream watches to
 * decide whether a change is worth pushing. Derived from the configuration
 * rather than remembered, because it changes whenever settings are saved.
 */
export async function watchedEntityIds(): Promise<Set<string>> {
  return new Set(dashboardEntityIds(await readConfig()));
}
