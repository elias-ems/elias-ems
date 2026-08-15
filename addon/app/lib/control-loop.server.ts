/**
 * The control loop: one interval in the add-on's Node process that, every
 * `intervalSeconds`, reads the grid and the batteries out of Home Assistant,
 * asks the configured strategy what the batteries should be doing, and writes
 * the answer to diagnostics.
 *
 * Each tick then writes what it decided to each battery's target power entity
 * and records both halves. The decision and the actuation stay separable —
 * `net-zero.ts` works out what should happen and `setpoints.server.ts` makes it
 * happen — which is what lets the strategy stay a pure function with no idea
 * that Home Assistant exists.
 *
 * A stopped loop lets the batteries go; see `releaseBatteries`.
 *
 * Module-level state is the right shape for it: the server build is loaded once
 * per process, so "one loop per add-on" and "one module instance" are the same
 * statement. (Under Vite's dev server a hot reload can drop the module and with
 * it the log; `npm run start:ingress` is the stack to watch it on.)
 */
import { type Battery, isSteerable, resolvePowerLimits } from "./batteries";
import { listBatteries } from "./batteries.server";
import type { ControlConfig, ControlLoopStatus } from "./control";
import { readControlConfig } from "./control-config.server";
import type { DiagnosticsLevel } from "./diagnostics";
import { appendDiagnostic } from "./diagnostics.server";
import { type Grid, isGridConfigured } from "./grid";
import { readGrid } from "./grid.server";
import type { HaState } from "./ha.server";
import { onHaChange } from "./ha-live.server";
import { type BatterySnapshot, planNetZero } from "./net-zero";
import { toNumber, toRange } from "./readings.server";
import { describeWrites, writeSetpoints } from "./setpoints.server";
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

type LoopState = {
  /** The idle heartbeat. Its presence is also what "the loop is running" means. */
  timer: ReturnType<typeof setInterval> | null;
  /** Unsubscribes from Home Assistant's changes; null when the loop is stopped. */
  unsubscribe: (() => void) | null;
  config: ControlConfig | null;
  /** The tick currently awaiting Home Assistant, if any. Doubles as the overlap guard. */
  inFlight: Promise<void> | null;
  lastTickAt: string | null;
  /** When the last tick started, for the rate limit — monotonic-ish, not for display. */
  lastTickStartedAt: number | null;
  /** Set when changes arrived too soon after a tick and one is owed. */
  trailing: ReturnType<typeof setTimeout> | null;
  /** The entities whose changes should provoke a tick. */
  watched: Set<string>;
};

const state: LoopState = {
  timer: null,
  unsubscribe: null,
  config: null,
  inFlight: null,
  lastTickAt: null,
  lastTickStartedAt: null,
  trailing: null,
  watched: new Set(),
};

/** Everything this module logs is battery control's; the origin never varies. */
function logControl(level: DiagnosticsLevel, message: string): void {
  appendDiagnostic("battery-control", level, message);
}

/** The stored configuration a tick's entity lists and its snapshots share. */
type TickConfig = {
  grid: Grid;
  batteries: Battery[];
};

