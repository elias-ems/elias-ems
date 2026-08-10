/**
 * The control loop's debug trace: an in-memory ring buffer, shown in the
 * expandable box on the home page.
 *
 * Deliberately not persisted. At a five-second interval this produces thousands
 * of lines an hour, and writing them into `/data` would buy nothing but wear on
 * whatever the Home Assistant box boots from. An empty log after a restart is
 * intended, not a limitation to fix — if decisions ever need keeping for
 * after-the-fact analysis, that wants its own store and a retention policy
 * rather than this buffer made durable.
 */
import type { ControlLogEntry, ControlLogLevel } from "./control";

/** Roughly five minutes of ticks with one battery, which is what a debug box is for. */
const CAPACITY = 300;

let entries: ControlLogEntry[] = [];
let nextSeq = 1;

/** Local `HH:MM:SS`. Unlike toLocaleTimeString, this shape is the same everywhere. */
function clockTime(at: Date): string {
  return at.toTimeString().slice(0, 8);
}

export function appendControlLog(
  level: ControlLogLevel,
  message: string,
): ControlLogEntry {
  const now = new Date();

  // A stopped loop, an unconfigured grid or a steady house all repeat the same
  // line every tick. Collapsing them keeps the box readable and keeps the buffer
  // holding history rather than the same sentence three hundred times.
  const last = entries.at(-1);
  if (last && last.level === level && last.message === message) {
    last.repeat += 1;
    last.at = now.toISOString();
    last.time = clockTime(now);
    return last;
  }

  const entry: ControlLogEntry = {
    seq: nextSeq++,
    at: now.toISOString(),
    time: clockTime(now),
    level,
    message,
    repeat: 1,
  };

  entries.push(entry);
  if (entries.length > CAPACITY) entries = entries.slice(-CAPACITY);
  return entry;
}

/** Newest first, because that is the end anyone opening the box wants to read. */
export function readControlLog(limit = CAPACITY): ControlLogEntry[] {
  return entries.slice(-limit).reverse();
}

export function clearControlLog(): void {
  entries = [];
  nextSeq = 1;
}
