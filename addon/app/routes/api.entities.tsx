/**
 * What an entity autocomplete polls while it is open. `?q=` narrows the list,
 * `?domains=` says which kinds of entity are wanted; without either, the first
 * page of every offerable sensor comes back.
 *
 * The route holds the query string and nothing else — which entities are
 * offerable and how they are shaped is `entities.server.ts`'s.
 */
import type { EntitiesData } from "../lib/entities";
import { listEntityOptions } from "../lib/entities.server";
import type { Route } from "./+types/api.entities";

/**
 * The `domains` parameter, or undefined when the caller did not usefully ask
 * for any. A blank or comma-only value is a field that meant to filter and sent
 * nothing, not a request for every entity in the house, so it falls through to
 * the default rather than matching everything.
 */
function requestedDomains(params: URLSearchParams): string[] | undefined {
  const domains = (params.get("domains") ?? "")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);

  return domains.length > 0 ? domains : undefined;
}

export async function loader({
  request,
}: Route.LoaderArgs): Promise<EntitiesData> {
  const params = new URL(request.url).searchParams;
  return listEntityOptions(params.get("q") ?? "", requestedDomains(params));
}
