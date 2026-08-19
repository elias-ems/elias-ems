/**
 * Diagnostics: the shared trace every feature writes to and the Tools page
 * reads back.
 *
 * Pure, so the browser bundle can have it too — the buffer itself lives in
 * `diagnostics.server.ts`. An entry is an origin (which feature said it), a
 * message and a timestamp; the origin is what lets one box show the whole log
 * and another show just one feature's part of it.
 */

/**
 * A feature that logs. Adding one is a line here and a line in
 * `DIAGNOSTICS_ORIGINS` — nothing else, since every reader is driven by this
 * list rather than by a hardcoded set of boxes.
 */
export type DiagnosticsOrigin = "battery-control" | "pv-curtailment" | "prices";

export const DIAGNOSTICS_ORIGINS: Array<{
  id: DiagnosticsOrigin;
  label: string;
}> = [
  { id: "battery-control", label: "Battery control" },
  { id: "pv-curtailment", label: "PV curtailment" },
  { id: "prices", label: "Prices" },
];

export function isDiagnosticsOrigin(
  value: unknown,
): value is DiagnosticsOrigin {
  return DIAGNOSTICS_ORIGINS.some((origin) => origin.id === value);
}

/** The display name for an origin, falling back to the id itself. */
export function diagnosticsOriginLabel(origin: DiagnosticsOrigin): string {
  return (
    DIAGNOSTICS_ORIGINS.find((entry) => entry.id === origin)?.label ?? origin
  );
}

export type DiagnosticsLevel = "info" | "warn" | "error";

export type DiagnosticEntry = {
  /** Rises monotonically across every origin, so a merged view can order by it. */
  seq: number;
  /** ISO timestamp, for anyone reading the raw JSON or the downloaded file. */
  at: string;
  /**
   * `HH:MM:SS` in the server's timezone, formatted on the server for the same
   * reason readings are: a locale- or timezone-dependent string built during
   * render is a hydration mismatch waiting to happen.
   */
  time: string;
  origin: DiagnosticsOrigin;
  level: DiagnosticsLevel;
  message: string;
  /** How many times in a row this origin logged this exact message. */
  repeat: number;
};

/**
 * What `/api/diagnostics` answers with, and what the diagnostics box renders.
 * Declared here rather than in the route because both ends of that request need
 * it and neither may import the other: a component reaching into a route module
 * would cross the boundary the wrong way, and a route importing a component's
 * type would put the wire contract behind the UI that happens to draw it.
 */
export type DiagnosticsData = { entries: DiagnosticEntry[] };

/**
 * The downloaded file: one entry per block, newest last.
 *
 * Oldest first, which is the opposite of the box on screen. A box is read from
 * the end backwards to see what just happened; a file is read from the top
 * forwards to follow what led up to something, and that is also the order every
 * other log anyone will open next to it is in.
 *
 * Plain text rather than JSON because this exists to be pasted into an issue.
 */
export function formatDiagnostics(entries: DiagnosticEntry[]): string {
  const lines = entries.map((entry) => {
    const repeat = entry.repeat > 1 ? ` (×${entry.repeat})` : "";
    const head = `${entry.at}  ${entry.origin}  ${entry.level}${repeat}`;
    // A control tick is a summary line plus one line per battery. Indenting the
    // continuations keeps a grep for a timestamp finding entry starts only.
    const body = entry.message
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `${head}\n${body}`;
  });

  return `${lines.join("\n")}\n`;
}
