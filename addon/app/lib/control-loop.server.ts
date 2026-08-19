/**
 * The control loop: one interval in the add-on's Node process that reads the
 * house out of Home Assistant, asks each enabled strategy what should be
 * happening, and writes the answers to diagnostics.
 *
 * Two features ride on it — battery control and PV curtailment — and they share
 * **one snapshot per tick** rather than reading for themselves. That is the
 * whole reason there is not a second loop: both correct against the same grid
 * meter, and two independent reads would let the two decisions describe
 * different instants. It is the same argument that makes `readTickConfig` one
 * read of the stored configuration rather than one per concern.
 *
 * They are also ordered: the batteries decide first. Nothing depends on that
 * ordering for correctness — curtailment's arithmetic has the battery cancel
 * out of it — but it keeps the log readable, with the reason a surplus was
 * curtailed sitting under the line saying the battery could not take it.
 *
 * Each tick publishes what it decided as an event per battery and per array and
 * records both halves. Deciding and acting stay separable — `net-zero.ts` and
 * `curtail.ts` work out what should happen, `targets.server.ts` and
 * `pv-limits.server.ts` put it on Home Assistant's bus for an automation to
 * carry out — which is what lets both strategies stay pure functions with no
 * idea that Home Assistant exists.
 *
 * A stopped loop lets everything go; see `releaseBatteries` and
 * `releasePvArrays`, and note that the safe direction is the opposite for each.
 *
 * Module-level state is the right shape for it: the server build is loaded once
 * per process, so "one loop per add-on" and "one module instance" are the same
 * statement. (Under Vite's dev server a hot reload can drop the module and with
 * it the log; `npm run start:ingress` is the stack to watch it on.)
 */
import {
  type Battery,
  batterySlug,
  isSteerable,
  resolvePowerLimits,
} from "./batteries";
import { listBatteries } from "./batteries.server";
import type { ControlConfig, ControlLoopStatus } from "./control";
import { readControlConfig } from "./control-config.server";
import {
  type CurtailInput,
  type PvArraySnapshot,
  planCurtailment,
} from "./curtail";
import type { CurtailmentConfig } from "./curtailment";
import { readCurtailmentConfig } from "./curtailment-config.server";
import type { DiagnosticsLevel, DiagnosticsOrigin } from "./diagnostics";
import { appendDiagnostic } from "./diagnostics.server";
import { type Grid, isGridConfigured } from "./grid";
import { readGrid } from "./grid.server";
import { onHaChange } from "./ha-live.server";
import { type BatterySnapshot, planNetZero } from "./net-zero";
import { priceEntityIds, readPricesFrom } from "./price-source.server";
import type { PriceConfig } from "./prices";
import { readPriceConfig } from "./prices.server";
import { isCurtailable, type PvEntity, pvSlug } from "./pv-entities";
import { listPvEntities } from "./pv-entities.server";
import {
  describePvLimitPublishes,
  forgetPublishedLimits,
  publishPvLimits,
} from "./pv-limits.server";
import { toNumber } from "./readings.server";
import { readingAge, readStates } from "./states.server";
import {
  describePublishes,
  forgetPublishedTargets,
  publishTargets,
} from "./targets.server";

/**
 * How often a tick happens when nothing at all is moving.
 *
 * Ticks are driven by Home Assistant now, so a house doing nothing produces no
 * events and would otherwise produce no ticks — which is indistinguishable, from
 * the outside, from a loop that has died. This is what keeps `lastTickAt` and
 * the diagnostics log honest. It reads memory and costs nothing.
 */
const IDLE_TICK_MS = 60_000;

