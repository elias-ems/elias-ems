/**
 * Publishing battery commands — the actuation half every battery strategy
 * shares.
 *
 * Kept apart from the strategies, which stay pure, and from the loops, which
 * are about *when* to decide. What arrives here is a `BatteryCommand` (see
 * `battery-command.ts`); what leaves is one Home Assistant event per battery.
 *
 * ## Why an event rather than a write
 *
 * Battery control used to reach further than this. A setpoint strategy once
 * called `number.set_value` on a target entity; the charge-limit planner wrote
 * its two power-limit entities until this module replaced it. An entity write is a
 * state change — a logbook line, a recorder row, an activity-feed entry — and
 * it ties the add-on to whatever kind of entity a particular inverter happens
 * to expose. An event carries the same instruction with none of that, and an
 * automation per battery can do whatever *that* inverter needs: a mode entity
 * first, two registers, a REST call to something outside Home Assistant.
 *
 * ## One battery, one owner at a time
 *
 * Every strategy publishes on the same event type, so this module remembers
 * which strategy last applied a command to each battery. A strategy letting go
 * can release only batteries *it* holds: switching from one strategy to
 * another must not have the outgoing strategy's release land after the
 * incoming one's first command and leave the battery released.
 *
 * The cost of events is that nothing reads back what was asked; see
 * `PUBLISH_DEADBAND_W` and `restateAt` for how the memory below stays honest.
 */
import { randomUUID } from "node:crypto";
import {
  type BatteryCommand,
  commandEventType,
  commandPayload,
  describeCommand,
  type ReleaseReason,
} from "./battery-command";
import type { StrategyId } from "./control";
import { fireHaEvent } from "./ha.server";

/**
 * How far a setpoint may move before it is worth saying again, for strategies
 * that ask for one.
 *
 * A loop can tick every second and a house is never still, so a strategy
 * recalculating a few watts lower each time would otherwise fire an event every
 * tick — and on the other end is an automation doing real work against
 * hardware that on some brands commits every change to flash.
 */
export const PUBLISH_DEADBAND_W = 50;

/**
 * This process's identity on the bus. Fresh on every start, so an adapter that
 * remembers the last epoch can tell commands from before a restart from ones
 * after it.
 */
const OWNER_EPOCH = randomUUID();

export function ownerEpoch(): string {
  return OWNER_EPOCH;
}

export type PublishStatus =
  /** The event went out. */
  | "published"
  /** Nothing has changed since the last one, and it is not due a restatement. */
  | "unchanged"
  /** Nothing to say about this battery — the decision was to leave it alone. */
  | "skipped"
  /** Home Assistant refused it, or could not be reached. */
  | "failed";

/** Which battery, and the name its event goes out under. */
export type CommandTarget = {
  batteryId: string;
  title: string;
  /** The battery's slug: `elias_ems_<slug>_battery_command`. */
  slug: string;
};

export type CommandRequest = CommandTarget & {
  strategy: StrategyId;
  /** What should happen, or null to say nothing at all this tick. */
  command: BatteryCommand | null;
  /**
   * When an unchanged command should be said again, in epoch ms. The memory
   * below is an assumption rather than a reading — a 200 from Home Assistant
   * means the event reached the bus, not that anything obeyed it — and this is
   * what stops that assumption becoming an indefinite one. Each strategy
   * picks its own: a fast loop restates on a timer, a planner at its next
   * interval.
   */
  restateAt: number;
  /** Setpoint movement below this is not worth an event. Defaults to 0. */
  deadbandW?: number;
};

export type CommandPublish = CommandTarget & {
  action: "apply" | "release";
  command: BatteryCommand | null;
  status: PublishStatus;
  /** Why, when the status alone doesn't say it. */
  detail?: string;
};

type Remembered =
  | {
      action: "apply";
      strategy: StrategyId;
      command: BatteryCommand;
      restateAt: number;
    }
  | { action: "release" };

/**
 * What we last put on the bus for each battery, keyed by battery id so that a
 * rename does not inherit another name's history.
 *
 * Deliberately not persisted: a restart is exactly when what the hardware is
 * doing is least certain, so starting with nothing remembered and publishing on
 * the first decision is the right recovery. And a failed publish is
 * deliberately not recorded, or the deadband would suppress its own retry.
 */
const published = new Map<string, Remembered>();

/** Test-only: forget what every battery was last told. */
export function forgetPublishedCommands(): void {
  published.clear();
}

/** The command a battery is standing under, or null if released or unknown. */
export function publishedCommand(
  batteryId: string,
): (BatteryCommand & { strategy: StrategyId }) | null {
  const last = published.get(batteryId);
  return last?.action === "apply"
    ? { ...last.command, strategy: last.strategy }
    : null;
}

/** Which strategy holds a battery, if any. */
export function commandOwner(batteryId: string): StrategyId | null {
  const last = published.get(batteryId);
  return last?.action === "apply" ? last.strategy : null;
}

/**
 * The setpoint a battery was last told, in W, for the dashboard: null in
 * `balance`, after a release, or when nothing has gone out since start.
 *
 * The standing command rather than what the current tick computed — the
 * deadband means most ticks decide a value and then decline to publish it, and
 * what is standing is what the hardware is acting on.
 */
