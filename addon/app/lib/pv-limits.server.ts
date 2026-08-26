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
 * it, so the add-on does not bury a day's real state changes under its own
 * chatter — and it does not have to know whether this inverter takes a
 * percentage over Modbus, a watt setpoint over its own API, or something that
 * is not in Home Assistant at all.
 *
 * Nothing stores it, but Home Assistant's activity log still *shows* it, and
 * that turns out to matter as much: an event published for no reason is an event
 * somebody has to scroll past while reading what happened in their house. What
 * counts as a reason is the subject of `publishReason` below.
 *
 * The cost is the same as for batteries too — no read-back — and the answer here
 * is different. See `notInForce`.
 */
import { fireHaEvent } from "./ha.server";
import { type PvControlMode, pvLimitEventType } from "./pv-entities";

/**
 * A limit goes out when it is **new, when it changes, and when the array is
 * visibly not obeying it** — and at no other time.
 *
 * There is no deadband constant here, unlike `targets.server.ts`. A battery
 * target is a continuous number of watts, so it needs `PUBLISH_DEADBAND_W` to
 * stop a 4 W drift firing an event every tick; a limit is already quantised to
 * whole percent by the strategy, so "the value changed" is exactly "it moved by
 * at least one step".
 *
 * This *used* to also restate every standing limit on a 30-second timer. That
 * was a mistake, and an expensive one: for most of the year injection prices are
 * positive, so every array sits released at 100% with nothing to say, and the
 * timer turned that into some 2,880 identical events per array per day. All of
 * them land in Home Assistant's activity log, which is where somebody is trying
 * to read what actually happened in their house.
 *
 * The timer was not pointless, though, and what it was quietly covering is the
 * reason `notInForce` below exists — see there before considering removing it.
 */

/**
 * How long to leave a limit that is not being obeyed before saying it again.
 *
 * Long, because this only ever fires while something is already wrong, and
 * re-asserting into a house where nothing is listening should be a slow drip
 * with an explanation attached rather than an event every tick.
 */
export const REASSERT_MS = 5 * 60_000;

/**
 * How many times a **stepped** inverter's limit may be re-asserted before the
 * add-on stops writing and settles for saying so in the log.
 *
 * Two, because the plausible innocent explanations — an automation reloading,
 * Home Assistant restarting mid-tick — are gone within a few minutes, and past
 * that the cause is something no number of retries will fix. A modulating
 * inverter has no such cap: its writes are free.
 */
export const MAX_STEPPED_REASSERTS = 2;

/**
 * How far above its limit an array may measure before the limit counts as not
 * being obeyed: the larger of this fraction of the inverter's rating and
 * `MIN_ENFORCEMENT_MARGIN_W`.
 *
 * Generous on purpose. An inverter tracks a setpoint approximately, the power
 * sensor lags it, and a cloud edge moves faster than either — none of which is
 * the failure this is looking for. What it is looking for is an array making
 * roughly what it likes while we believe it is being held back, which is not a
 * near-miss.
 */
export const ENFORCEMENT_MARGIN_FRACTION = 0.05;
export const MIN_ENFORCEMENT_MARGIN_W = 100;

export type PvLimitStatus =
  /** The event went out. */
  | "published"
  /** Same limit as last time, and not stale yet. */
  | "unchanged"
  /** Nothing to say about this array — the decision was to leave it alone. */
  | "skipped"
  /** Home Assistant refused it, or could not be reached. */
  | "failed";

/** Why a limit went out, for the log. */
export type PvLimitReason =
  /** Nothing was remembered for this array — a fresh process, or a release. */
  | "first"
  /** The limit moved by at least one step. */
  | "changed"
  /** A caller insisted, which today means a release. */
  | "forced"
  /**
   * The array is generating well above the limit we believe it is under, so
   * whatever we last said is not what the hardware is doing.
   */
  | "not-in-force";