type LoopState = {
  /** The idle heartbeat. Its presence is also what "the loop is running" means. */
  timer: ReturnType<typeof setInterval> | null;
  /** Unsubscribes from Home Assistant's changes; null when the loop is stopped. */
  unsubscribe: (() => void) | null;
  config: ControlConfig | null;
  curtailment: CurtailmentConfig | null;
  /** The tick currently awaiting Home Assistant, if any. Doubles as the overlap guard. */
  inFlight: Promise<void> | null;
  lastTickAt: string | null;
  /** When the last tick started, for the rate limit — monotonic-ish, not for display. */
  lastTickStartedAt: number | null;
  /** Set when changes arrived too soon after a tick and one is owed. */
  trailing: ReturnType<typeof setTimeout> | null;
  /** The entities whose changes should provoke a tick. */
  watched: Set<string>;
  /**
   * When the meter first went off curtailment's target, in epoch ms, or null
   * when it is on target.
   *
   * The settle rule needs to know how long something has been true, and
   * `curtail.ts` is pure — so the clock lives here and the elapsed time is
   * passed in. Reset the moment the meter comes back on target, which is what
   * makes the wait start again rather than accumulate across unrelated
   * excursions.
   */
  offTargetSinceMs: number | null;
};

const state: LoopState = {
  timer: null,
  unsubscribe: null,
  config: null,
  curtailment: null,
  inFlight: null,
  lastTickAt: null,
  lastTickStartedAt: null,
  trailing: null,
  watched: new Set(),
  offTargetSinceMs: null,
};

function log(
  origin: DiagnosticsOrigin,
  level: DiagnosticsLevel,
  message: string,
): void {
  appendDiagnostic(origin, level, message);
}

/** The stored configuration a tick's entity lists and its snapshots share. */
type TickConfig = {
  grid: Grid;
  batteries: Battery[];
  pvEntities: PvEntity[];
  prices: PriceConfig;
  control: ControlConfig;
  curtailment: CurtailmentConfig;
};

async function readTickConfig(): Promise<TickConfig> {
  const [grid, batteries, pvEntities, prices, control, curtailment] =
    await Promise.all([
      readGrid(),
      listBatteries(),
      listPvEntities(),
      readPriceConfig(),
      readControlConfig(),
      readCurtailmentConfig(),
    ]);

  return { grid, batteries, pvEntities, prices, control, curtailment };
}

/**
 * The readings a tick is built from — the loop's own, smaller than the page's.
 *
 * Derived from a configuration already in hand rather than reading its own, for
 * the reason `dashboard.server.ts` derives the page's list the same way: the ids
 * and the values read for them have to describe the same house. Read twice, a
 * save landing in between leaves a tick holding a battery's settings and another
 * battery's readings.
 *
 * Gated on what is actually switched on. PV power moves constantly and the
 * price entity moves at every slot boundary, so watching either while
 * curtailment is off would wake the loop for readings no decision depends on.
 *
 * This is also the set whose changes provoke a tick, which is why it is only
 * ever inputs. Nothing the loop *commands* belongs here: when a target power
 * used to be written to an entity, watching that entity meant every write came
 * back as a change, provoked another tick and was written again, with nothing
 * damping the loop. Publishing an event instead removes the entity but not the
 * rule — whatever an automation does with a target or a limit on the way to the
 * hardware must not become the reason for the next one.
 */
function controlReadingIds(config: TickConfig): string[] {
  const { grid, batteries, pvEntities, prices, control, curtailment } = config;

  return [
    ...(isGridConfigured(grid) ? [grid.powerEntityId] : []),
    ...(control.enabled
      ? batteries.flatMap((battery) => [
          battery.socEntityId,
          battery.powerEntityId,
        ])
      : []),
    ...(curtailment.enabled
      ? [
          ...pvEntities.map((entity) => entity.powerEntityId),
          // The price entity earns its place here: its state changes at every
          // slot boundary, which is what makes "the price just went negative"
          // provoke a tick with nothing anywhere polling a clock.
          ...priceEntityIds(prices),
        ]
      : []),
  ].filter(Boolean);
}

type Snapshots = {
  gridPowerW: number | null;
  batteries: BatterySnapshot[];
  arrays: PvArraySnapshot[];
  gridConfigured: boolean;
  provenance: string;
  /** What a kWh put on the grid earns right now, or null when unknown. */
  productionPricePerKwh: number | null;
  currency: string;
  /** Each steerable battery's slug, by battery id, ready to publish under. */
  slugs: Map<string, string>;
  /** The same for each curtailable array. */
  pvSlugs: Map<string, string>;
};

