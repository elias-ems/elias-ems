/**
 * Battery control's planning loop: shortly before each price interval ends, ask
 * the selected strategy from the registry (`strategies/`) for a fresh plan, and
 * at the boundary publish the interval that has just started from it. Every
 * registered strategy runs here, which is what makes switching between them a
 * hand-over between two plans rather than between two loops.
 *
 * It used to write the battery's charge and AC output limit entities itself,
 * read them back, and keep a journal to restore them. All of that now belongs
 * to the automation listening for the battery's command event, which is what
 * makes a second battery — of a different brand, with different entities — a
 * matter of a second automation rather than a second code path here. What is
 * left of the journal is a one-way migration; see
 * `charge-limit-legacy.server.ts`.
 *
 * Planning `PLAN_LEAD_MS` ahead is what keeps a command both fresh and on time:
 * planning reads history and forecasts and may run a solver, so a plan made at
 * the boundary would make the command wait for it, and one made at the
 * previous boundary would be a whole interval old. A plan that is late still
 * costs nothing but freshness — the boundary applies whatever plan is in hand.
 */
import { type Battery, batterySlug, steerableBy } from "./batteries";
import { listBatteries } from "./batteries.server";
import { balanceCommand, type ReleaseReason } from "./battery-command";
import {
  type CommandPublish,
  type CommandTarget,
  commandOwner,
  describePublishes,
  publishCommands,
  publishedCommand,
  releaseCommands,
} from "./battery-commands.server";
import { restoreLegacyLimits } from "./charge-limit-legacy.server";
import {
  type ChargeLimitStatus,
  type ChargeLimitsData,
  chargeLimitControl,
  strategyLabel,
} from "./charge-limit-status";
import type { ChargePlan } from "./charge-plan";
import { calculateChargePlan } from "./charge-planner.server";
import { CHARGE_LIMIT_PLANNING, type StrategyId } from "./control";
import { readControlConfig } from "./control-config.server";
import { appendDiagnostic } from "./diagnostics.server";

const statuses = new Map<string, ChargeLimitStatus>();
let queue: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
/** Whether a run is under way; its own `finally` then schedules the next one. */
let running = false;
/** Set when settings change during a run, so the next one starts at once. */
let rerun = false;
/** When the next plan is due: `PLAN_LEAD_MS` before an interval ends. */
let nextPlan = 0;
/** When the next interval starts and its command is due, from the plan in hand. */
let nextApply = 0;
/** The plan each battery is currently commanded from, while it may publish. */
const applied = new Map<
  string,
  {
    strategy: StrategyId;
    points: ChargePlan["points"];
    commands: Awaited<ReturnType<typeof calculateChargePlan>>["commands"];
  }
>();
/** Batteries whose pre-event power limits are still waiting to be restored. */
let legacyPending = new Set<string>();
/** Cancels a solve in progress, so a settings save never waits one out. */
let planning: AbortController | null = null;
/**
 * How often the loop wakes between boundaries anyway, to restore limits an
 * earlier version wrote and to let go of batteries that may no longer be
 * commanded. Neither plans nor publishes a command.
 */
const HOUSEKEEPING_MS = 60_000;
/** How soon a plan that failed is tried again. */
const RETRY_MS = 60_000;
/**
 * How long before an interval ends the plan for the next one is made. Planning
 * normally takes well under a minute — a HiGHS solve is capped at 20 seconds
 * and history is cached after the first read — so this leaves a wide margin
 * while costing only a few minutes of state-of-charge drift.
 */
export const PLAN_LEAD_MS = 5 * 60_000;
/**
 * How long past its interval a command stays valid. The next interval's
 * command goes out at the boundary, but a run still holding the lock can delay
 * it; without a grace an adapter honouring `valid_until` would let go between
 * two perfectly healthy commands.
 */
export const COMMAND_GRACE_MS = 60_000;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Serialize settings changes with actuation so a disabled battery cannot receive an old plan. */
export function withChargeLimitLock<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => undefined);
  return result;
}

/** Abandon a plan being calculated; the next tick starts a fresh one. */
export function interruptPlanning() {
  planning?.abort();
}

export function invalidateChargePlans() {
  nextPlan = 0;
  applied.clear();
  wake();
  for (const status of statuses.values()) {
    status.state = "waiting";
    status.validUntil = null;
    status.message = "Settings changed; calculating a new plan.";
  }
}

/** Test-only: forget plans, statuses and migration state. */
export function resetChargeLimitLoop() {
  statuses.clear();
  applied.clear();
  nextPlan = 0;
  nextApply = 0;
  legacyPending = new Set();
}

