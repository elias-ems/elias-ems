/**
 * The loop, on a fake clock against the mock Home Assistant. What matters here
 * is not the arithmetic — net-zero.test.ts owns that — but the scheduling: that
 * it only runs when it is meant to, at the interval it was told, and that it
 * survives the things that will actually go wrong in a house.
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
  clearControlLog,
  readControlLog,
} from "../../app/lib/control-log.server";
import {
  pendingControlTick,
  resetControlLoop,
  runControlTick,
  syncControlLoop,
} from "../../app/lib/control-loop.server";
import { saveGrid } from "../../app/lib/grid.server";
import { defaultStates, startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;
let dataDir: string;

/** Nothing listens on port 1, so a request there fails immediately. */
const UNREACHABLE_API = "http://127.0.0.1:1/core/api";

const GRID = { powerEntityId: "sensor.grid_power" };

const BATTERY = {
  title: "Home battery",
  capacityKwh: 10,
  minChargePercent: 10,
  maxChargePercent: 90,
  energyEntityId: "sensor.battery_energy_total",
  powerEntityId: "sensor.battery_power",
  socEntityId: "sensor.battery_state_of_charge",
};

/** Every message currently in the log, oldest first, for readable assertions. */
function messages(): string[] {
  return readControlLog()
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
  return readControlLog()
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
  ha.setStates(await defaultStates());
  for (const battery of await listBatteries()) await removeBattery(battery.id);
  await saveGrid(GRID);
  clearControlLog();
  resetControlLoop();
});

afterEach(() => {
  // Order matters: the loop has to be torn down while its fake timers still
  // exist, or the interval outlives the clock that was driving it.
  resetControlLoop();
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

  it("starts, ticks immediately, and then ticks on the interval", async () => {
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

    // The first tick fires at once: someone who has just enabled the strategy
    // should not have to wait a silent interval to see whether it works.
    await pendingControlTick();
    expect(decisionTicks()).toBe(1);

    // Four seconds is not yet due; the fifth is.
    await advance(4_000);
    expect(decisionTicks()).toBe(1);

    await advance(1_500);
    expect(decisionTicks()).toBe(2);
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
    vi.useFakeTimers();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 60,
    });
    await syncControlLoop();
    await pendingControlTick();

    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await syncControlLoop();
    await pendingControlTick();
    clearControlLog();

    await advance(5_500);
    await advance(5_000);

    // Two more ticks inside eleven seconds, which the old sixty-second schedule
    // would not have produced.
    expect(decisionTicks()).toBe(2);
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
    clearControlLog();
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
    await advance(5_500);

    expect(logged("Grid net +842 W (importing)")).toBe(true);
  });
});

describe("the log itself", () => {
  it("collapses a repeated line instead of filling the buffer with it", async () => {
    await saveGrid({ powerEntityId: "" });

    await runControlTick();
    await runControlTick();
    await runControlTick();

    const entries = readControlLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ repeat: 3, level: "warn" });
  });
});
