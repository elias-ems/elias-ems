/**
 * The list of entities the settings forms let you pick from.
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
 * What a field gets when it doesn't ask for anything else: readings, which is
 * what all but one of them store. A switch or a binary sensor is not one.
 */
const DEFAULT_DOMAINS = ["sensor"];

/**
 * Restricted to the domains the field asked for, because a field that writes
 * needs different entities from one that reads. The battery's target power
 * field asks for `number` and `input_number`; offering it a `sensor` would be
 * offering something that cannot be set.
 */
function isOfferable(state: HaState, prefixes: string[]): boolean {
  return prefixes.some((prefix) => state.entity_id.startsWith(prefix));
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
 * The entities matching `query` in `domains`, or the reason Home Assistant
 * could not be asked. Never throws: the caller is a dropdown, and a field that
 * fails to open says less than one that explains itself.
 */
export async function listEntityOptions(
  query: string,
  domains: string[] = DEFAULT_DOMAINS,
): Promise<EntitiesData> {
  let states: HaState[];
  try {
    states = await fetchHaStates();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entities: [], error: message };
  }

  const prefixes = domains.map((domain) => `${domain}.`);
  const needle = query.trim().toLowerCase();
  const entities = states
    .filter((state) => isOfferable(state, prefixes))
    .map(toOption)
    .filter((entity) => matches(entity, needle))
    .slice(0, MAX_OPTIONS);

  return { entities, error: null };
}