/**
 * Everything the strategies need, read fresh each tick.
 *
 * Through the same reader the dashboard uses, so a decision and the page agree
 * about what the house is doing: the live subscription answers from memory, and
 * REST covers the moment before it is up. The fan-out of one request per entity
 * is now the exception rather than every tick.
 */
async function readSnapshots(config: TickConfig): Promise<Snapshots> {
  const { grid, batteries, pvEntities, prices } = config;
  const gridConfigured = isGridConfigured(grid);

  const readingIds = controlReadingIds(config);
  const { states, error } = await readStates(readingIds);

  // The page can render dashes when Home Assistant is unreachable; a decision
  // cannot be made out of them. Raising it here turns the outage into one
  // "Tick failed" line and keeps the schedule, rather than a stream of ticks
  // that read like the house is idle when the truth is that nobody asked it.
  if (error) throw new Error(error);

  const stateOf = (id: string) => states.get(id)?.state ?? null;

  const readings = new Map(
    readingIds.flatMap((id) => {
      const read = states.get(id);
      return read ? [[id, read] as const] : [];
    }),
  );

  // Built from the same `states` map as every other reading rather than from a
  // read of its own, which is what keeps the price a decision was made on and
  // the readings it was made against describing the same instant.
  const priceRead = readPricesFrom(prices, states.get(prices.forecastEntityId));

  return {
    gridConfigured,
    gridPowerW: gridConfigured ? toNumber(stateOf(grid.powerEntityId)) : null,
    batteries: batteries.map((battery) => ({
      id: battery.id,
      title: battery.title,
      capacityKwh: battery.capacityKwh,
      minChargePercent: battery.minChargePercent,
      maxChargePercent: battery.maxChargePercent,
      socPercent: toNumber(stateOf(battery.socEntityId)),
      powerW: toNumber(stateOf(battery.powerEntityId)),
      steerable: isSteerable(battery),
      ...resolvePowerLimits(battery),
    })),
    arrays: pvEntities.map((entity) => ({
      id: entity.id,
      title: entity.title,
      powerW: toNumber(stateOf(entity.powerEntityId)),
      ratedPowerW: entity.ratedPowerW,
      curtailable: entity.curtailable,
    })),
    productionPricePerKwh: priceRead.now?.productionPerKwh ?? null,
    currency: priceRead.forecast?.currency ?? "EUR",
    provenance: describeSource(readings),
    slugs: new Map(
      batteries
        .filter(isSteerable)
        .map((battery) => [battery.id, batterySlug(battery)]),
    ),
    pvSlugs: new Map(
      pvEntities
        .filter(isCurtailable)
        .map((entity) => [entity.id, pvSlug(entity)]),
    ),
  };
}

/**
 * Where this tick's numbers came from and how old the oldest of them is, as one
 * clause for the log.
 *
 * Ages do not gate anything — a sensor holding the same value emits no events,
 * so an old reading on a quiet house is normal and refusing to decide on it
 * would be worse than useless. This line is how a genuinely stuck sensor
 * becomes visible instead: nothing else is watching, so the log has to be
 * legible enough that a person can.
 */
function describeSource(states: Parameters<typeof readingAge>[0]): string {
  const { source, oldestSeconds } = readingAge(states);
  if (!source) return "no readings";

  const via = source === "live" ? "live cache" : "REST";
  return oldestSeconds === null
    ? `via ${via}`
    : `via ${via}, oldest reading ${oldestSeconds}s`;
}

