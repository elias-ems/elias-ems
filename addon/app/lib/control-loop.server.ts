/**
 * The control loop: one interval in the add-on's Node process that reads the
 * house out of Home Assistant, asks PV curtailment what should be happening,
 * and writes the answer to diagnostics.
 *
 * It used to carry a live battery strategy (net zero energy) too, sharing one
 * snapshot per tick so both corrected against the same meter reading. Battery
 * control is planned now — see `charge-limit-loop.server.ts` and the strategy
 * registry in `strategies/` — so this loop is curtailment's, plus the one
 * duty that stays process-wide: releasing every steered battery on shutdown.
 *
 * Deciding and acting stay separable: `curtail.ts` works out what should
 * happen and `pv-limits.server.ts` puts it on Home Assistant's bus for an
 * automation to carry out, which is what lets the strategy stay a pure
 * function with no idea that Home Assistant exists.
 *
 * A stopped loop lets everything go; see `releaseBatteries` and
 * `releasePvArrays`, and note that the safe direction is the opposite for each.
 *
 * Module-level state is the right shape for it: the server build is loaded once
 * per process, so "one loop per add-on" and "one module instance" are the same
 * statement. (Under Vite's dev server a hot reload can drop the module and with
 * it the log; `npm run start:ingress` is the stack to watch it on.)
 */
import { type Battery, batterySlug, isSteerable } from "./batteries";
import { listBatteries } from "./batteries.server";
import type { ReleaseReason } from "./battery-command";
import {
  type CommandPublish,
  forgetPublishedCommands,
  releaseCommands,
} from "./battery-commands.server";
import type { ControlConfig, StrategyId } from "./control";
import { readControlConfig } from "./control-config.server";
import {
  type CurtailInput,
  type PvArraySnapshot,
  type PvBatterySnapshot,
  planCurtailment,
} from "./curtail";
import type { CurtailmentConfig } from "./curtailment";
import { readCurtailmentConfig } from "./curtailment-config.server";
import type { DiagnosticsLevel, DiagnosticsOrigin } from "./diagnostics";
import { appendDiagnostic } from "./diagnostics.server";
import { type Grid, isGridConfigured } from "./grid";
import { readGrid } from "./grid.server";
import { onHaChange } from "./ha-live.server";
import { priceEntityIds, readPricesFrom } from "./price-source.server";
import type { PriceConfig } from "./prices";
import { readPriceConfig } from "./prices.server";
import { isCurtailable, type PvEntity, pvSlug } from "./pv-entities";
import { listPvEntities } from "./pv-entities.server";
import {
  anyNotInForce,
  describePvLimitPublishes,
  forgetPublishedLimit,
  forgetPublishedLimits,
  isIgnoringItsLimit,
  publishPvLimits,
} from "./pv-limits.server";
import { toBoolean, toNumber } from "./readings.server";
import { readingAge, readStates } from "./states.server";

/**
 * How often a tick happens when nothing at all is moving.
 *
 * Ticks are driven by Home Assistant now, so a house doing nothing produces no
 * events and would otherwise produce no ticks — which is indistinguishable, from
 * the outside, from a loop that has died. This is what keeps `lastTickAt` and
 * the diagnostics log honest. It reads memory and costs nothing.
 */
const IDLE_TICK_MS = 60_000;

/**
 * The shortest gap between two ticks. Ticks follow Home Assistant's changes, so
 * this is a rate limit rather than a schedule: fast enough to follow a kettle,
 * slow enough not to hammer HA with a meter that reports every second. Not a
 * setting, because `settleSeconds` is what paces how often curtailment actually
 * moves; `CONTROL_MIN_TICK_MS` overrides it only so a test can reach it in
 * milliseconds.
 */
const minTickMs = () => Number(process.env.CONTROL_MIN_TICK_MS) || 5_000;

type LoopState = {
  /** The idle heartbeat. Its presence is also what "the loop is running" means. */
  timer: ReturnType<typeof setInterval> | null;
  /** Unsubscribes from Home Assistant's changes; null when the loop is stopped. */
  unsubscribe: (() => void) | null;
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
   * excursions, and **restarted again whenever a limit actually moves**, which
   * is what stops the loop measuring its own correction before it has landed.
   */
  offTargetSinceMs: number | null;
};

