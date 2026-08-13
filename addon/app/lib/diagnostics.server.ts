/**
 * Where diagnostics are kept: one in-memory ring buffer per origin.
 *
 * Deliberately not persisted. The control loop alone produces thousands of lines
 * an hour at a five-second interval, and writing them into `/data` would buy
 * nothing but wear on whatever the Home Assistant box boots from. An empty log
 * after a restart is intended, not a limitation to fix — if decisions ever need
 * keeping for after-the-fact analysis, that wants its own store and a retention
 * policy rather than this buffer made durable. The Tools page's download is the
 * answer to "I want to keep this one": it hands over what is in memory now.
 *
 * A buffer *per origin* rather than one shared one, because the origins are not
 * equally chatty. The control loop ticking every second would otherwise evict
 * everything a quieter feature had ever said, and a diagnostics log that only
 * ever shows the loudest feature is no use for the thing it is for.
 */
import type {
  DiagnosticEntry,
  DiagnosticsLevel,
  DiagnosticsOrigin,
} from "./diagnostics";

/** Roughly five minutes of control ticks, which is what a diagnostics box is for. */
const CAPACITY_PER_ORIGIN = 300;

const buffers = new Map<DiagnosticsOrigin, DiagnosticEntry[]>();

/**
 * Shared across origins, so a merged read can order by it alone. It is the only
 * total order there is: two origins logging in the same millisecond have
 * identical timestamps.
 */
let nextSeq = 1;

/** Local `HH:MM:SS`. Unlike toLocaleTimeString, this shape is the same everywhere. */
function clockTime(at: Date): string {
  return at.toTimeString().slice(0, 8);
}

export function appendDiagnostic(
  origin: DiagnosticsOrigin,
  level: DiagnosticsLevel,
  message: string,
): DiagnosticEntry {
  const now = new Date();
  const entries = buffers.get(origin) ?? [];

  // A stopped loop, an unconfigured grid or a steady house all repeat the same
  // line every tick. Collapsing them keeps the box readable and keeps the buffer
  // holding history rather than the same sentence three hundred times.
  //
  // Compared against this origin's own last entry, not the log's: another
  // feature logging in between is not a reason to stop collapsing a run that is
  // still going. The entry keeps its `seq`, so it stays where it is in a merged
  // view rather than jumping to the end each time it repeats.
  const last = entries.at(-1);
  if (last && last.level === level && last.message === message) {
    last.repeat += 1;
    last.at = now.toISOString();
    last.time = clockTime(now);
    return last;
  }

  const entry: DiagnosticEntry = {
    seq: nextSeq++,
    at: now.toISOString(),
    time: clockTime(now),
    origin,
    level,
    message,
    repeat: 1,
  };

  entries.push(entry);
  buffers.set(
    origin,
    entries.length > CAPACITY_PER_ORIGIN
      ? entries.slice(-CAPACITY_PER_ORIGIN)
      : entries,
  );
  return entry;
}

/**
 * Newest first, because that is the end anyone opening the box wants to read.
 * Without an origin this merges every buffer, which is what the Tools page and
 * the download show.
 */
export function readDiagnostics({
  origin,
  limit = CAPACITY_PER_ORIGIN,
}: {
  origin?: DiagnosticsOrigin;
  limit?: number;
} = {}): DiagnosticEntry[] {
  if (origin) {
    return (buffers.get(origin) ?? []).slice(-limit).reverse();
  }

  return [...buffers.values()]
    .flat()
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit);
}

export function clearDiagnostics(): void {
  buffers.clear();
  nextSeq = 1;
}