/** Battery control's half of a tick. */
async function tickBatteryControl(inputs: Snapshots): Promise<void> {
  if (!inputs.gridConfigured) {
    log(
      "battery-control",
      "warn",
      "The grid sensor is not configured — nothing to balance against.",
    );
    return;
  }

  const plan = planNetZero(inputs);

  // One entry for the whole tick, not one per line. A house that isn't doing
  // anything produces the same summary and the same per-battery decision every
  // few seconds; logged separately they interleave, so the log's
  // repeated-line collapsing never gets two identical entries in a row and the
  // buffer fills with near-duplicates instead of holding useful history.
  // Published before the decision is logged, so that a line saying what was
  // decided and a line saying what was done cannot end up in the other order.
  const publishes = await publishTargets(
    plan.decisions.flatMap((decision) => {
      const slug = inputs.slugs.get(decision.batteryId);
      if (!slug) return [];
      return [
        {
          batteryId: decision.batteryId,
          title: decision.title,
          slug,
          commandW: decision.commandW,
        },
      ];
    }),
  );

  const sent = describePublishes(publishes);

  const lines = [
    `${plan.summary} (${inputs.provenance})`,
    ...plan.warnings.map((warning) => `! ${warning}`),
    ...plan.decisions.map((decision) => decision.message),
    ...(sent ? [sent] : []),
  ];

  const troubled = publishes.some((publish) => publish.status === "failed");
  log(
    "battery-control",
    plan.warnings.length > 0 || troubled ? "warn" : "info",
    lines.join("\n"),
  );
}

/** PV curtailment's half of a tick. */
async function tickCurtailment(
  inputs: Snapshots,
  config: CurtailmentConfig,
  nowMs: number,
): Promise<void> {
  if (!inputs.gridConfigured) {
    log(
      "pv-curtailment",
      "warn",
      "The grid sensor is not configured — nothing to curtail against.",
    );
    return;
  }

  const input: CurtailInput = {
    gridPowerW: inputs.gridPowerW,
    arrays: inputs.arrays,
    productionPricePerKwh: inputs.productionPricePerKwh,
    currency: inputs.currency,
    config,
    nowMs,
    offTargetSinceMs: state.offTargetSinceMs,
  };

  const plan = planCurtailment(input);

  // The settle clock, kept here because `curtail.ts` may not read one. Cleared
  // whenever the meter is on target so that the next excursion waits its full
  // settle time rather than inheriting credit from an unrelated one.
  if (!plan.offTarget) state.offTargetSinceMs = null;
  else if (state.offTargetSinceMs === null) state.offTargetSinceMs = nowMs;

  const publishes = await publishPvLimits(
    plan.decisions.flatMap((decision) => {
      const slug = inputs.pvSlugs.get(decision.arrayId);
      const array = inputs.arrays.find(
        (candidate) => candidate.id === decision.arrayId,
      );
      if (!slug || !array?.ratedPowerW) return [];
      return [
        {
          arrayId: decision.arrayId,
          title: decision.title,
          slug,
          ratedPowerW: array.ratedPowerW,
          commandPercent: decision.commandPercent,
          released: decision.released,
        },
      ];
    }),
  );

  const sent = describePvLimitPublishes(publishes);

  const lines = [
    `${plan.summary} (${inputs.provenance})`,
    ...plan.warnings.map((warning) => `! ${warning}`),
    ...plan.decisions.map((decision) => decision.message),
    ...(sent ? [sent] : []),
  ];

  const troubled = publishes.some((publish) => publish.status === "failed");
  log(
    "pv-curtailment",
    plan.warnings.length > 0 || troubled ? "warn" : "info",
    lines.join("\n"),
  );
}

/**
 * One pass of both strategies. Exported so tests can drive it directly instead
 * of waiting on a clock, and so a tick can be forced from the UI.
 *
 * Each half is gated on what is stored rather than on what the loop was started
 * with, so switching a feature on or off takes effect on the next tick rather
 * than needing the loop restarted — the same way a changed battery or a changed
 * grid sensor does.
 */
export async function runControlTick(): Promise<void> {
  const config = await readTickConfig();
  const inputs = await readSnapshots(config);
  const nowMs = Date.now();

  if (config.control.enabled) await tickBatteryControl(inputs);
  if (config.curtailment.enabled) {
    await tickCurtailment(inputs, config.curtailment, nowMs);
  }

  state.lastTickAt = new Date().toISOString();
}

