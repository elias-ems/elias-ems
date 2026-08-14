/**
 * What an entity autocomplete polls while it is open. `?q=` narrows the list;
 * without it, the first page of every offerable sensor comes back.
 *
 * The route holds the query string and nothing else — which sensors are
 * offerable and how they are shaped is `entities.server.ts`'s.
 */
import type { EntitiesData } from "../lib/entities";
import { listEntityOptions } from "../lib/entities.server";
import type { Route } from "./+types/api.entities";

export async function loader({
  request,
}: Route.LoaderArgs): Promise<EntitiesData> {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return listEntityOptions(query);
}