const targetOf = (b: Battery): CommandTarget => ({
  batteryId: b.id,
  title: b.title,
  slug: batterySlug(b),
});

const legacyBlocks = (batteryId: string) =>
  legacyPending.has(batteryId) || legacyPending.has("*");

/**
 * Let go of what any strategy holds. Every battery command now comes from this
 * loop, so whichever registered strategy issued the standing one, it is ours
 * to release — including the one a strategy switch left behind.
 */
async function releaseHeld(
  batteries: Battery[],
  reason: ReleaseReason,
): Promise<CommandPublish[]> {
  const publishes = await releaseCommands(batteries.map(targetOf), reason, {
    onlyIfHeld: true,
  });
  const line = describePublishes(publishes);
  if (line)
    appendDiagnostic(
      "charge-limit",
      publishes.some((p) => p.status === "failed") ? "warn" : "info",
      line,
    );
  return publishes;
}

function empty(b: Battery, strategy: StrategyId): ChargeLimitStatus {
  return {
    batteryId: b.id,
    title: b.title,
    strategy,
    strategyStatus: null,
    mode: "preview",
    state: "waiting",
    message: "Waiting for the Energy dashboard forecast and household history.",
    calculatedAt: null,
    validUntil: null,
    requestedW: null,
    requestedDischargeW: null,
    plan: null,
    currency: "EUR",
    timeZone: "UTC",
    times: {},
    forecastEnd: null,
    sources: 0,
    historyHours: 0,
    solarMarginPercent: CHARGE_LIMIT_PLANNING.solarMarginPercent,
    checks: {
      solar: "Waiting",
      history: "Waiting",
      prices: "Waiting",
      battery: "Waiting",
    },
  };
}

/** What this strategy has standing for a battery, for the plan card. */
function standing(status: ChargeLimitStatus, batteryId: string) {
  const command = commandOwner(batteryId) ? publishedCommand(batteryId) : null;
  status.requestedW = command?.chargeLimitW ?? null;
  status.requestedDischargeW = command?.dischargeLimitW ?? null;
}

export async function readChargeLimits(): Promise<ChargeLimitsData> {
  // Do not take the execution lock: a cold history fetch can hold it for minutes.
  const [batteries, control] = await Promise.all([
    listBatteries(),
    readControlConfig(),
  ]);
  return {
    batteries: batteries
      .filter((b) => b.chargeLimitPlanning)
      .map((b) => ({
        ...(statuses.get(b.id) || empty(b, control.strategy)),
        control: chargeLimitControl(
          control,
          b,
          batteries.length,
          legacyBlocks(b.id),
        ),
      })),
  };
}

type PlannedCommand = Awaited<
  ReturnType<typeof calculateChargePlan>
>["commands"][number];

/** One planned interval as a `balance` command, restated when it ends. */
async function publishInterval(
  b: Battery,
  strategy: StrategyId,
  command: PlannedCommand,
  interval: ChargePlan["points"][number],
): Promise<CommandPublish> {
  const [publish] = await publishCommands([
    {
      ...targetOf(b),
      strategy,
      command: balanceCommand(
        {
          chargeLimitW: command.chargeLimitW,
          // Without discharge limiting the plan holds native output, and the
          // command says so by leaving the boundary out.
          dischargeLimitW: b.dischargeLimitSupported
            ? command.dischargeLimitW
            : null,
        },
        interval.start,
        interval.end + COMMAND_GRACE_MS,
      ),
      // Restated at the next interval at the latest, which is also when the
      // next plan is due.
      restateAt: interval.end,
    },
  ]);
  return publish;
}

/** The interval of a plan that contains `at`, if the plan reaches that far. */
const intervalAt = (points: ChargePlan["points"], at: number) =>
  points.findIndex((p) => p.start <= at && at < p.end);

/**
 * When the plan after this one is due: `PLAN_LEAD_MS` before the end of the
 * interval in force, or of the one after it when that moment has passed. A plan
 * with nothing after the interval in force plans again at its end.
 */
function planDue(points: ChargePlan["points"], index: number, at: number) {
  const lead = (i: number) => points[i].end - PLAN_LEAD_MS;
  if (lead(index) > at) return lead(index);
  return index + 1 < points.length
    ? Math.max(lead(index + 1), points[index].end)
    : points[index].end;
}

/**
 * Publish the interval that contains `now` from the plan already in hand, and
 * return when it ends. Returns null when there is no plan under this strategy,
 * and `now` when the plan has run out — both mean a plan is needed instead.
 */