/**
 * Hands every steerable battery back by publishing 0 for it, and waits for it.
 *
 * Called when control is switched off and when the process is asked to stop. A
 * battery left forcing kilowatts because the thing that told it to is gone is
 * the worst failure that feature has: from the battery's side there is no
 * difference between a target that is still wanted and one whose author died
 * ten minutes ago.
 *
 * Zero is the safe value rather than the *correct* one, and the distinction is
 * worth being honest about. It stops the battery being driven in either
 * direction, which is safe on every inverter; it does not necessarily hand the
 * battery back to its own self-consumption logic, which on many brands means
 * putting a mode entity back rather than commanding a power. The event says
 * which of the two this is — `released: true` — so an automation that knows how
 * to restore its inverter's mode has something to trigger on, but the add-on
 * itself still only knows how to say "stop".
 *
 * Nothing here can survive `kill -9`, a power cut, or a container the
 * supervisor destroys without asking. The only real answer to those is an
 * inverter whose forced mode expires on its own — a command timeout, which
 * some brands have and others do not.
 */
export async function releaseBatteries(): Promise<void> {
  const batteries = (await listBatteries()).filter(isSteerable);
  if (batteries.length === 0) return;

  const publishes = await publishTargets(
    batteries.map((battery) => ({
      batteryId: battery.id,
      title: battery.title,
      slug: batterySlug(battery),
      commandW: 0,
      // Past the deadband: letting go is worth one event even when we think
      // the battery is already at 0, because what we think is the very thing
      // in doubt when something has gone wrong enough to be stopping.
      force: true,
    })),
  );

  // Nothing is steering these batteries any more, so nothing should be
  // remembered about them either — the next tick after control comes back on
  // publishes from scratch rather than deciding it already said this.
  forgetPublishedTargets();

  const trouble = publishes.filter((publish) => publish.status !== "published");
  log(
    "battery-control",
    trouble.length > 0 ? "error" : "info",
    trouble.length > 0
      ? `Released the batteries, but ${trouble
          .map(
            (publish) =>
              `${publish.title} (${publish.detail ?? publish.status})`,
          )
          .join(", ")} did not go out — check it is not still being driven.`
      : `Released ${publishes.length === 1 ? "the battery" : "the batteries"} to 0 W.`,
  );
}

/**
 * Hands every curtailable array back to full output, and waits for it.
 *
 * The mirror of `releaseBatteries`, and **the safe value is the opposite one**.
 * A battery that stops being commanded should stop; an array that stops being
 * commanded should generate. An array left pinned at 10% because the add-on was
 * switched off, updated or killed goes on throwing away most of a sunny day,
 * and there is nothing on the dashboard that would look wrong — which makes it
 * the quieter failure of the two, and the one worth being most careful about.
 */
export async function releasePvArrays(): Promise<void> {
  const arrays = (await listPvEntities()).filter(isCurtailable);
  if (arrays.length === 0) return;

  const publishes = await publishPvLimits(
    arrays.map((array) => ({
      arrayId: array.id,
      title: array.title,
      slug: pvSlug(array),
      ratedPowerW: array.ratedPowerW,
      commandPercent: 100,
      released: true,
      // Past the "nothing changed" check, for the same reason a battery's
      // release is: what we believe the array is set to is exactly what is in
      // doubt at the moment we are letting go of it.
      force: true,
    })),
  );

  forgetPublishedLimits();
  state.offTargetSinceMs = null;

  const trouble = publishes.filter((publish) => publish.status !== "published");
  log(
    "pv-curtailment",
    trouble.length > 0 ? "error" : "info",
    trouble.length > 0
      ? `Released the arrays, but ${trouble
          .map(
            (publish) =>
              `${publish.title} (${publish.detail ?? publish.status})`,
          )
          .join(", ")} did not go out — check it is not still being held back.`
      : `Released ${publishes.length === 1 ? "the array" : "the arrays"} to 100%.`,
  );
}

/**
 * Starts a tick without waiting for it — the interval callback cannot be async
 * and nothing about serving a page depends on the outcome. The promise is kept
 * in `state.inFlight` so it can be both the overlap guard and something tests
 * can await; see `pendingControlTick`.
 */
