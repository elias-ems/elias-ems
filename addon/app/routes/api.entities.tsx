import type { EntityOption } from "../lib/entities";
import { fetchHaStates } from "../lib/ha.server";
import type { Route } from "./+types/api.entities";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();

  let states;
  try {
    states = await fetchHaStates();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entities: [] as EntityOption[], error: message };
  }

  const entities: EntityOption[] = states
    .filter((state) => state.entity_id.startsWith("sensor."))
    .map((state) => ({
      entityId: state.entity_id,
      name: state.attributes?.friendly_name ?? state.entity_id,
      unit: state.attributes?.unit_of_measurement ?? null,
    }))
    .filter(
      (entity) =>
        q === "" ||
        entity.entityId.toLowerCase().includes(q) ||
        entity.name.toLowerCase().includes(q),
    )
    .slice(0, 25);

  return { entities, error: null };
}