export type PvLimitPublish = {
  arrayId: string;
  title: string;
  slug: string;
  /** The limit asked for, in whole percent. Null when nothing was asked. */
  percent: number | null;
  status: PvLimitStatus;
  /** Why it went out, when it did. */
  reason?: PvLimitReason;
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
   * How often this inverter may be written to. Decides whether a limit it is
   * ignoring is re-asserted indefinitely or only a couple of times; see
   * `MAX_STEPPED_REASSERTS`.
   */
  controlMode: PvControlMode;
  /**
   * What the array is actually generating right now, in W, or null when its
   * sensor has no number. The one piece of feedback this module gets, and what
   * `notInForce` is built on.
   */
  measuredW: number | null;
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
const published = new Map<
  string,
  {
    percent: number;
    at: number;
    /**
     * How many times this exact limit has been re-asserted because the array
     * was ignoring it. Reset whenever a genuinely new limit goes out.
     *
     * Only meaningful for a stepped inverter, and there it is the whole
     * safeguard: re-asserting into a house where nothing is listening would
     * otherwise write to permanent memory every `REASSERT_MS` for as long as
     * the price stayed negative — a few hundred writes across an afternoon,
     * spent on an automation that is not going to start working on its own.
     */
    reasserts: number;
  }
>();

/** Test-only, and used by a release: forget what every array was last told. */
export function forgetPublishedLimits(): void {
  published.clear();
}

/**
 * The same for one array, for when it alone stops being steered — removed from
 * settings, or simply un-ticked. Leaving its entry behind would make the next
 * limit it were ever given look like a repeat of one it no longer holds.
 */
export function forgetPublishedLimit(arrayId: string): void {
  published.delete(arrayId);
}

/**
 * The limit an array is standing under, as a whole percentage of its rating, or
 * null when none has gone out since this process started.
 *
 * Read-only, for the dashboard. Null and 100 mean different things and the page
 * draws them differently: 100 is "released, generate freely", null is "we have
 * not said anything to this array at all".
 */
export function publishedLimitPercent(arrayId: string): number | null {
  return published.get(arrayId)?.percent ?? null;
}

/**
 * Whether the array is visibly ignoring the limit we believe it is under.
 *
 * This is what replaced the old 30-second restatement, and it is not merely a
 * cheaper version of it — it covers a hole the loop cannot close on its own.
 *
 * `curtail.ts` computes `C_allowed = C + (G - G_target)`, and that expression
 * gives the **same answer whether or not the limit is being obeyed**. An array
 * held at 2000 W with the meter balanced gives `2000 + 0`; the same array making
 * 4000 W because its inverter forgot the limit, with the meter now exporting
 * 2000 W, gives `4000 - 2000`. Both are 2000 W, both round to the same percent,
 * and so nothing ever changes and nothing is ever republished. The house would
 * export at a negative price indefinitely with every tick reporting success.
 *
 * Measured power is the only thing that tells the two apart, and it does so
 * exactly when it matters. Note the corollary: when an array is generating
 * *under* its limit we cannot tell whether the limit is in force — and we do not
 * need to, because a limit that is not binding is not doing anything either way.
 * The moment it would bind is the moment this notices.
 *
 * A release cannot be checked this way. An array wrongly left curtailed
 * generates less than it might, and how much it might is precisely what nothing
 * here can know.
 */
function notInForce(command: PvLimitCommand, percent: number): boolean {
  // Nothing is being held back at full output, so there is nothing to disobey.
  if (percent >= 100) return false;
  if (command.measuredW === null) return false;

  const limitW = (percent * command.ratedPowerW) / 100;
  const margin = Math.max(
    MIN_ENFORCEMENT_MARGIN_W,
    command.ratedPowerW * ENFORCEMENT_MARGIN_FRACTION,
  );

  return command.measuredW > limitW + margin;
}

/** Why this limit is worth an event, or null when it isn't. */
function publishReason(
  command: PvLimitCommand,
  percent: number,
  now: number,
): PvLimitReason | null {
  if (command.force) return "forced";

  const last = published.get(command.arrayId);
  if (!last) return "first";
  if (last.percent !== percent) return "changed";

  // Rate limited against the last time anything went out for this array, so a
  // house where nothing is listening gets a slow drip rather than an event per
  // tick — which would be worse than the timer this replaced.
  if (notInForce(command, percent) && now - last.at >= REASSERT_MS) {
    // For an inverter that commits every write to permanent memory, a drip is
    // still a leak. Say it a couple of times in case the automation was merely
    // reloading, then stop *writing* — the tick keeps logging the warning
    // every time it sees it, so the fault stays visible without costing
    // anything. Observe always, write rarely.
    if (
      command.controlMode === "stepped" &&
      last.reasserts >= MAX_STEPPED_REASSERTS
    ) {
      return null;
    }
    return "not-in-force";
  }

  return null;
}

/**
 * Whether this array is ignoring its limit, regardless of whether anything is
 * going to be written about it.
 *
 * Separate from `publishReason` because the two questions genuinely differ for
 * a stepped inverter: the log should say so on every tick, and the bus should
 * hear about it at most twice.
 */
export function isIgnoringItsLimit(command: PvLimitCommand): boolean {
  if (command.commandPercent === null) return false;
  const percent = Math.round(command.commandPercent);
  const last = published.get(command.arrayId);
  return last?.percent === percent && notInForce(command, percent);
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
  const reason = publishReason(command, percent, now);

  if (!reason) return { ...base, percent, status: "unchanged" };

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
      // Which kind of inverter this is for. An automation does not usually need
      // it — every event it receives is already a real transition — but it makes
      // a trace readable, and it lets one automation serve both kinds if
      // somebody writes it that way.
      control_mode: command.controlMode,
      // True when the add-on is stepping out of the way rather than steering.
      // The percentage is 100 either way, but an automation that has to clear
      // a limit register — rather than write 100 into it — needs to tell
      // "generate everything" from "I am no longer in charge of you".
      released: command.released,
    });

    // A re-assertion is the *same* limit said again, so it carries the count
    // forward; anything else is a new limit and starts it over.
    published.set(command.arrayId, {
      percent,
      at: now,
      reasserts:
        reason === "not-in-force"
          ? (published.get(command.arrayId)?.reasserts ?? 0) + 1
          : 0,
    });
    return { ...base, percent, status: "published", reason };
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

  const parts = sent.map((publish) => {
    // Named rather than left to look routine. A re-assertion means the array is
    // generating well above what it was told to, so the interesting fact is not
    // that a limit went out — it is that the last one did not take.
    const why =
      publish.reason === "not-in-force"
        ? " (restated — the array is not obeying it)"
        : "";
    return `${publish.title} → ${publish.percent}%${why}`;
  });

  for (const publish of trouble) {
    parts.push(`${publish.title}: event failed (${publish.detail})`);
  }

  if (parts.length === 0) return null;
  return `Published: ${parts.join("; ")}`;
}

/** Whether any of these went out because the array was ignoring its limit. */
export function anyNotInForce(publishes: PvLimitPublish[]): boolean {
  return publishes.some((publish) => publish.reason === "not-in-force");
}