async function applyPlanned(
  b: Battery,
  strategy: StrategyId,
  now: number,
): Promise<number | null> {
  const plan = applied.get(b.id);
  if (plan?.strategy !== strategy) return null;
  const index = intervalAt(plan.points, now);
  if (index < 0) return now;
  const interval = plan.points[index];
  const publish = await publishInterval(
    b,
    strategy,
    plan.commands[index],
    interval,
  );
  const status = statuses.get(b.id);
  if (status) {
    standing(status, b.id);
    status.validUntil = interval.end;
  }
  const sent = describePublishes([publish]);
  if (sent)
    appendDiagnostic(
      "charge-limit",
      publish.status === "failed" ? "warn" : "info",
      `${b.title}: applied the planned interval.\n${sent}`,
    );
  return interval.end;
}

export async function chargeLimitTick(now = Date.now()) {
  // Old direct writes first, every tick until they are all back: nothing gets
  // a command while an earlier version's limit may still be capping it.
  const legacy = await restoreLegacyLimits();
  legacyPending = legacy.pending;
  if (legacy.restored.length)
    appendDiagnostic(
      "charge-limit",
      "info",
      `Restored power limits written by an earlier version: ${legacy.restored.join(", ")}.`,
    );
  if (legacy.errors.length)
    appendDiagnostic(
      "charge-limit",
      "warn",
      `Restoring power limits written by an earlier version: ${legacy.errors.join(" ")} Retrying.`,
    );

  const control = await readControlConfig();
  const active = control.enabled;
  const batteries = await listBatteries();

  // Let go of anything held that may no longer be commanded.
  await releaseHeld(
    batteries.filter((b) => !active || !steerableBy(b, control.strategy)),
    active ? "unsteered" : "disabled",
  );

  const planned = batteries.filter((b) => b.chargeLimitPlanning);
  if (!planned.length) return;

  // A new price interval has started: apply what the plan in hand says for it.
  // The plan was made ahead of the boundary, so nothing here waits on one.
  if (now >= nextApply) {
    nextApply = Number.POSITIVE_INFINITY;
    for (const b of planned) {
      if (!active || !steerableBy(b, control.strategy) || legacyBlocks(b.id))
        continue;
      const end = await applyPlanned(b, control.strategy, now);
      if (end === null) continue;
      // A plan that has run out is replaced at once rather than at its lead.
      if (end <= now) nextPlan = 0;
      else nextApply = Math.min(nextApply, end);
    }
  }

  if (now < nextPlan) return;
  // Until a plan says when its interval ends; a failure leaves it here.
  nextPlan = now + RETRY_MS;

  for (const b of planned) {
    // A plan made ahead of the boundary leaves the interval in force alone: it
    // was applied from the previous plan, and the new one takes over when the
    // next interval starts. Without a plan in hand — at boot, after a settings
    // change or a failure — the current interval is published at once.
    const ahead =
      applied.get(b.id)?.strategy === control.strategy &&
      intervalAt(applied.get(b.id)?.points ?? [], now) >= 0;
    const status = empty(b, control.strategy);
    // What was just applied stays on the card while the new plan is made.
    standing(status, b.id);
    statuses.set(b.id, status);
    try {
      // Independent single-battery plans would allocate the same solar twice.
      if (batteries.length !== 1)
        throw new Error(
          "Charge-limit planning currently supports one configured household battery.",
        );
      let blocked = [
        !b.steered &&
          "Enable Steer this battery to apply charge-limit control.",
        legacyBlocks(b.id) &&
          "Waiting to restore power limits written by an earlier version before publishing commands.",
      ]
        .filter(Boolean)
        .join(" ");
      planning = new AbortController();
      const result = await calculateChargePlan(
        b,
        now,
        (key, message) => {
          status.checks = { ...status.checks, [key]: message };
        },
        control.strategy,
        planning.signal,
      );
      blocked = [blocked, result.controlBlocker].filter(Boolean).join(" ");
      const mayPublish = active && !blocked;
      // Planning can outlast the interval it started in; what matters is the
      // interval in force once it is done, which `now` alone cannot say.
      const at = Math.max(now, Date.now());
      const index = intervalAt(result.plan.points, at);
      if (index < 0)
        throw new Error(
          "Plan expired during calculation; waiting for the next update.",
        );
      const current = result.plan.points[index];
      const command = result.commands[index];
      const holdCurrent = ahead && index === 0;
      // What the log describes: the interval this plan will put in force.
      const shownIndex =
        holdCurrent && index + 1 < result.plan.points.length ? 1 : index;
      const shown = result.commands[shownIndex];
      nextPlan = planDue(result.plan.points, index, at);
      nextApply = current.end;
      if (mayPublish)
        applied.set(b.id, {
          strategy: control.strategy,
          points: result.plan.points,
          commands: result.commands,
        });
      else applied.delete(b.id);
      Object.assign(status, {
        mode: mayPublish ? "active" : "preview",
        plan: result.plan,
        strategyStatus: result.status,
        calculatedAt: now,
        validUntil: current.end,
        currency: result.currency,
        timeZone: result.timeZone,
        forecastEnd: result.forecastEnd,
        sources: result.sources,
        historyHours: result.historyHours,
        solarMarginPercent: result.solarMarginPercent,
        message: [blocked, result.planningNote, result.plan.reason]
          .filter(Boolean)
          .join(" "),
      });
      // Only a plan that actually valued the end-of-horizon reserve may say
      // so: HiGHS plans with none, whatever the forecast covers.
      if (!result.reserveCovered && result.plan.terminalReserveKwh > 0) {
        status.message +=
          " Beyond the price horizon, a full reserve is valued: the solar forecast shows no recovery within a day of it.";
      }
      const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: result.timeZone,
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const end = result.plan.points[result.plan.points.length - 1].end;
      status.times = Object.fromEntries(
        [
          now,
          result.forecastEnd,
          current.start + (end - current.start) / 2,
          ...result.plan.points.flatMap((p) => [p.start, p.end]),
        ].map((t) => [String(t), formatter.format(t)]),
      );

      let sent: string | null = null;
      if (!mayPublish) {
        await releaseHeld([b], "disabled");
      } else if (!holdCurrent) {
        const publish = await publishInterval(
          b,
          control.strategy,
          command,
          current,
        );
        if (publish.status === "failed")
          throw new Error(
            `The battery command did not go out: ${publish.detail}`,
          );
        sent = describePublishes([publish]);
      }
      standing(status, b.id);
      // Readers can poll during publishing; publish readiness only once done.
      status.state = mayPublish ? "active" : "preview";
      appendDiagnostic(
        "charge-limit",
        "info",
        [
          `${b.title}: ${strategyLabel(control.strategy)} ${status.mode}${shownIndex === index ? "" : `, from ${status.times[String(result.plan.points[shownIndex].start)]}`}, maximum charge ${shown.chargeLimitW} W${b.dischargeLimitSupported ? `, maximum AC output ${shown.dischargeLimitW} W` : ""}. ${status.message}`,
          sent,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (error) {
      if (planning?.signal.aborted) {
        // Settings changed mid-solve; the next tick plans under the new ones.
        status.message = "Settings changed; calculating a new plan.";
        continue;
      }
      applied.delete(b.id);
      status.state = "error";
      status.message = messageOf(error);
      status.validUntil = null;
      // A plan that cannot be trusted cannot stand either: hand the battery
      // back to its own self-consumption rather than leave it capped.
      const [release] = await releaseHeld([b], "failure");
      if (release?.status === "published")
        status.message += " Released the battery to its native control.";
      else if (release?.status === "failed")
        status.message += ` The release did not go out (${release.detail}); retrying.`;
      standing(status, b.id);
      appendDiagnostic("charge-limit", "warn", `${b.title}: ${status.message}`);
    }
  }
}

/**
 * Run now rather than at the next scheduled wake — after a settings change.
 * A run already under way picks the change up when it schedules its successor.
 */
function wake() {
  if (!started) return;
  if (running) {
    rerun = true;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(run, 0);
  timer.unref?.();
}

/**
 * Until the next plan or the next interval is due, or the next housekeeping
 * pass if sooner. A due time already past means nothing could be planned — no
 * battery to plan, or a run that failed before planning — and waits for
 * housekeeping rather than spinning.
 */
function schedule() {
  const now = Date.now();
  const due = [nextPlan, nextApply].filter((t) => t > now);
  const delay = rerun
    ? 0
    : due.length
      ? Math.min(Math.min(...due) - now, HOUSEKEEPING_MS)
      : HOUSEKEEPING_MS;
  rerun = false;
  timer = setTimeout(run, delay);
  timer.unref?.();
}

async function run() {
  running = true;
  try {
    await withChargeLimitLock(() => chargeLimitTick());
  } catch (error) {
    for (const s of statuses.values()) {
      s.state = "error";
      s.validUntil = null;
      s.message = messageOf(error);
    }
    applied.clear();
    appendDiagnostic("charge-limit", "error", messageOf(error));
    await withChargeLimitLock(async () => {
      try {
        await releaseHeld(await listBatteries(), "failure");
      } catch (failure) {
        appendDiagnostic(
          "charge-limit",
          "error",
          `Releasing the batteries failed and will be retried: ${messageOf(failure)}`,
        );
      }
    });
  } finally {
    running = false;
    schedule();
  }
}

export function startChargeLimitLoop() {
  if (started) return;
  started = true;
  void run();
}
