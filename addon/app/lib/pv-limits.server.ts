/**
 * Publishing a generation limit for a PV array — curtailment's actuation half.
 *
 * The same split as `targets.server.ts`, and for the same reasons: the strategy
 * in `curtail.ts` stays pure, the loop is about *when* to decide, and this
 * module knows only how to say a decision out loud. What arrives here is
 * already a whole percentage of a known rating; what leaves is one Home
 * Assistant event per array.
 *
 * An event rather than a service call, again as for batteries: nothing stores
 * it, so a loop that restates a limit every half minute does not bury a day's
 * real state changes under its own chatter — and the add-on does not have to
 * know whether this inverter takes a percentage over Modbus, a watt setpoint
 * over its own API, or something that is not in Home Assistant at all.
 *
 * The cost is the same too: no read-back, which is what `REPUBLISH_MS` below is
 * about.
 */
import { fireHaEvent } from "./ha.server";
import { pvLimitEventType } from "./pv-entities";

/**
 * How long an array may go without hearing its limit restated.
 *
 * There is no deadband constant here to go with it, and that is the difference
 * from `targets.server.ts`. A battery target is a continuous number in watts, so
 * it needs `PUBLISH_DEADBAND_W` to stop a 4 W drift firing an event every tick;
 * a limit is already quantised to whole percent by the strategy, so "the value
 * changed" is exactly "it moved by at least one step" and no second threshold
 * is wanted. One percent of a 5 kW inverter is 50 W — the same order as the
 * battery deadband, arrived at by rounding rather than by comparison.
 *
 * What is still needed is this: the memory below is an assumption about what an
 * automation did with an event, and an automation that was reloaded, an
 * inverter that was power-cycled or a Home Assistant that restarted mid-tick
 * all recover on their own within a minute or so rather than waiting for the
 * limit to happen to move.
 */
export const REPUBLISH_MS = 30_000;

export type PvLimitStatus =
  /** The event went out. */
  | "published"
  /** Same limit as last time, and not stale yet. */
  | "unchanged"
  /** Nothing to say about this array — the decision was to leave it alone. */
  | "skipped"
  /** Home Assistant refused it, or could not be reached. */
  | "failed";

export type PvLimitPublish = {
  arrayId: string;
  title: string;
  slug: string;
  /** The limit asked for, in whole percent. Null when nothing was asked. */
  percent: number | null;
  status: PvLimitStatus;
  /** Why, when the status alone doesn't say it. */
  detail?: string;
};

/** What the loop knows about one array when it comes to publish. */
export type PvLimitCommand = {
  arrayId: string;
  title: string;
  /** The array's slug: `elias_ems_<slug>_pv_limit`. */
  slug: string;
  /** The inverter's rating, so the event can carry watts as well as percent. */
  ratedPowerW: number;
  /** What the strategy wants commanded, or null to say nothing at all. */
  commandPercent: number | null;
  /** Whether this is the add-on letting go rather than steering. */
  released: boolean;
  /**
   * Publish even when nothing has changed. Set by a release on shutdown:
   * letting go is worth one event regardless of what we believe the array is
   * already doing, because what we believe is the very thing in doubt when
   * something has gone wrong enough to be stopping.
   */
  force?: boolean;
};

/**
 * What we last put on the bus for each array, keyed by array id rather than by
 * slug so that renaming an array does not inherit whatever the new name's
 * history happened to be.
 *
 * Module-level state for the same reason the loop's is: the server build is
 * loaded once per process. Deliberately not persisted — a restart is exactly
 * when what the hardware is doing is least certain, so starting with no memory
 * and publishing on the first tick is the right recovery rather than a lost
 * optimisation.
 */
const published = new Map<string, { percent: number; at: number }>();

/** Test-only, and used by a release: forget what every array was last told. */
export function forgetPublishedLimits(): void {
  published.clear();
}

function shouldPublish(
  arrayId: string,
  percent: number,
  force: boolean,
  now: number,
): boolean {
  if (force) return true;

  const last = published.get(arrayId);
  if (!last) return true;
  if (last.percent !== percent) return true;

  return now - last.at >= REPUBLISH_MS;
}

async function publishOne(command: PvLimitCommand): Promise<PvLimitPublish> {
  const base = {
    arrayId: command.arrayId,
    title: command.title,
    slug: command.slug,
  };

  if (command.commandPercent === null) {
    return { ...base, percent: null, status: "skipped" };
  }

  const percent = Math.round(command.commandPercent);
  const now = Date.now();

  if (!shouldPublish(command.arrayId, percent, command.force ?? false, now)) {
    return { ...base, percent, status: "unchanged" };
  }

  try {
    await fireHaEvent(pvLimitEventType(command.slug), {
      slug: command.slug,
      array_id: command.arrayId,
      title: command.title,
      // Both forms, for the reason the battery event carries `charge_w` and
      // `discharge_w` beside the signed value: some inverters take a
      // percentage of nameplate and others an export setpoint in watts, and
      // neither automation should have to do arithmetic to get the other.
      limit_percent: percent,
      limit_w: Math.round((percent * command.ratedPowerW) / 100),
      rated_power_w: command.ratedPowerW,
      // True when the add-on is stepping out of the way rather than steering.
      // The percentage is 100 either way, but an automation that has to clear
      // a limit register — rather than write 100 into it — needs to tell
      // "generate everything" from "I am no longer in charge of you".
      released: command.released,
    });

    published.set(command.arrayId, { percent, at: now });
    return { ...base, percent, status: "published" };
  } catch (error) {
    // Deliberately not recorded: an event that never made it onto the bus must
    // not count as something the array has been told, or the next tick would
    // decide it had already said this and skip the retry.
    return {
      ...base,
      percent,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Publishes every array's limit, in parallel and independently. One array's
 * event failing must not stop its neighbour being told what to do, so nothing
 * here rejects: each publish resolves to its own outcome.
 */
export async function publishPvLimits(
  commands: PvLimitCommand[],
): Promise<PvLimitPublish[]> {
  return Promise.all(commands.map(publishOne));
}

/**
 * The one line a tick's limits are worth in the log, or null when there is
 * nothing to say.
 *
 * Skipped and unchanged limits are left out rather than named: a house sitting
 * inside the deadband produces a full set of them every tick, and spelling each
 * one out would bury the limits that did go out under lines saying nothing
 * happened.
 */
export function describePvLimitPublishes(
  publishes: PvLimitPublish[],
): string | null {
  const sent = publishes.filter((publish) => publish.status === "published");
  const trouble = publishes.filter((publish) => publish.status === "failed");

  const parts = sent.map((publish) => `${publish.title} → ${publish.percent}%`);

  for (const publish of trouble) {
    parts.push(`${publish.title}: event failed (${publish.detail})`);
  }

  if (parts.length === 0) return null;
  return `Published: ${parts.join("; ")}`;
}
