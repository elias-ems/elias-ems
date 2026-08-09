import { json } from "@remix-run/node";
import { fetchHaStates } from "../lib/ha.server";

export async function loader({ request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();

  let states;
  try {
    states = await fetchHaStates();
  } catch (error) {
    return json({ entities: [], error: error.message });
  }

  const entities = states
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

  return json({ entities, error: null });
}
