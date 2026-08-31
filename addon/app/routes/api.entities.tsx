/**
 * What an entity autocomplete polls while it is open. `?q=` narrows the list
 * and `?domain=` says which kind of entity is being picked; without either, the
 * first page of every sensor comes back.
 *
 * The route holds the query string and nothing else — which entities are
 * offerable and how they are shaped is `entities.server.ts`'s, and `domain` is
 * put through `parseOfferableDomain` rather than used as given, because this is
 * reachable by URL and an unbounded domain would enumerate the house.
 */
import { type EntitiesData, parseOfferableDomain } from "../lib/entities";
import { listEntityOptions } from "../lib/entities.server";
import type { Route } from "./+types/api.entities";

export async function loader({
  request,
}: Route.LoaderArgs): Promise<EntitiesData> {
  const params = new URL(request.url).searchParams;
  return listEntityOptions(
    params.get("q") ?? "",
    parseOfferableDomain(params.get("domain")),
  );
}