function startTick(): void {
  // A tick that is still waiting on Home Assistant must not have a second one
  // pile up behind it: the interval can be as short as a second and an
  // unreachable HA takes far longer than that to give up, which is exactly when
  // overlap would start.
  if (state.inFlight) {
    log(
      "battery-control",
      "warn",
      "Previous tick is still running — skipping this one.",
    );
    return;
  }

  state.lastTickStartedAt = Date.now();
  state.inFlight = runControlTick()
    .catch((error: unknown) => {
      // Home Assistant restarting, a revoked token, a network blip: log it and
      // keep the schedule. A loop that dies on the first outage is worse than no
      // loop, because from the outside it still looks like it is working.
      const message = error instanceof Error ? error.message : String(error);
      log("battery-control", "error", `Tick failed: ${message}`);
    })
    .finally(() => {
      state.inFlight = null;
      void refreshWatched();
    });
}

/**
 * Keeps the watched set in step with the configuration. Cheap enough to redo
 * after each tick, and doing it there means saving settings takes effect on the
 * next one rather than needing the loop restarted.
 */
async function refreshWatched(): Promise<void> {
  try {
    state.watched = new Set(controlReadingIds(await readTickConfig()));
  } catch {
    // A missing or unreadable config file is already the settings pages's
    // problem to report; the previous set stays in force until it is fixed.
  }
}

/**
 * A change arrived. Tick now if the rate limit allows, otherwise owe one.
 *
 * Leading edge, so the first change after a quiet spell is acted on at once —
 * that immediacy is the whole reason for driving this from events. The trailing
 * tick is what stops the *last* change before a lull from being the one that
 * gets swallowed, which would leave a decision standing on a reading nobody
 * looked at again.
 */
function requestTick(): void {
  const intervalMs = (state.config?.intervalSeconds ?? 5) * 1000;
  const since =
    state.lastTickStartedAt === null
      ? Number.POSITIVE_INFINITY
      : Date.now() - state.lastTickStartedAt;

  if (since >= intervalMs) {
    startTick();
    return;
  }

  if (state.trailing) return;
  state.trailing = setTimeout(() => {
    state.trailing = null;
    startTick();
  }, intervalMs - since);
  state.trailing.unref?.();
}

/**
 * The tick currently in flight, or an already-settled promise when there isn't
 * one. Exists so tests can wait for a tick to finish talking to Home Assistant:
 * a fake clock can move the interval along, but it cannot make real I/O land.
 */
export function pendingControlTick(): Promise<void> {
  return state.inFlight ?? Promise.resolve();
}

export function stopControlLoop(): void {
  state.unsubscribe?.();
  state.unsubscribe = null;

  if (state.trailing) clearTimeout(state.trailing);
  state.trailing = null;

  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

/**
 * Whether the shutdown handlers are already installed. Module state, like the
 * loop itself, because the process only has one set of signals to listen for.
 */
let shutdownArmed = false;

/**
 * Lets everything go when the add-on is asked to stop.
 *
 * Docker sends SIGTERM and then waits, which is exactly the window a last write
 * needs. Installed only once something has actually been switched on, so an
 * add-on nobody has configured adds no handlers, and with `once` so a second
 * signal during the release goes to the default handler and kills us anyway —
 * an operator asking twice should not be made to wait.
 *
 * Both releases run, and they run together rather than in sequence: neither
 * depends on the other, and the window before the process is killed is not one
 * to spend waiting on Home Assistant twice.
 *
 * `process.exit` is deliberately *not* called: the release is best-effort, and
 * forcing an exit code here would mean deciding on Node's behalf that nothing
 * else in the process still had cleanup to do.
 */
function armShutdownRelease(): void {
  if (shutdownArmed) return;
  shutdownArmed = true;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      stopControlLoop();
      void Promise.allSettled([releaseBatteries(), releasePvArrays()]);
      // Already logged where each happened, and there is nothing further to
      // try from inside a process that is on its way out.
    });
  }
}

