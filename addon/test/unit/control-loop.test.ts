/**
 * The loop, against the mock Home Assistant. What matters here is not the
 * arithmetic — net-zero.test.ts owns that — but the scheduling: that it runs
 * when a reading it cares about moves, no more often than it was told to, and
 * that it survives the things that will actually go wrong in a house.
 *
 * Two clocks in play, deliberately. The event-driven cases run on the real one,
 * because they turn on a WebSocket message arriving and no fake timer can hurry
 * real I/O along; the cases about elapsed time use fake timers with the
 * subscription pointed somewhere unreachable, so the loop is on its REST path
 * and nothing is waiting on a socket.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  addBattery,
  listBatteries,
  removeBattery,
} from "../../app/lib/batteries.server";
import { saveControlConfig } from "../../app/lib/control-config.server";
import {
  pendingControlTick,
  resetControlLoop,
  runControlTick,
  syncControlLoop,
} from "../../app/lib/control-loop.server";
import {
  clearDiagnostics,
  readDiagnostics,
} from "../../app/lib/diagnostics.server";
import { saveGrid } from "../../app/lib/grid.server";
import {
  haLiveStatus,
  startHaLive,
  stopHaLive,
} from "../../app/lib/ha-live.server";
import { defaultStates, startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;
let dataDir: string;

/** Nothing listens on port 1, so a request there fails immediately. */
const UNREACHABLE_API = "http://127.0.0.1:1/core/api";
const UNREACHABLE_WS = "ws://127.0.0.1:1/core/websocket";

/** Brings the subscription up and waits for its seed, for the live-path cases. */
async function subscribe(): Promise<void> {
  process.env.SUPERVISOR_WS = ha.wsUrl;
  startHaLive();
  await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));
}

const GRID = { powerEntityId: "sensor.grid_power" };

const BATTERY = {
  title: "Home battery",
  capacityKwh: 10,
  minChargePercent: 10,
  maxChargePercent: 90,
  energyEntityId: "sensor.battery_energy_total",
  powerEntityId: "sensor.battery_power",
  socEntityId: "sensor.battery_state_of_charge",
  // Unsteered by default, so the cases below are about scheduling and not
  // about a power limit quietly cutting the setpoint they assert on.
  targetPowerEntityId: "",
  maxChargePowerW: null,
  maxDischargePowerW: null,
};

/** Every message currently in the log, oldest first, for readable assertions. */
function messages(): string[] {
  return readDiagnostics()
    .reverse()
    .map((entry) => entry.message);
}

function logged(fragment: string): boolean {
  return messages().some((message) => message.includes(fragment));
}

/**
 * How many ticks have produced a decision. Each tick is one entry, and identical
 * consecutive entries collapse into a repeat count, so counting means summing
 * those rather than counting rows.
 */
function decisionTicks(): number {
  return readDiagnostics()
    .filter((entry) => entry.message.startsWith("Grid net"))
    .reduce((total, entry) => total + entry.repeat, 0);
}

