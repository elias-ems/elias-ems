/**
 * What a diagnostics box polls while it is open. `?origin=` narrows it to one
 * feature; without it, every feature's entries come back merged.
 *
 * Separate from the page loaders on purpose: the home loader reads every
 * configured Home Assistant entity, which is far too much work to repeat every
 * couple of seconds, and its ten-second cadence is far too slow to watch a
 * five-second loop with. This route touches nothing but memory.
 */
import { type DiagnosticsData, isDiagnosticsOrigin } from "../lib/diagnostics";
import { readDiagnostics } from "../lib/diagnostics.server";
import type { Route } from "./+types/api.diagnostics";

export async function loader({
  request,
}: Route.LoaderArgs): Promise<DiagnosticsData> {
  const origin = new URL(request.url).searchParams.get("origin");

  // An unknown origin reads as "no filter" rather than as an error: the only
  // thing that can produce one is a stale client after an origin was renamed,
  // and showing it the whole log beats showing it a failure.
  return {
    entries: readDiagnostics(
      isDiagnosticsOrigin(origin) ? { origin } : undefined,
    ),
  };
}