/**
 * Bring the loop in line with what settings say — start it, stop it, or restart
 * it under a new interval or strategy. Idempotent, so it is safe to call on
 * every save and at boot.
 *
 * The loop runs while **either** feature is enabled, and each tick decides for
 * itself which halves to run. Curtailment without battery control is a
 * perfectly ordinary configuration — a house with panels and no battery — and
 * so is the reverse.
 */
export async function syncControlLoop(): Promise<ControlLoopStatus> {
  const [config, curtailment] = await Promise.all([
    readControlConfig(),
    readCurtailmentConfig(),
  ]);
  const previous = state.config;
  const previousCurtailment = state.curtailment;
  state.config = config;
  state.curtailment = curtailment;

  const wanted = config.enabled || curtailment.enabled;

  if (!wanted) {
    if (state.timer) {
      stopControlLoop();
      log(
        "battery-control",
        "info",
        "Battery control disabled — loop stopped.",
      );
      // Waited for, not fired and forgotten: the settings form is still
      // sitting on this response, and "it is off" should not come back before
      // the hardware has actually been let go.
      await Promise.all([releaseBatteries(), releasePvArrays()]);
    }
    return controlLoopStatus();
  }

  // A feature switched off while the other keeps the loop running still has to
  // let its own hardware go — the tick simply stops deciding for it, which on
  // its own would leave the last command standing forever.
  if (previous?.enabled && !config.enabled) await releaseBatteries();
  if (previousCurtailment?.enabled && !curtailment.enabled) {
    await releasePvArrays();
  }

  const changed =
    !previous ||
    previous.intervalSeconds !== config.intervalSeconds ||
    previous.strategy !== config.strategy;

  if (state.timer && !changed) {
    // The watched set depends on which features are on, so a feature toggled
    // while the loop keeps running still has to have its entities picked up.
    await refreshWatched();
    return controlLoopStatus();
  }

  stopControlLoop();
  log(
    "battery-control",
    "info",
    `Battery control enabled — ${config.strategy}, on every change and at most every ${config.intervalSeconds}s.`,
  );

  await refreshWatched();
  armShutdownRelease();

  // Home Assistant decides when there is something new to decide about. The
  // interval is now a ceiling on how often that can produce a tick rather than
  // the thing that produces them, so a grid reading that moves is acted on in
  // the time it takes to arrive instead of up to a full interval later.
  state.unsubscribe = onHaChange((changed) => {
    if (changed === null || state.watched.has(changed)) requestTick();
  });

  state.timer = setInterval(startTick, IDLE_TICK_MS);
  // Nothing here should be what keeps Node alive; the HTTP server is. Without
  // this a test that forgets to stop the loop hangs the whole run.
  state.timer.unref?.();

  // Tick once immediately so enabling a strategy produces a line at once
  // rather than after a silent interval.
  startTick();

  return controlLoopStatus();
}

/**
 * Battery control's view of the loop.
 *
 * `running` is deliberately narrower than "the timer exists": the loop can be
 * running for curtailment alone, and a home page that said battery control was
 * running because *something* was would be reporting the wrong feature.
 */
export function controlLoopStatus(): ControlLoopStatus {
  const config = state.config;
  return {
    running: state.timer !== null && config?.enabled === true,
    strategy: config?.strategy ?? "net-zero-energy",
    intervalSeconds: config?.intervalSeconds ?? 5,
    lastTickAt: state.lastTickAt,
  };
}

/** The same for curtailment. */
export function curtailmentLoopStatus(): {
  running: boolean;
  lastTickAt: string | null;
} {
  return {
    running: state.timer !== null && state.curtailment?.enabled === true,
    lastTickAt: state.lastTickAt,
  };
}

/** Test-only: forget everything this module remembers between cases. */
export function resetControlLoop(): void {
  stopControlLoop();
  // Including what was published: a case that starts with a battery already
  // "told" what the previous case told it would see its first target held
  // back by the deadband.
  forgetPublishedTargets();
  forgetPublishedLimits();
  state.config = null;
  state.curtailment = null;
  state.inFlight = null;
  state.lastTickAt = null;
  state.lastTickStartedAt = null;
  state.watched = new Set();
  state.offTargetSinceMs = null;
}