/**
 * Moves the fake clock on and then waits for the tick it started to finish
 * talking to Home Assistant. Advancing the clock alone only schedules the tick;
 * the fetch behind it is real I/O that no fake timer can hurry along.
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await pendingControlTick();
}

beforeAll(async () => {
  ha = await startHaMock();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "elias-ems-loop-"));
  process.env.SUPERVISOR_TOKEN = ha.token;
  process.env.DATA_DIR = dataDir;
});

afterAll(async () => {
  await ha.close();
  await rm(dataDir, { recursive: true, force: true });
  delete process.env.SUPERVISOR_TOKEN;
  delete process.env.SUPERVISOR_API;
  delete process.env.DATA_DIR;
});

beforeEach(async () => {
  process.env.SUPERVISOR_API = ha.apiUrl;
  // Unreachable unless a case asks for the subscription: the loop's REST path
  // is what most of these are about, and a socket nobody wanted would only add
  // reconnect timers to whatever clock the case is running.
  process.env.SUPERVISOR_WS = UNREACHABLE_WS;
  ha.setStates(await defaultStates());
  for (const battery of await listBatteries()) await removeBattery(battery.id);
  await saveGrid(GRID);
  clearDiagnostics();
  resetControlLoop();
});

afterEach(() => {
  // Order matters: the loop has to be torn down while its fake timers still
  // exist, or the interval outlives the clock that was driving it.
  resetControlLoop();
  stopHaLive();
  vi.useRealTimers();
});

describe("runControlTick", () => {
  it("logs the decision for the configured battery", async () => {
    await addBattery(BATTERY);

    await runControlTick();

    // The fixture imports 842 W with the battery idle, so it should discharge.
    expect(logged("Grid net +842 W (importing)")).toBe(true);
    expect(logged("Home battery: discharge at 842 W")).toBe(true);
  });

  it("says the grid is not configured rather than deciding blind", async () => {
    await saveGrid({ powerEntityId: "" });
    await addBattery(BATTERY);

    await runControlTick();

    expect(logged("The grid sensor is not configured")).toBe(true);
  });

  it("reports an unavailable battery sensor instead of guessing at it", async () => {
    await addBattery({ ...BATTERY, socEntityId: "sensor.shed_inverter_power" });

    await runControlTick();

    expect(logged("state of charge unknown")).toBe(true);
  });

  it("caps the setpoint at the target entity's own range", async () => {
    // Nothing is typed into settings, so the entity is the only thing that can
    // produce a cap. The fixture's number.battery_target_power has a -500 W
    // floor — deliberately tighter than the 842 W the meter is asking for, so
    // that a range which never reached the strategy would be visible here.
    await addBattery({
      ...BATTERY,
      targetPowerEntityId: "number.battery_target_power",
    });

    await runControlTick();

    expect(logged("discharge at 500 W, capped from 842 W")).toBe(true);
  });

  it("lets a configured cap override the entity's range rather than narrow it", async () => {
    await addBattery({
      ...BATTERY,
      targetPowerEntityId: "number.battery_target_power",
      maxDischargePowerW: 5000,
    });

    await runControlTick();

    // 5000 W beats the entity's -500 W floor, so the full 842 W goes through.
    expect(logged("discharge at 842 W")).toBe(true);
    expect(logged("capped from")).toBe(false);
  });
});

describe("syncControlLoop", () => {
  it("does not start a loop while control is disabled", async () => {
    await saveControlConfig({
      enabled: false,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });

    const status = await syncControlLoop();

    expect(status.running).toBe(false);
    expect(messages()).toEqual([]);
  });

  it("ticks at once when it is switched on", async () => {
    vi.useFakeTimers();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });

    const status = await syncControlLoop();
    expect(status.running).toBe(true);
    expect(status.intervalSeconds).toBe(5);

    // Someone who has just enabled the strategy should not have to wait for the
    // house to do something before finding out whether it works.
    await pendingControlTick();
    expect(decisionTicks()).toBe(1);
  });

  it("ticks when a reading it watches moves, without waiting for a clock", async () => {
    await subscribe();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 1,
    });

    await syncControlLoop();
    await pendingControlTick();
    expect(logged("importing")).toBe(true);
    clearDiagnostics();

    // Home Assistant says the meter has swung to export. Nothing here asks it
    // anything; the decision is a consequence of being told.
    ha.setState("sensor.grid_power", "-1500", { unit_of_measurement: "W" });

    await vi.waitFor(() => expect(logged("exporting")).toBe(true), {
      timeout: 5_000,
    });
  });

  it("ignores changes to entities it doesn't use", async () => {
    await subscribe();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 1,
    });
    await syncControlLoop();
    await pendingControlTick();

    const before = decisionTicks();
    // A light in the hallway is a state change like any other. Every one of
    // them reaching the strategy would make the loop as busy as the house.
    ha.setState("light.hallway", "on", {});

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(decisionTicks()).toBe(before);
  });

  it("holds to its interval under a burst, and still acts on the last change", async () => {
    await subscribe();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 2,
    });
    await syncControlLoop();
    await pendingControlTick();

    const before = decisionTicks();

    // Three changes inside the window that the tick above just opened. An
    // inverter and its meter reporting together look exactly like this.
    ha.setState("sensor.grid_power", "100", { unit_of_measurement: "W" });
    ha.setState("sensor.grid_power", "200", { unit_of_measurement: "W" });
    ha.setState("sensor.grid_power", "-3000", { unit_of_measurement: "W" });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(decisionTicks(), "the rate limit should still be holding").toBe(
      before,
    );

    // And when it lifts, exactly one tick — on the newest reading, not the one
    // that happened to arrive first.
    await vi.waitFor(() => expect(decisionTicks()).toBe(before + 1), {
      timeout: 5_000,
    });
    expect(logged("Grid net -3000 W (exporting)")).toBe(true);
  });

  it("keeps ticking when nothing in the house is moving", async () => {
    vi.useFakeTimers();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await syncControlLoop();
    await pendingControlTick();

    const before = decisionTicks();

    // Nothing has changed, so nothing has been pushed. Without the idle tick a
    // living loop and a dead one would look identical from the log.
    await advance(61_000);

    expect(decisionTicks()).toBe(before + 1);
  });

  it("stops the loop when control is switched off", async () => {
    vi.useFakeTimers();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await syncControlLoop();
    await pendingControlTick();

    await saveControlConfig({
      enabled: false,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    const status = await syncControlLoop();

    expect(status.running).toBe(false);
    expect(logged("loop stopped")).toBe(true);

    // And it really is stopped, not merely reported as such.
    const before = decisionTicks();
    await advance(30_000);
    expect(decisionTicks()).toBe(before);
  });

  it("picks up a changed interval", async () => {
    await subscribe();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 60,
    });
    await syncControlLoop();
    await pendingControlTick();

    // Under the old sixty-second limit this change would wait a minute.
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 1,
    });
    await syncControlLoop();
    await pendingControlTick();
    clearDiagnostics();

    ha.setState("sensor.grid_power", "-1500", { unit_of_measurement: "W" });

    await vi.waitFor(() => expect(logged("exporting")).toBe(true), {
      timeout: 5_000,
    });
  });

  it("leaves a running loop alone when nothing about it changed", async () => {
    vi.useFakeTimers();
    await addBattery(BATTERY);
    const config = {
      enabled: true,
      strategy: "net-zero-energy" as const,
      intervalSeconds: 5,
    };
    await saveControlConfig(config);
    await syncControlLoop();
    await pendingControlTick();

    // Saving an unrelated settings section calls this again. Restarting the
    // interval every time would let a busy settings page starve the loop.
    clearDiagnostics();
    await syncControlLoop();
    await pendingControlTick();

    expect(messages()).toEqual([]);
  });

  it("keeps its schedule when Home Assistant is unreachable", async () => {
    vi.useFakeTimers();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    process.env.SUPERVISOR_API = UNREACHABLE_API;

    await syncControlLoop();
    await pendingControlTick();
    expect(logged("Tick failed")).toBe(true);

    // A loop that dies on the first outage is worse than none, because from the
    // outside it still looks like it is working.
    process.env.SUPERVISOR_API = ha.apiUrl;
    await advance(61_000);

    expect(logged("Grid net +842 W (importing)")).toBe(true);
  });
});

describe("where a tick's numbers came from", () => {
  it("says REST, and how old the readings were, when there is no subscription", async () => {
    await addBattery(BATTERY);

    await runControlTick();

    expect(logged("via REST")).toBe(true);
    expect(logged("oldest reading")).toBe(true);
  });

  it("reads the cache without asking Home Assistant again", async () => {
    await subscribe();
    await addBattery(BATTERY);

    const before = ha.requests.length;
    await runControlTick();

    expect(logged("via live cache")).toBe(true);
    // The point of the whole exercise: a decision that costs no round trip.
    expect(ha.requests.length).toBe(before);
  });
});

describe("what it writes to diagnostics", () => {
  it("collapses a repeated line instead of filling the buffer with it", async () => {
    await saveGrid({ powerEntityId: "" });

    await runControlTick();
    await runControlTick();
    await runControlTick();

    const entries = readDiagnostics();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ repeat: 3, level: "warn" });
  });

  it("files everything under the battery-control origin", async () => {
    // The Tools page shows every feature's entries in one list, so an entry
    // that did not say where it came from would be unattributable there.
    await addBattery(BATTERY);

    await runControlTick();

    expect(readDiagnostics().map((entry) => entry.origin)).toEqual([
      "battery-control",
    ]);
  });
});