const state: LoopState = {
  timer: null,
  unsubscribe: null,
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

/**
 * A line about the loop itself — a tick that failed, or one that overlapped —
 * rather than about either feature's decision.
 *
 * Written to **every** enabled feature's log, because each one's box is where
 * somebody would go to find out why its decisions stopped arriving. Sending it
 * to battery control alone was right while that was the only thing on the loop;
 * now it would leave a house running curtailment on its own with a silent box
 * and no way to tell a dead loop from a quiet one.
 */
function logLoop(level: DiagnosticsLevel, message: string): void {
  // Curtailment is the only feature left on this loop; battery strategies
  // plan in `charge-limit-loop.server.ts` and log under their own origin.
  log("pv-curtailment", level, message);
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
  const { grid, batteries, pvEntities, prices, curtailment } = config;

  return [
    ...(isGridConfigured(grid) ? [grid.powerEntityId] : []),
    // Battery power belongs to curtailment for a reason that is not obvious:
    // it does not command batteries, but a discharging one hides the shortfall
    // its feedback law is looking for, so the law has to be able to see it.
    // See `curtail.ts`.
    ...(curtailment.enabled
      ? batteries.map((battery) => battery.powerEntityId)
      : []),
    ...(curtailment.enabled
      ? [
          ...pvEntities.map((entity) => entity.powerEntityId),
          // The price entity earns its place here: its state changes at every
          // slot boundary, which is what makes "the price just went negative"
          // provoke a tick with nothing anywhere polling a clock.
          ...priceEntityIds(prices),
          // And the car sensor for the same reason: plugging one in is a change
          // in what the house can absorb, and it should provoke a tick rather
          // than waiting out an interval with the arrays still held down.
          curtailment.carChargingEntityId,
        ]
      : []),
  ].filter(Boolean);
}

type Snapshots = {
  gridPowerW: number | null;
  batteries: PvBatterySnapshot[];
  arrays: PvArraySnapshot[];
  gridConfigured: boolean;
  provenance: string;
  /** What a kWh put on the grid earns right now, or null when unknown. */
  productionPricePerKwh: number | null;
  /**
   * Whether a car wants the surplus, or null when nothing says — no sensor
   * configured, or one that is not readable. See `curtail.ts`.
   */
  carCharging: boolean | null;
  currency: string;
  /** Each curtailable array's slug, by array id, ready to publish. */
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
  const { grid, batteries, pvEntities, prices, curtailment } = config;
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
      title: battery.title,
      powerW: toNumber(stateOf(battery.powerEntityId)),
    })),
    arrays: pvEntities.map((entity) => ({
      id: entity.id,
      title: entity.title,
      powerW: toNumber(stateOf(entity.powerEntityId)),
      ratedPowerW: entity.ratedPowerW,
      curtailable: entity.curtailable,
      controlMode: entity.controlMode,
      stepLimitPercent: entity.stepLimitPercent,
    })),
    productionPricePerKwh: priceRead.now?.productionPerKwh ?? null,
    carCharging: curtailment.carChargingEntityId
      ? toBoolean(stateOf(curtailment.carChargingEntityId))
      : null,
    currency: priceRead.forecast?.currency ?? "EUR",
    provenance: describeSource(readings),
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
    // Every battery, steered or not: a battery discharging into the house is
    // hiding the same watts from the meter whoever is telling it to. Nothing is
    // commanded to them from this half — `curtail.ts` reads their power and
    // stops the arrays being held down in their place.
    batteries: inputs.batteries,
    productionPricePerKwh: inputs.productionPricePerKwh,
    carCharging: inputs.carCharging,
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

  const commands = plan.decisions.flatMap((decision) => {
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
        controlMode: array.controlMode,
        // The one piece of feedback the publish layer gets: without it, an
        // inverter that quietly dropped its limit would never be corrected,
        // because the plan computes the same percent either way.
        measuredW: array.powerW,
      },
    ];
  });

  // Asked before publishing, because publishing is what updates the memory this
  // reads. Kept separate from the publish outcome on purpose: a stepped
  // inverter stops being *written* to after a couple of re-assertions, and the
  // fault has to stay visible for as long as it lasts rather than disappearing
  // from the log at the same moment the add-on gives up on fixing it.
  const ignoring = commands.filter(isIgnoringItsLimit).map((c) => c.title);

  const publishes = await publishPvLimits(commands);

  // Restart the settle clock whenever a *new* number has gone to the hardware,
  // so that `settleSeconds` is the shortest time between two moves and not
  // merely a delay before the first one.
  //
  // Without this the clock cleared only on coming back on target, so a meter
  // that stayed off it — the ordinary case in a house whose load moves — left
  // `offTargetForMs` growing without bound and every tick acted. The loop then
  // measured before its own last correction had landed: an inverter ramp takes
  // seconds, and the grid and PV sensors do not update together, so `C` and `G`
  // in `C + (G - G_target)` end up describing different instants and the
  // correction is counted twice. It showed up as one-percent dither while the
  // house was quiet and as swings of tens of percent while it was not.
  //
  // A restatement is deliberately not a move: it repeats a number the array is
  // already ignoring, so there is nothing newly in flight to wait for.
  const moved = publishes.some(
    (publish) =>
      publish.status === "published" &&
      (publish.reason === "changed" || publish.reason === "first"),
  );
  // Guarded on the plan having been off target, because a release publishes
  // from the on-target path: starting a clock there would hand the *next*
  // excursion a head start it never earned.
  if (plan.offTarget && moved) state.offTargetSinceMs = nowMs;

  const sent = describePvLimitPublishes(publishes);

  const lines = [
    `${plan.summary} (${inputs.provenance})`,
    ...plan.warnings.map((warning) => `! ${warning}`),
    ...plan.decisions.map((decision) => decision.message),
    ...(ignoring.length > 0
      ? [
          `! ${ignoring.join(", ")} generating well above the limit given — check the automation is running and that the inverter accepts it.`,
        ]
      : []),
    ...(sent ? [sent] : []),
  ];

  const troubled = publishes.some((publish) => publish.status === "failed");
  // An array ignoring its limit is a warning, not routine traffic: it means an
  // automation is missing, listening for an old name, or an inverter is not
  // honouring what it was sent — the one failure this feature otherwise cannot
  // see.
  //
  // Driven by `ignoring` rather than by what was published, and the difference
  // matters for a stepped inverter: the add-on stops *writing* to one after a
  // couple of re-assertions, and the fault must not vanish from the log at the
  // same moment it gives up trying to fix it.
  log(
    "pv-curtailment",
    plan.warnings.length > 0 ||
      troubled ||
      ignoring.length > 0 ||
      anyNotInForce(publishes)
      ? "warn"
      : "info",
    lines.join("\n"),
  );
}

