/**
 * Publishing a target for a battery — the half that makes this control rather
 * than observation.
 *
 * Kept apart from the strategy, which stays pure, and from the loop, which is
 * about *when* to decide rather than how to act on a decision. What arrives
 * here is already a number in watts with the sign convention applied; what
 * leaves is one Home Assistant event per battery.
 *
 * ## Why an event rather than a write
 *
 * This used to call `number.set_value` or `input_number.set_value` on an entity
 * configured per battery. It worked, and it left a trail: every target was a
 * state change, and so a logbook line, a recorder row and an entry in the
 * entity's activity feed. A loop that reconsiders every few seconds turns that
 * into thousands of rows a day whose only content is the add-on talking to
 * itself, and it buries the state changes a person actually wants to see.
 *
 * An event carries the same instruction with none of that: nothing stores it,
 * nothing renders it in a history, and the add-on stops needing to know what
 * kind of thing sits behind the battery. Where a `number` entity could only
 * ever be set, an automation can do whatever this particular inverter needs —
 * `modbus.write_register`, a mode entity first, two registers for charge and
 * discharge, a REST call to something that isn't in Home Assistant at all.
 *
 * The cost is that the loop can no longer read back what it wrote, which is
 * what `PUBLISH_DEADBAND_W` and `REPUBLISH_MS` below are about.
 */
import { targetEventType } from "./batteries";
import { fireHaEvent } from "./ha.server";

/**
 * How far the target may move before it is worth saying again.
 *
 * The loop can tick every second, and a house is never still, so a strategy
 * that recalculates 4 W lower each time would otherwise fire an event every
 * tick. The event itself is cheap; what is on the other end of it is not — an
 * automation writing a Modbus register does real work, against hardware that on
 * some brands commits every change to flash. Wide enough to swallow that noise,
 * narrow enough that it is a rounding error against a battery worth steering.
 */
export const PUBLISH_DEADBAND_W = 50;

/**
 * How long a battery may go without hearing the target restated.
 *
 * The deadband above compares against what we last published rather than
 * against what the battery is actually set to, because an event has no
 * read-back: once it is on the bus, whether an automation picked it up is not
 * something this process can find out. That makes the memory below an
 * assumption, and this is what keeps it from being an indefinite one — an
 * automation that was reloaded, an inverter that was power-cycled, or a Home
 * Assistant that restarted mid-tick all recover on their own within a minute
 * or so instead of waiting for the house to move by 50 W.
 *
 * Half the loop's idle tick, so a quiet house restates every target on the
 * next idle tick rather than every other one.
 */
export const REPUBLISH_MS = 30_000;

export type PublishStatus =
  /** The event went out. */
  | "published"
  /** Nothing has changed since the last one, and it is not stale yet. */
  | "unchanged"
  /** Nothing to say about this battery — the decision was to leave it alone. */
  | "skipped"
  /** Home Assistant refused it, or could not be reached. */
  | "failed";

export type TargetPublish = {
  batteryId: string;
  title: string;
  /** The battery's slug — the event type is built from it. */
  slug: string;
  /** What was asked for, in whole watts. Null when nothing was. */
  valueW: number | null;
  status: PublishStatus;
  /** Why, when the status alone doesn't say it. */
  detail?: string;
};

/** What the loop knows about one battery when it comes to publish. */
export type BatteryTarget = {
  batteryId: string;
  title: string;
  /** The battery's slug, from its title: `elias_ems_<slug>_target_power`. */
  slug: string;
  /** What the strategy wants commanded, or null to say nothing at all. */
  commandW: number | null;
  /**
   * Publish even when the deadband says there is nothing new. Set by a
   * release: letting go is worth one event regardless of what we think the
   * battery is already doing.
   */
  force?: boolean;
};

/**
 * What we last put on the bus for each battery, keyed by battery id rather than
 * by slug so that renaming a battery doesn't inherit whatever the new name's
 * history happened to be.
 *
 * Module-level state for the same reason the loop is: the server build is
 * loaded once per process. It is deliberately not persisted — a restart is
 * exactly the moment when what the hardware is doing is least certain, so
 * starting with no memory and publishing on the first tick is the right
 * recovery rather than a lost optimisation.
 */
const published = new Map<string, { valueW: number; at: number }>();

/** Test-only, and used by a release: forget what every battery was last told. */
export function forgetPublishedTargets(): void {
  published.clear();
}