async function readTickConfig(): Promise<TickConfig> {
  const [grid, batteries] = await Promise.all([readGrid(), listBatteries()]);

  return { grid, batteries };
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
 * Deliberately **not** the target power entities. This is also the set whose
 * changes provoke a tick, and a target is an output, not a reading: watching it
 * would mean every setpoint we write comes back as a change, provokes another
 * tick, and writes again — a feedback loop with nothing damping it. It is also
 * what "oldest reading" is measured over, and a setpoint nobody has touched for
 * hours would dominate that number while saying nothing about whether the
 * sensors are alive.
 */
function controlReadingIds({ grid, batteries }: TickConfig): string[] {
  return [
    ...(isGridConfigured(grid) ? [grid.powerEntityId] : []),
    ...batteries.flatMap((battery) => [
      battery.socEntityId,
      battery.powerEntityId,
    ]),
  ].filter(Boolean);
}

/**
 * The target entities, read for their `min`/`max` rather than their value:
 * those are what bound the setpoint when settings don't. From the same
 * `TickConfig` as the readings, so the batteries written to and the batteries
 * decided about cannot come from two different reads of the store.
 *
 * Unconfigured ids are dropped, so a battery that isn't steered costs nothing.
 */
function controlTargetIds({ batteries }: TickConfig): string[] {
  return batteries
    .map((battery) => battery.targetPowerEntityId)
    .filter(Boolean);
}

/**
 * Everything the strategies need, read fresh each tick.
 *
 * Through the same reader the dashboard uses, so a decision and the page agree
 * about what the house is doing: the live subscription answers from memory, and
 * REST covers the moment before it is up. The fan-out of one request per entity
 * is now the exception rather than every tick.
 */
async function readSnapshots(): Promise<{
  gridPowerW: number | null;
  batteries: BatterySnapshot[];
  gridConfigured: boolean;
  provenance: string;
  /** Each steerable battery's target entity and its state, ready to be written. */
  targets: Map<string, { entityId: string; state: HaState | null }>;
}> {
  const config = await readTickConfig();
  const { grid, batteries } = config;
  const gridConfigured = isGridConfigured(grid);

  const readingIds = controlReadingIds(config);
  const { states, error } = await readStates([
    ...readingIds,
    ...controlTargetIds(config),
  ]);

  // The page can render dashes when Home Assistant is unreachable; a decision
  // cannot be made out of them. Raising it here turns the outage into one
  // "Tick failed" line and keeps the schedule, rather than a stream of ticks
  // that read like the house is idle when the truth is that nobody asked it.
  if (error) throw new Error(error);

  const stateOf = (id: string) => states.get(id)?.state ?? null;

  // Provenance over the readings alone, for the reason `controlReadingIds`
  // gives: a target's age says nothing about whether the house is being
  // observed, and being static it would always be the oldest thing here.
  const readings = new Map(
    readingIds.flatMap((id) => {
      const read = states.get(id);
      return read ? [[id, read] as const] : [];
    }),
  );

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
      ...resolvePowerLimits(
        battery,
        battery.targetPowerEntityId
          ? toRange(stateOf(battery.targetPowerEntityId))
          : null,
      ),
    })),
    provenance: describeSource(readings),
    targets: new Map(
      batteries.filter(isSteerable).map((battery) => [
        battery.id,
        {
          entityId: battery.targetPowerEntityId,
          state: stateOf(battery.targetPowerEntityId),
        },
      ]),
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

/**
 * One pass of the strategy. Exported so tests can drive it directly instead of
 * waiting on a clock, and so a tick can be forced from the UI.
 */
export async function runControlTick(): Promise<void> {
  const inputs = await readSnapshots();

  if (!inputs.gridConfigured) {
    logControl(
      "warn",
      "The grid sensor is not configured — nothing to balance against.",
    );
    state.lastTickAt = new Date().toISOString();
    return;
  }

  const plan = planNetZero(inputs);

  // One entry for the whole tick, not one per line. A house that isn't doing
  // anything produces the same summary and the same per-battery decision every
  // few seconds; logged separately they interleave, so the log's
  // repeated-line collapsing never gets two identical entries in a row and the
  // buffer fills with near-duplicates instead of holding useful history.
  // Written before the decision is logged, so that a line saying what was
  // decided and a line saying what was done cannot end up in the other order.
  const writes = await writeSetpoints(
    plan.decisions.flatMap((decision) => {
      const target = inputs.targets.get(decision.batteryId);
      if (!target) return [];
      return [
        {
          batteryId: decision.batteryId,
          title: decision.title,
          entityId: target.entityId,
          state: target.state,
          commandW: decision.commandW,
        },
      ];
    }),
  );

  const written = describeWrites(writes);

  const lines = [
    `${plan.summary} (${inputs.provenance})`,
    ...plan.warnings.map((warning) => `! ${warning}`),
    ...plan.decisions.map((decision) => decision.message),
    ...(written ? [written] : []),
  ];

  const troubled = writes.some(
    (write) => write.status === "failed" || write.status === "unsupported",
  );
  logControl(
    plan.warnings.length > 0 || troubled ? "warn" : "info",
    lines.join("\n"),
  );

  state.lastTickAt = new Date().toISOString();
}

/**
 * Hands every steerable battery back by commanding 0, and waits for it.
 *
 * Called when control is switched off and when the process is asked to stop. A
 * battery left forcing kilowatts because the thing that told it to is gone is
 * the worst failure this feature has: from the battery's side there is no
 * difference between a setpoint that is still wanted and one whose author died
 * ten minutes ago.
 *
 * Zero is the safe value rather than the *correct* one, and the distinction is
 * worth being honest about. It stops the battery being driven in either
 * direction, which is safe on every inverter; it does not necessarily hand the
 * battery back to its own self-consumption logic, which on many brands means
 * putting a mode entity back rather than writing a power. That is the
 * mode-entity work, and until it exists this is the floor rather than the
 * finished thing.
 *
 * Nothing here can survive `kill -9`, a power cut, or a container the
 * supervisor destroys without asking. The only real answer to those is an
 * inverter whose forced mode expires on its own — a command timeout, which
 * some brands have and others do not.
 */
export async function releaseBatteries(): Promise<void> {
  const batteries = (await listBatteries()).filter(isSteerable);
  if (batteries.length === 0) return;

  const writes = await writeSetpoints(
    batteries.map((battery) => ({
      batteryId: battery.id,
      title: battery.title,
      entityId: battery.targetPowerEntityId,
      // No state, so the deadband cannot decide the entity already reads 0 and
      // skip: releasing is worth one unconditional write even when it is
      // probably redundant.
      state: null,
      commandW: 0,
    })),
  );

  const trouble = writes.filter((write) => write.status !== "written");
  logControl(
    trouble.length > 0 ? "error" : "info",
    trouble.length > 0
      ? `Released the batteries, but ${trouble
          .map((write) => `${write.title} (${write.detail ?? write.status})`)
          .join(", ")} did not take it — check it is not still being driven.`
      : `Released ${writes.length === 1 ? "the battery" : "the batteries"} to 0 W.`,
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
    logControl("warn", "Previous tick is still running — skipping this one.");
    return;
  }

  state.lastTickStartedAt = Date.now();
  state.inFlight = runControlTick()
    .catch((error: unknown) => {
      // Home Assistant restarting, a revoked token, a network blip: log it and
      // keep the schedule. A loop that dies on the first outage is worse than no
      // loop, because from the outside it still looks like it is working.
      const message = error instanceof Error ? error.message : String(error);
      logControl("error", `Tick failed: ${message}`);
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
 * Lets the batteries go when the add-on is asked to stop.
 *
 * Docker sends SIGTERM and then waits, which is exactly the window a last write
 * needs. Installed only once control has actually been switched on, so an
 * add-on nobody has configured adds no handlers, and with `once` so a second
 * signal during the release goes to the default handler and kills us anyway —
 * an operator asking twice should not be made to wait.
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
      void releaseBatteries().catch(() => {
        // Already logged where it happened, and there is nothing further to try
        // from inside a process that is on its way out.
      });
    });
  }
}

