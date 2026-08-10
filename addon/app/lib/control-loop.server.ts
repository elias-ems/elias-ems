/**
 * The control loop: one interval in the add-on's Node process that, every
 * `intervalSeconds`, reads the grid and the batteries out of Home Assistant,
 * asks the configured strategy what the batteries should be doing, and writes
 * the answer to the debug log.
 *
 * It does not yet *tell* the batteries anything. Writing a setpoint is
 * inverter-specific — Modbus for some, a `number.*` entity or a brand
 * integration for others — and a control loop that has been watched deciding
 * correctly for a while is a far safer thing to hand that power to. The decision
 * and the actuation are separable, and this is the decision half.
 *
 * Module-level state is the right shape for it: the server build is loaded once
 * per process, so "one loop per add-on" and "one module instance" are the same
 * statement. (Under Vite's dev server a hot reload can drop the module and with
 * it the log; `npm run start:ingress` is the stack to watch it on.)
 */
import { listBatteries } from "./batteries.server";
import type { ControlConfig, ControlLoopStatus } from "./control";
import { readControlConfig } from "./control-config.server";
import { appendControlLog } from "./control-log.server";
import { isGridConfigured } from "./grid";
import { readGrid } from "./grid.server";
import { fetchHaState } from "./ha.server";
import { type BatterySnapshot, planNetZero } from "./net-zero";
import { toNumber } from "./readings.server";

type LoopState = {
  timer: ReturnType<typeof setInterval> | null;
  config: ControlConfig | null;
  /** The tick currently awaiting Home Assistant, if any. Doubles as the overlap guard. */
  inFlight: Promise<void> | null;
  lastTickAt: string | null;
};

const state: LoopState = {
  timer: null,
  config: null,
  inFlight: null,
  lastTickAt: null,
};

/** Everything the strategies need, read fresh each tick. */
async function readSnapshots(): Promise<{
  gridImportW: number | null;
  gridExportW: number | null;
  batteries: BatterySnapshot[];
  gridConfigured: boolean;
}> {
  const [grid, batteries] = await Promise.all([readGrid(), listBatteries()]);
  const gridConfigured = isGridConfigured(grid);

  // One round of requests rather than a serial walk: at a five-second interval
  // a handful of sequential fetches would eat a visible slice of the budget.
  const [gridImport, gridExport, batteryStates] = await Promise.all([
    gridConfigured ? fetchHaState(grid.importEntityId) : null,
    gridConfigured ? fetchHaState(grid.exportEntityId) : null,
    Promise.all(
      batteries.map(async (battery) => {
        const [soc, power] = await Promise.all([
          fetchHaState(battery.socEntityId),
          fetchHaState(battery.powerEntityId),
        ]);
        return { battery, soc, power };
      }),
    ),
  ]);

  return {
    gridConfigured,
    gridImportW: toNumber(gridImport),
    gridExportW: toNumber(gridExport),
    batteries: batteryStates.map(({ battery, soc, power }) => ({
      id: battery.id,
      title: battery.title,
      capacityKwh: battery.capacityKwh,
      minChargePercent: battery.minChargePercent,
      maxChargePercent: battery.maxChargePercent,
      socPercent: toNumber(soc),
      powerW: toNumber(power),
    })),
  };
}

/**
 * One pass of the strategy. Exported so tests can drive it directly instead of
 * waiting on a clock, and so a tick can be forced from the UI.
 */
export async function runControlTick(): Promise<void> {
  const inputs = await readSnapshots();

  if (!inputs.gridConfigured) {
    appendControlLog(
      "warn",
      "Grid sensors are not configured — nothing to balance against.",
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
  const lines = [
    plan.summary,
    ...plan.warnings.map((warning) => `! ${warning}`),
    ...plan.decisions.map((decision) => decision.message),
  ];

  appendControlLog(
    plan.warnings.length > 0 ? "warn" : "info",
    lines.join("\n"),
  );

  state.lastTickAt = new Date().toISOString();
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
    appendControlLog(
      "warn",
      "Previous tick is still running — skipping this one.",
    );
    return;
  }

  state.inFlight = runControlTick()
    .catch((error: unknown) => {
      // Home Assistant restarting, a revoked token, a network blip: log it and
      // keep the schedule. A loop that dies on the first outage is worse than no
      // loop, because from the outside it still looks like it is working.
      const message = error instanceof Error ? error.message : String(error);
      appendControlLog("error", `Tick failed: ${message}`);
    })
    .finally(() => {
      state.inFlight = null;
    });
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
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
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
      appendControlLog("info", "Battery control disabled — loop stopped.");
    }
    return controlLoopStatus();
  }

  const changed =
    !previous ||
    previous.intervalSeconds !== config.intervalSeconds ||
    previous.strategy !== config.strategy;

  if (state.timer && !changed) return controlLoopStatus();

  stopControlLoop();
  appendControlLog(
    "info",
    `Battery control enabled — ${config.strategy} every ${config.intervalSeconds}s.`,
  );

  state.timer = setInterval(startTick, config.intervalSeconds * 1000);
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
}