/**
 * What a battery was last told, in W, or null when nothing has gone out for it
 * since this process started.
 *
 * The dashboard shows this rather than what the current tick computed, and the
 * two are not the same number: the deadband above means most ticks decide a
 * value and then decline to publish it. What is standing is what the hardware
 * is acting on, so it is what a person reading the page needs to see.
 */
export function publishedTargetW(batteryId: string): number | null {
  return published.get(batteryId)?.valueW ?? null;
}

/**
 * Whether this value is worth an event, and what to record if it goes out.
 *
 * Three ways through: nothing remembered (a fresh process, or the first
 * target after a release), a move that clears the deadband, and a value old
 * enough to be worth restating. The last two are the pair that replaces the
 * read-back the entity write used to give us.
 */
function shouldPublish(
  batteryId: string,
  valueW: number,
  force: boolean,
  now: number,
): boolean {
  if (force) return true;

  const last = published.get(batteryId);
  if (!last) return true;
  if (Math.abs(last.valueW - valueW) >= PUBLISH_DEADBAND_W) return true;

  return now - last.at >= REPUBLISH_MS;
}

/**
 * Publishes one battery's target, reporting what happened rather than
 * throwing.
 *
 * Every outcome is a value, because every outcome is something the log should
 * be able to say out loud: a caller that only learned about failures could not
 * tell a quiet loop from one whose targets are all being held back.
 */
async function publishOne(target: BatteryTarget): Promise<TargetPublish> {
  const base = {
    batteryId: target.batteryId,
    title: target.title,
    slug: target.slug,
  };

  if (target.commandW === null) {
    return { ...base, valueW: null, status: "skipped" };
  }

  // Whole watts: there is no entity `step` to snap to any more, and a target
  // carried to fifteen decimal places would only make the payload harder to
  // read in an automation's trace.
  const valueW = Math.round(target.commandW);
  const now = Date.now();

  if (!shouldPublish(target.batteryId, valueW, target.force ?? false, now)) {
    return { ...base, valueW, status: "unchanged" };
  }

  try {
    // The battery is named by the event type rather than only inside the
    // payload, so an automation's trigger says which battery it is for in the
    // one line that is hardest to get wrong. `slug` is repeated in the data
    // for the automation that listens to several types at once and has to
    // branch on which arrived.
    await fireHaEvent(targetEventType(target.slug), {
      slug: target.slug,
      battery_id: target.batteryId,
      title: target.title,
      // Signed, in the add-on's own convention: positive charging, negative
      // discharging.
      power_w: valueW,
      // The same number split by direction, as unsigned magnitudes. Plenty of
      // inverters have a charge register and a discharge register rather than
      // one signed value, and doing the split here keeps that automation
      // free of Jinja arithmetic that is easy to get the sign of wrong.
      charge_w: Math.max(0, valueW),
      discharge_w: Math.max(0, -valueW),
      // True only when the add-on is letting go rather than steering. The
      // watts are 0 either way, but an automation that has to put an inverter
      // back into self-consumption needs to tell "stop" from "stop, and I am
      // no longer in charge of you".
      released: target.force === true,
    });

    published.set(target.batteryId, { valueW, at: now });
    return { ...base, valueW, status: "published" };
  } catch (error) {
    // Deliberately not recorded: an event that never made it onto the bus must
    // not count as something the battery has been told, or the deadband would
    // suppress the retry on the next tick.
    return {
      ...base,
      valueW,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Publishes every battery's target, in parallel and independently.
 *
 * One battery's event failing must not stop its neighbour being told what to
 * do, so nothing here rejects: each publish resolves to its own outcome and the
 * caller decides what is worth logging.
 */
export async function publishTargets(
  targets: BatteryTarget[],
): Promise<TargetPublish[]> {
  return Promise.all(targets.map(publishOne));
}

/**
 * The one line a tick's targets are worth in the log, or null when there is
 * nothing to say.
 *
 * Skipped and unchanged targets are counted rather than named: on a balanced
 * house every tick produces a full set of them, and spelling each one out would
 * bury the targets that did go out under lines saying nothing happened.
 */
export function describePublishes(publishes: TargetPublish[]): string | null {
  const sent = publishes.filter((publish) => publish.status === "published");
  const trouble = publishes.filter((publish) => publish.status === "failed");

  const parts = sent.map(
    (publish) => `${publish.title} → ${Math.round(publish.valueW ?? 0)} W`,
  );

  for (const publish of trouble) {
    parts.push(`${publish.title}: event failed (${publish.detail})`);
  }

  if (parts.length === 0) return null;
  return `Published: ${parts.join("; ")}`;
}
