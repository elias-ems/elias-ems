/**
 * Optimize charge limits' loop: plan every few minutes, and publish the
 * current interval's boundaries as a `balance` battery command.
 *
 * It used to write the battery's charge and AC output limit entities itself,
 * read them back, and keep a journal to restore them. All of that now belongs
 * to the automation listening for the battery's command event, which is what
 * makes a second battery — of a different brand, with different entities — a
 * matter of a second automation rather than a second code path here. What is
 * left of the journal is a one-way migration; see
 * `charge-limit-legacy.server.ts`.
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
} from "./charge-limit-status";
import { calculateChargePlan } from "./charge-planner.server";
import { CHARGE_LIMIT_PLANNING } from "./control";
import { readControlConfig } from "./control-config.server";
import { appendDiagnostic } from "./diagnostics.server";

const statuses = new Map<string, ChargeLimitStatus>();
let queue: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let nextPlan = 0;
/** Batteries whose pre-event power limits are still waiting to be restored. */
let legacyPending = new Set<string>();
const PLAN_MS = 300_000;
const TICK_MS = 30_000;
/**
 * How long past its interval a command stays valid. The loop replans at the
 * interval boundary but ticks only every `TICK_MS`, so without a grace an
 * adapter honouring `valid_until` would let go for up to a tick between two
 * perfectly healthy plans.
 */
export const COMMAND_GRACE_MS = 2 * TICK_MS;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Serialize settings changes with actuation so a disabled battery cannot receive an old plan. */
export function withChargeLimitLock<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => undefined);
  return result;
}

export function invalidateChargePlans() {
  nextPlan = 0;
  for (const status of statuses.values()) {
    status.state = "waiting";
    status.validUntil = null;
    status.message = "Settings changed; calculating a new plan.";
  }
}

/** Test-only: forget plans, statuses and migration state. */
export function resetChargeLimitLoop() {
  statuses.clear();
  nextPlan = 0;
  legacyPending = new Set();
}

const targetOf = (b: Battery): CommandTarget => ({
  batteryId: b.id,
  title: b.title,
  slug: batterySlug(b),
});

const legacyBlocks = (batteryId: string) =>
  legacyPending.has(batteryId) || legacyPending.has("*");

async function releaseHeld(
  batteries: Battery[],
  reason: ReleaseReason,
): Promise<CommandPublish[]> {
  const publishes = await releaseCommands(batteries.map(targetOf), reason, {
    strategy: "charge-limit",
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

function empty(b: Battery): ChargeLimitStatus {
  return {
    batteryId: b.id,
    title: b.title,
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
  const command =
    commandOwner(batteryId) === "charge-limit"
      ? publishedCommand(batteryId)
      : null;
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
        ...(statuses.get(b.id) || empty(b)),
        control: chargeLimitControl(
          control,
          b,
          batteries.length,
          legacyBlocks(b.id),
        ),
      })),
  };
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
  const active = control.enabled && control.strategy === "charge-limit";
  const batteries = await listBatteries();

  // Let go of anything this strategy holds but may no longer command. Only
  // what it is known to hold: a battery net zero energy has since taken over
  // is not ours to release.
  await releaseHeld(
    batteries.filter((b) => !active || !steerableBy(b, "charge-limit")),
    active ? "unsteered" : "disabled",
  );

  const planned = batteries.filter((b) => b.chargeLimitPlanning);
  if (!planned.length || now < nextPlan) return;
  nextPlan = now + PLAN_MS;

  for (const b of planned) {
    const status = empty(b);
    statuses.set(b.id, status);
    try {
      // Independent single-battery plans would allocate the same solar twice.
      if (batteries.length !== 1)
        throw new Error(
          "Charge-limit planning currently supports one configured household battery.",
        );
      let blocked = [
        control.enabled &&
          control.strategy !== "charge-limit" &&
          "Hypothetical preview: assumes native self-consumption while another battery strategy is active.",
        !b.steered &&
          "Enable Steer this battery to apply charge-limit control.",
        legacyBlocks(b.id) &&
          "Waiting to restore power limits written by an earlier version before publishing commands.",
      ]
        .filter(Boolean)
        .join(" ");
      const result = await calculateChargePlan(b, now, (key, message) => {
        status.checks = { ...status.checks, [key]: message };
      });
      blocked = [blocked, result.controlBlocker].filter(Boolean).join(" ");
      const mayPublish = active && !blocked;
      const current = result.plan.points[0];
      nextPlan = Math.min(nextPlan, current.end);
      Object.assign(status, {
        mode: mayPublish ? "active" : "preview",
        plan: result.plan,
        calculatedAt: now,
        validUntil: Math.min(now + PLAN_MS, current.end),
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
      if (!result.reserveCovered) {
        status.message +=
          " Beyond the price horizon, a full reserve is valued because the next solar recovery is not covered.";
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
      } else {
        // Do not publish a plan whose current interval ended while inputs were read.
        if (Date.now() >= current.end)
          throw new Error(
            "Plan expired during calculation; waiting for the next update.",
          );
        const [publish] = await publishCommands([
          {
            ...targetOf(b),
            strategy: "charge-limit",
            command: balanceCommand(
              {
                chargeLimitW: current.limitW,
                // Without discharge limiting the plan holds native output, and
                // the command says so by leaving the boundary out.
                dischargeLimitW: b.dischargeLimitSupported
                  ? (current.dischargeLimitW ?? null)
                  : null,
              },
              current.start,
              current.end + COMMAND_GRACE_MS,
            ),
            // Restated at the next interval at the latest, which is also when
            // the next plan is due.
            restateAt: current.end,
          },
        ]);
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
          `${b.title}: ${status.mode}, maximum charge ${current.limitW} W${current.dischargeLimitW === undefined || !b.dischargeLimitSupported ? "" : `, maximum AC output ${current.dischargeLimitW} W`}. ${status.message}`,
          sent,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (error) {
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

export function startChargeLimitLoop() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      await withChargeLimitLock(() => chargeLimitTick());
    } catch (error) {
      for (const s of statuses.values()) {
        s.state = "error";
        s.validUntil = null;
        s.message = messageOf(error);
      }
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
      timer = setTimeout(run, TICK_MS);
      timer.unref?.();
    }
  };
  void run();
}