export function publishedSetpointW(batteryId: string): number | null {
  return publishedCommand(batteryId)?.setpointW ?? null;
}

function same(a: number | null, b: number | null, tolerance: number): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < Math.max(tolerance, 0.5);
}

function shouldPublish(request: CommandRequest, now: number): boolean {
  const command = request.command as BatteryCommand;
  const last = published.get(request.batteryId);
  if (!last || last.action === "release") return true;
  // A different strategy taking over is news even with identical numbers: the
  // adapter may key behaviour off who is in charge.
  if (last.strategy !== request.strategy) return true;
  if (now >= last.restateAt) return true;

  const before = last.command;
  return !(
    before.mode === command.mode &&
    before.gridCharging === command.gridCharging &&
    before.batteryExport === command.batteryExport &&
    same(before.setpointW, command.setpointW, request.deadbandW ?? 0) &&
    same(before.chargeLimitW, command.chargeLimitW, 0) &&
    same(before.dischargeLimitW, command.dischargeLimitW, 0)
  );
}

async function fire(
  target: CommandTarget,
  payloadBody: Parameters<typeof commandPayload>[1],
  issuedAt: number,
): Promise<void> {
  await fireHaEvent(
    commandEventType(target.slug),
    commandPayload(
      {
        slug: target.slug,
        batteryId: target.batteryId,
        title: target.title,
        commandId: randomUUID(),
        ownerEpoch: OWNER_EPOCH,
        issuedAt,
      },
      payloadBody,
    ),
  );
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function publishOne(request: CommandRequest): Promise<CommandPublish> {
  const base = {
    batteryId: request.batteryId,
    title: request.title,
    slug: request.slug,
    action: "apply" as const,
    command: request.command,
  };

  if (request.command === null) return { ...base, status: "skipped" };

  const now = Date.now();
  if (!shouldPublish(request, now)) return { ...base, status: "unchanged" };

  try {
    await fire(
      request,
      { action: "apply", strategy: request.strategy, command: request.command },
      now,
    );
    published.set(request.batteryId, {
      action: "apply",
      strategy: request.strategy,
      command: request.command,
      restateAt: request.restateAt,
    });
    return { ...base, status: "published" };
  } catch (error) {
    return { ...base, status: "failed", detail: messageOf(error) };
  }
}

/**
 * Publishes every battery's command, in parallel and independently. One
 * battery's event failing must not stop its neighbour being told what to do,
 * so nothing here rejects.
 */
export async function publishCommands(
  requests: CommandRequest[],
): Promise<CommandPublish[]> {
  return Promise.all(requests.map(publishOne));
}

/**
 * Hands batteries back: one `release` event each.
 *
 * With a `strategy`, only batteries that strategy holds — or that nothing in
 * this process has told anything yet, since what an earlier process said is
 * exactly what is in doubt — are released; a battery another strategy has
 * taken over is left alone. Without one (shutdown), every listed battery is.
 *
 * `onlyIfHeld` narrows that further to batteries known to be held — by this
 * strategy, or by any without one — for a loop that reconsiders every few
 * seconds and must not release the same idle battery each time.
 *
 * Ignores the deadband on purpose: letting go is worth one event even when we
 * think the battery is already let go, because what we think is the very thing
 * in doubt when something has gone wrong enough to be stopping.
 */
export async function releaseCommands(
  targets: CommandTarget[],
  reason: ReleaseReason,
  options: { strategy?: StrategyId; onlyIfHeld?: boolean } = {},
): Promise<CommandPublish[]> {
  const { strategy, onlyIfHeld = false } = options;
  const due = targets.filter((target) => {
    const owner = commandOwner(target.batteryId);
    if (onlyIfHeld) return owner !== null && (!strategy || owner === strategy);
    if (!strategy) return true;
    return owner === null || owner === strategy;
  });

  return Promise.all(
    due.map(async (target): Promise<CommandPublish> => {
      const base = {
        ...target,
        action: "release" as const,
        command: null,
      };
      const now = Date.now();
      try {
        await fire(
          target,
          {
            action: "release",
            strategy: strategy ?? commandOwner(target.batteryId),
            reason,
          },
          now,
        );
        published.set(target.batteryId, { action: "release" });
        return { ...base, status: "published" };
      } catch (error) {
        // Forget rather than keep: whatever was standing is now uncertain, so
        // the next decision should publish from scratch.
        published.delete(target.batteryId);
        return { ...base, status: "failed", detail: messageOf(error) };
      }
    }),
  );
}

/**
 * The one line a tick's commands are worth in the log, or null when there is
 * nothing to say. Skipped and unchanged commands are left out: on a balanced
 * house every tick produces a full set of them.
 */
export function describePublishes(publishes: CommandPublish[]): string | null {
  const parts: string[] = [];
  for (const publish of publishes) {
    if (publish.status === "published") {
      parts.push(
        publish.action === "release"
          ? `${publish.title} → released`
          : `${publish.title} → ${describeCommand(publish.command as BatteryCommand)}`,
      );
    } else if (publish.status === "failed") {
      parts.push(`${publish.title}: event failed (${publish.detail})`);
    }
  }
  return parts.length === 0 ? null : `Published: ${parts.join("; ")}`;
}