/**
 * One pass of PV curtailment. Exported so tests can drive it directly instead
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

  if (config.curtailment.enabled) {
    await tickCurtailment(inputs, config.curtailment, nowMs);
  }

  state.lastTickAt = new Date().toISOString();
}

/**
 * Hands steered batteries back by publishing a `release` command for each, and
 * waits for it.
 *
 * Called when a battery strategy is switched off or away (with that strategy,
 * so a battery another strategy has since taken over is left alone) and when
 * the process is asked to stop (with none, so every steered battery is let go).
 * A battery left forcing kilowatts because the thing that told it to is gone is
 * the worst failure this feature has: from the battery's side there is no
 * difference between a command still wanted and one whose author died ten
 * minutes ago.
 *
 * A release is not a hold. Hold is "keep the battery at 0 W"; release is "I am
 * no longer in charge of you", and the automation behind it is what knows how
 * to put this inverter back into its own self-consumption.
 *
 * Nothing here can survive `kill -9`, a power cut, or a container the
 * supervisor destroys without asking. That is what `valid_until` is for: an
 * adapter that honours it lets go on its own.
 */
export async function releaseBatteries(
  strategy?: StrategyId,
  reason: ReleaseReason = strategy ? "disabled" : "shutdown",
): Promise<void> {
  const batteries = (await listBatteries()).filter(isSteerable);
  if (batteries.length === 0) return;

  const publishes = await releaseCommands(
    batteries.map((battery) => ({
      batteryId: battery.id,
      title: battery.title,
      slug: batterySlug(battery),
    })),
    reason,
    { strategy },
  );
  if (publishes.length === 0) return;

  logRelease(publishes);
}