/**
 * Bring the loop in line with what settings say — start it, stop it, or restart
 * it under a new interval or strategy. Idempotent, so it is safe to call on
 * every save and at boot.
 */
export async function syncControlLoop(): Promise<ControlLoopStatus> {
  const config = await readControlConfig();
  const previous = state.config;
  state.config = config;

  if (!config.enabled) {
    if (state.timer) {
      stopControlLoop();
      logControl("info", "Battery control disabled — loop stopped.");
      // Waited for, not fired and forgotten: the settings form is still
      // sitting on this response, and "control is off" should not come back
      // before the batteries have actually been let go.
      await releaseBatteries();
    }
    return controlLoopStatus();
  }

  const changed =
    !previous ||
    previous.intervalSeconds !== config.intervalSeconds ||
    previous.strategy !== config.strategy;

  if (state.timer && !changed) return controlLoopStatus();

  stopControlLoop();
  logControl(
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

  // Tick once immediately so enabling the strategy produces a line at once
  // rather than after a silent interval.
  startTick();

  return controlLoopStatus();
}

export function controlLoopStatus(): ControlLoopStatus {
  const config = state.config;
  return {
    running: state.timer !== null,
    strategy: config?.strategy ?? "net-zero-energy",
    intervalSeconds: config?.intervalSeconds ?? 5,
    lastTickAt: state.lastTickAt,
  };
}

/** Test-only: forget everything this module remembers between cases. */
export function resetControlLoop(): void {
  stopControlLoop();
  state.config = null;
  state.inFlight = null;
  state.lastTickAt = null;
  state.lastTickStartedAt = null;
  state.watched = new Set();
}
