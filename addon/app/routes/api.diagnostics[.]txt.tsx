/**
 * The whole diagnostics log as a text file, for pasting into an issue. Served at
 * `/api/diagnostics.txt`.
 *
 * A route of its own rather than a flag on `/api/diagnostics`, so that one can
 * keep answering JSON to a fetcher and this one can answer a `Response` with the
 * headers that make a browser save it.
 *
 * The `[.]` in the filename is flat-routes escaping: a bare dot would be a path
 * separator, which would make this a *child* of `api.diagnostics` — and a
 * resource route with a parent that has a loader is no longer a resource route.
 * React Router would try to render it as a page instead of handing the Response
 * back untouched.
 */
import { formatDiagnostics } from "../lib/diagnostics";
import { readDiagnostics } from "../lib/diagnostics.server";

/** `2026-08-13T20-50-57`: a filename-safe ISO stamp, seconds resolution. */
function fileStamp(at: Date): string {
  return at.toISOString().slice(0, 19).replaceAll(":", "-");
}

export async function loader(): Promise<Response> {
  // Oldest first here, the reverse of the box: see `formatDiagnostics`.
  const entries = readDiagnostics().reverse();

  return new Response(formatDiagnostics(entries), {
    headers: {
      // `charset` is not optional: the entries contain `×` and `→`, and a
      // browser left to guess would show them as mojibake.
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="elias-ems-diagnostics-${fileStamp(new Date())}.txt"`,
      // The point of downloading is to capture this moment; a cached copy of an
      // earlier one would be worse than useless.
      "Cache-Control": "no-store",
    },
  });
}
