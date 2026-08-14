/**
 * The list of sensors the settings forms let you pick from.
 *
 * Here rather than in `api.entities.tsx` for the reason `dashboard.server.ts`
 * is not in `_index.tsx`: which entities are offerable, what a picked one is
 * called, and how many of them a dropdown can usefully show are decisions about
 * the domain, not about serving one request. The route is left holding the
 * query string and nothing else.
 */
import type { EntitiesData, EntityOption } from "./entities";
import { fetchHaStates, type HaState } from "./ha.server";

/**
 * Long enough to find what you meant, short enough that the list stays a
 * dropdown. A Home Assistant with hundreds of sensors is the normal case, so
 * something has to cap it.
 */
const MAX_OPTIONS = 25;

/**
 * Only `sensor.` entities: the fields that use this all store a reading, and a
 * switch or a binary sensor is not one.
 */
function isOfferable(state: HaState): boolean {
  return state.entity_id.startsWith("sensor.");
}

function toOption(state: HaState): EntityOption {
  return {
    entityId: state.entity_id,
    // Falling back to the id rather than to an empty label: an entity with no
    // friendly name is still pickable, and its id is what it is known by.
    name: state.attributes?.friendly_name ?? state.entity_id,
    unit: state.attributes?.unit_of_measurement ?? null,
  };
}

/**
 * Matched against the id as well as the name, because people search with
 * whichever they happen to remember — the id when they copied it out of Home
 * Assistant, the name when they read it off a card.
 */
function matches(entity: EntityOption, query: string): boolean {
  if (query === "") return true;
  return (
    entity.entityId.toLowerCase().includes(query) ||
    entity.name.toLowerCase().includes(query)
  );
}

/**
 * The sensors matching `query`, or the reason Home Assistant could not be
 * asked. Never throws: the caller is a dropdown, and a field that fails to open
 * says less than one that explains itself.
 */
export async function listEntityOptions(query: string): Promise<EntitiesData> {
  let states: HaState[];
  try {
    states = await fetchHaStates();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entities: [], error: message };
  }

  const needle = query.trim().toLowerCase();
  const entities = states
    .filter(isOfferable)
    .map(toOption)
    .filter((entity) => matches(entity, needle))
    .slice(0, MAX_OPTIONS);

  return { entities, error: null };
}