/**
 * Hands **one** battery back under the name it had, for when it alone stops
 * being commandable — removed, un-steered, or renamed. A rename matters as
 * much as the others: the automation listening for the old event type would
 * otherwise keep the last command standing until it expired.
 *
 * Unconditional, unlike `releaseBatteries`: settings is the one place that
 * knows the old name, so this is the one chance to say it.
 */
export async function releaseBattery(battery: Battery): Promise<void> {
  if (!isSteerable(battery)) return;
  logRelease(
    await releaseCommands(
      [
        {
          batteryId: battery.id,
          title: battery.title,
          slug: batterySlug(battery),
        },
      ],
      "unsteered",
    ),
  );
}

function logRelease(publishes: CommandPublish[]): void {
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
      : `Released ${publishes.length === 1 ? "the battery" : "the batteries"}.`,
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
      controlMode: array.controlMode,
      // Nothing to check against at full output; `force` is what carries this.
      measuredW: null,
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
 * Hands **one** array back, for when it alone stops being steered — removed
 * from settings, or un-ticked, or its rating cleared.
 *
 * Takes the record as it was *before* the change, which is the whole point: an
 * array that has just been deleted is no longer on disk to look up, and one
 * whose rating has just been cleared no longer has the number the limit was a
 * percentage of. Neither could be released from what settings now say.
 *
 * Without this the last limit published for that array would stand for ever.
 * Nothing decides for it any more, so nothing would ever supersede it, and the
 * add-on would go on quietly costing its owner a slice of every sunny day.
 */
export async function releasePvArray(array: PvEntity): Promise<void> {
  if (!isCurtailable(array)) return;

  const [publish] = await publishPvLimits([
    {
      arrayId: array.id,
      title: array.title,
      slug: pvSlug(array),
      ratedPowerW: array.ratedPowerW,
      commandPercent: 100,
      released: true,
      controlMode: array.controlMode,
      // Nothing to check against at full output; `force` is what carries this.
      measuredW: null,
      force: true,
    },
  ]);

  forgetPublishedLimit(array.id);

  log(
    "pv-curtailment",
    publish.status === "published" ? "info" : "error",
    publish.status === "published"
      ? `${array.title} is no longer curtailable — released it to 100%.`
      : `${array.title} is no longer curtailable, but the release did not go out (${publish.detail ?? publish.status}) — check it is not still being held back.`,
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
  // pile up behind it: ticks can be a few seconds apart and an
  // unreachable HA takes far longer than that to give up, which is exactly when
  // overlap would start.
  if (state.inFlight) {
    logLoop("warn", "Previous tick is still running — skipping this one.");
    return;
  }

  state.lastTickStartedAt = Date.now();
  state.inFlight = runControlTick()
    .catch((error: unknown) => {
      // Home Assistant restarting, a revoked token, a network blip: log it and
      // keep the schedule. A loop that dies on the first outage is worse than no
      // loop, because from the outside it still looks like it is working.
      const message = error instanceof Error ? error.message : String(error);
      logLoop("error", `Tick failed: ${message}`);
    })
    .finally(() => {
      state.inFlight = null;
      void refreshWatched();
    });
}

/**
 * The heartbeat's tick, for when the house has gone quiet — so it stands aside
 * whenever the house has not. Readings that update on a fixed cadence keep
 * landing on the same second as the heartbeat, and starting a tick there found
 * the change-driven one still in flight and warned about it once a minute, on
 * a loop that was perfectly healthy. A tick in flight or begun within the last
 * half interval already proves the loop is alive.
 */
function idleTick(): void {
  if (state.inFlight) return;
  if (
    state.lastTickStartedAt !== null &&
    Date.now() - state.lastTickStartedAt < IDLE_TICK_MS / 2
  )
    return;
  startTick();
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
  const since =
    state.lastTickStartedAt === null
      ? Number.POSITIVE_INFINITY
      : Date.now() - state.lastTickStartedAt;

  if (since >= minTickMs()) {
    startTick();
    return;
  }

  if (state.trailing) return;
  state.trailing = setTimeout(() => {
    state.trailing = null;
    startTick();
  }, minTickMs() - since);
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
 * it. Idempotent, so it is safe to call on
 * every save and at boot.
 *
 * The loop runs while **either** feature is enabled, and each tick decides for
 * itself which halves to run. Curtailment without battery control is a
 * perfectly ordinary configuration — a house with panels and no battery — and
 * so is the reverse.
 */
export async function syncControlLoop(): Promise<
  ReturnType<typeof curtailmentLoopStatus>
> {
  // Armed whatever is enabled: a battery strategy holding a battery runs in
  // its own loop, and it still has to be let go when the process stops.
  armShutdownRelease();
  const curtailment = await readCurtailmentConfig();
  const previousCurtailment = state.curtailment;
  state.curtailment = curtailment;

  const wanted = curtailment.enabled;

  if (!wanted) {
    if (state.timer) {
      stopControlLoop();
      if (previousCurtailment?.enabled) {
        log("pv-curtailment", "info", "PV curtailment disabled.");
      }
      // Waited for, not fired and forgotten: the settings form is still
      // sitting on this response, and "it is off" should not come back before
      // the hardware has actually been let go.
      await releasePvArrays();
    }
    return curtailmentLoopStatus();
  }

  // A feature switched off while the other keeps the loop running still has to
  // let its own hardware go — the tick simply stops deciding for it, which on
  // its own would leave the last command standing forever.
  if (previousCurtailment?.enabled && !curtailment.enabled) {
    log("pv-curtailment", "info", "PV curtailment disabled.");
    await releasePvArrays();
  }

  // Switching the feature on has to restart the loop, because the watched set
  // and the immediate first tick both depend on it.
  const changed = previousCurtailment?.enabled !== curtailment.enabled;

  if (state.timer && !changed) {
    // The watched set depends on which features are on, so a feature toggled
    // while the loop keeps running still has to have its entities picked up.
    await refreshWatched();
    return curtailmentLoopStatus();
  }

  stopControlLoop();
  // Only when the feature has just come on; a restart for any other reason
  // would be noise about something that did not change.
  if (curtailment.enabled && !previousCurtailment?.enabled) {
    log(
      "pv-curtailment",
      "info",
      `PV curtailment enabled — on every change and at most every ${minTickMs() / 1000}s, acting once the meter has been off target for ${curtailment.settleSeconds}s and at most that often thereafter.`,
    );
  }

  await refreshWatched();
  armShutdownRelease();

  // Home Assistant decides when there is something new to decide about. The
  // rate limit is a ceiling on how often that can produce a tick rather than
  // the thing that produces them, so a grid reading that moves is acted on in
  // the time it takes to arrive instead of up to a full interval later.
  state.unsubscribe = onHaChange((changed) => {
    if (changed === null || state.watched.has(changed)) requestTick();
  });

  state.timer = setInterval(idleTick, IDLE_TICK_MS);
  // Nothing here should be what keeps Node alive; the HTTP server is. Without
  // this a test that forgets to stop the loop hangs the whole run.
  state.timer.unref?.();

  // Tick once immediately so enabling a strategy produces a line at once
  // rather than after a silent interval.
  startTick();

  return curtailmentLoopStatus();
}

/** Whether the loop is running PV curtailment, and when it last ticked. */
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
  forgetPublishedCommands();
  forgetPublishedLimits();
  state.curtailment = null;
  state.inFlight = null;
  state.lastTickAt = null;
  state.lastTickStartedAt = null;
  state.watched = new Set();
  state.offTargetSinceMs = null;
}
