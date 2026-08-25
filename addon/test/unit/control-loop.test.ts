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
import { DEFAULT_CURTAILMENT_CONFIG } from "../../app/lib/curtailment";
import { saveCurtailmentConfig } from "../../app/lib/curtailment-config.server";
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
import { DEFAULT_PRICE_CONFIG } from "../../app/lib/prices";
import { savePriceConfig } from "../../app/lib/prices.server";
import {
  addPvEntity,
  listPvEntities,
  removePvEntity,
} from "../../app/lib/pv-entities.server";
import { REASSERT_MS } from "../../app/lib/pv-limits.server";
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

/** 1234.5 W in the fixture, against a 5 kW inverter. */
const PV_ARRAY = {
  title: "South roof",
  powerEntityId: "sensor.inverter_power",
  energyEntityId: "sensor.inverter_energy_total",
  ratedPowerW: 5000,
  curtailable: true,
};

/**
 * Prices whose *sign* is fixed regardless of when the suite runs.
 *
 * The mock's price series is a real-shaped day, so what it says right now
 * depends on the wall clock — which is exactly what a test must not depend on.
 * A production formula with a large constant in it puts the injection price
 * unambiguously on one side of the threshold whatever the spot happens to be,
 * and it exercises the thing that actually decides: the production leg with the
 * contract applied, not the exchange price.
 */
const PRICES = (productionFormula: string) => ({
  source: "home-assistant" as const,
  forecastEntityId: "sensor.energi_epex_spot",
  consumptionFormula: "price",
  productionFormula,
});

const NEGATIVE_INJECTION = PRICES("price - 10");
const POSITIVE_INJECTION = PRICES("price + 10");

/** Curtailment on, and acting at once unless a case is about the settle rule. */
const CURTAILMENT = {
  ...DEFAULT_CURTAILMENT_CONFIG,
  enabled: true,
  settleSeconds: 0,
};

const BATTERY = {
  title: "Home battery",
  capacityKwh: 10,
  minChargePercent: 10,
  maxChargePercent: 90,
  energyEntityId: "sensor.battery_energy_total",
  powerEntityId: "sensor.battery_power",
  socEntityId: "sensor.battery_state_of_charge",
  // Steered, since an unsteered battery sits out of every plan and these
  // cases are about scheduling.
  steered: true,
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

/** Every target published so far, as [event type, watts] pairs, in order. */
function targetEvents(): Array<[string, unknown]> {
  return ha.events
    .filter((event) => event.eventType.endsWith("_target_power"))
    .map((event) => [
      event.eventType,
      (event.data as { power_w?: unknown }).power_w,
    ]);
}

/** The same for PV limits, as [event type, percent, released] triples. */
function pvLimitEvents(): Array<[string, unknown, unknown]> {
  return ha.events
    .filter((event) => event.eventType.endsWith("_pv_limit"))
    .map((event) => [
      event.eventType,
      (event.data as { limit_percent?: unknown }).limit_percent,
      (event.data as { released?: unknown }).released,
    ]);
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
  ha.events.length = 0;
  for (const battery of await listBatteries()) await removeBattery(battery.id);
  for (const entity of await listPvEntities()) await removePvEntity(entity.id);
  await saveGrid(GRID);
  await savePriceConfig(DEFAULT_PRICE_CONFIG);
  // Each tick now gates its halves on what is stored, so that switching a
  // feature on or off takes effect without restarting the loop. These cases are
  // battery control's, so that is what is on; the `syncControlLoop` cases below
  // save their own config over this one.
  await saveControlConfig({
    enabled: true,
    strategy: "net-zero-energy",
    intervalSeconds: 5,
  });
  await saveCurtailmentConfig({
    ...DEFAULT_CURTAILMENT_CONFIG,
    enabled: false,
  });
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

  it("publishes the target it decided on, under the battery's own event", async () => {
    await addBattery(BATTERY);

    await runControlTick();

    // The fixture imports 842 W with the battery idle, so the decision is to
    // discharge 842 W.
    expect(targetEvents()).toEqual([
      ["elias_ems_home_battery_target_power", -842],
    ]);
    expect(logged("Published: Home battery → -842 W")).toBe(true);
  });

  it("does not publish again while the target has not moved", async () => {
    await addBattery(BATTERY);

    await runControlTick();
    await runControlTick();

    // The second tick decides the same thing and finds nothing worth saying.
    // Without this the loop would fire an event every tick, and on the other
    // end of each one is an automation writing to real hardware.
    expect(targetEvents()).toHaveLength(1);
  });

  it("says nothing at all when the grid is inside the deadband", async () => {
    // A hold reports the battery's *measured* power as its target, which is
    // the right thing to show and the wrong thing to command: publishing a
    // measurement back would let sensor noise walk the commanded value around.
    ha.setState("sensor.grid_power", "4", { unit_of_measurement: "W" });
    await addBattery(BATTERY);

    await runControlTick();

    expect(logged("deadband")).toBe(true);
    expect(targetEvents()).toEqual([]);
  });

  it("cancels a standing command when the grid sensor cannot be read", async () => {
    // The blind case. A battery left forcing kilowatts because the meter it
    // was following went unreadable is the one hold that must not persist.
    await addBattery(BATTERY);
    await runControlTick();
    ha.setState("sensor.grid_power", "unavailable", {});
    ha.events.length = 0;

    await runControlTick();

    expect(logged("grid power sensor is not readable")).toBe(true);
    expect(targetEvents()).toEqual([
      ["elias_ems_home_battery_target_power", 0],
    ]);
  });

  it("caps the target at the configured discharge limit", async () => {
    // Settings are the only source of a limit now that nothing is written to
    // an entity, so a cap that never reached the strategy would be visible
    // here: the meter is asking for 842 W and the inverter can do 500 W.
    await addBattery({ ...BATTERY, maxDischargePowerW: 500 });

    await runControlTick();

    expect(logged("discharge at 500 W, capped from 842 W")).toBe(true);
  });

  it("leaves a battery with no limits uncapped", async () => {
    await addBattery(BATTERY);

    await runControlTick();

    expect(logged("discharge at 842 W")).toBe(true);
    expect(logged("capped from")).toBe(false);
  });
});

describe("runControlTick, curtailment half", () => {
  /** Curtailment on and battery control off — the two are independent. */
  async function onlyCurtailment(
    prices = NEGATIVE_INJECTION,
    config = CURTAILMENT,
  ): Promise<void> {
    await addPvEntity(PV_ARRAY);
    await savePriceConfig(prices);
    await saveControlConfig({
      enabled: false,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await saveCurtailmentConfig(config);
  }

  it("holds the array back to what the house can absorb", async () => {
    await onlyCurtailment();

    await runControlTick();

    // The fixture generates 1234.5 W while importing 842 W, so the house can
    // take 2076.5 W — 42% of a 5000 W inverter.
    expect(logged("arrays at 1235 W → allow 2077 W total")).toBe(true);
    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 42, false],
    ]);
  });

  it("decides on the injection price, not the exchange price", async () => {
    // The formula is what turns the mock's positive spot into a negative
    // earning and back. Reading the raw price instead would get this backwards
    // for anyone whose contract charges a fee per exported kWh.
    await onlyCurtailment(POSITIVE_INJECTION);

    await runControlTick();

    expect(logged("nothing to curtail")).toBe(true);
    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 100, true],
    ]);
  });

  it("runs with battery control switched off, and publishes no targets", async () => {
    await addBattery(BATTERY);
    await onlyCurtailment();

    await runControlTick();

    // A house with panels and no interest in steering its battery is an
    // ordinary configuration, and the loop has to serve it without the other
    // half deciding anything.
    expect(pvLimitEvents()).toHaveLength(1);
    expect(targetEvents()).toEqual([]);
  });

  it("does not publish again while the limit has not moved", async () => {
    await onlyCurtailment();

    await runControlTick();
    await runControlTick();

    // On the other end of each event is an automation writing to real
    // hardware, which on some brands commits to flash.
    expect(pvLimitEvents()).toHaveLength(1);
  });

  it("stays quiet for hours once a standing limit is being obeyed", async () => {
    vi.useFakeTimers();
    await onlyCurtailment();

    await runControlTick();
    expect(pvLimitEvents()).toHaveLength(1);

    // Six hours of a house doing exactly what it was told. This used to
    // restate the same limit every 30 seconds — some 720 identical events
    // across this span, every one of them landing in Home Assistant's
    // activity log, which is where somebody is trying to read what actually
    // happened in their house.
    for (let hour = 0; hour < 6; hour++) {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await runControlTick();
    }

    expect(pvLimitEvents()).toHaveLength(1);
  });

  it("stays quiet for hours while prices are fine and the arrays are released", async () => {
    vi.useFakeTimers();
    await onlyCurtailment(POSITIVE_INJECTION);

    await runControlTick();
    // One event to say "generate freely", and then nothing.
    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 100, true],
    ]);

    // The bulk of the noise, and the reason this matters: injection prices are
    // positive most of the year, so this — not curtailing — is what an array
    // spends almost all of its life doing.
    for (let hour = 0; hour < 6; hour++) {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await runControlTick();
    }

    expect(pvLimitEvents()).toHaveLength(1);
  });

  it("restates a limit the array turns out not to be obeying", async () => {
    vi.useFakeTimers();
    await onlyCurtailment();

    await runControlTick();
    expect(pvLimitEvents()).toHaveLength(1);

    // The inverter forgets its limit and goes back to full output. The meter
    // swings to export by the same amount, so `C + (G - G_target)` lands on the
    // *identical* 42% and the plan sees nothing wrong — 1234.5 + 842 and
    // 4800 - 2724 are the same number. Measured power is the only thing that
    // gives it away, which is exactly why the check reads it.
    ha.setState("sensor.inverter_power", "4800", { unit_of_measurement: "W" });
    ha.setState("sensor.grid_power", "-2724", { unit_of_measurement: "W" });
    await vi.advanceTimersByTimeAsync(REASSERT_MS);

    await runControlTick();

    expect(pvLimitEvents()).toHaveLength(2);
    expect(logged("the array is not obeying it")).toBe(true);
  });

  it("waits for the meter to settle before moving the limit", async () => {
    vi.useFakeTimers();
    await onlyCurtailment(NEGATIVE_INJECTION, {
      ...DEFAULT_CURTAILMENT_CONFIG,
      enabled: true,
      settleSeconds: 30,
    });

    await runControlTick();

    // This is the window in which battery control would be ramping. Cutting
    // now would throw away a surplus the battery was about to take.
    expect(logged("settling, 0s of 30s")).toBe(true);
    expect(pvLimitEvents()).toEqual([]);

    await vi.advanceTimersByTimeAsync(31_000);
    await runControlTick();

    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 42, false],
    ]);
  });

  it("waits again after moving a limit, not only before the first move", async () => {
    vi.useFakeTimers();
    await onlyCurtailment(NEGATIVE_INJECTION, {
      ...DEFAULT_CURTAILMENT_CONFIG,
      enabled: true,
      settleSeconds: 30,
    });

    await runControlTick();
    await vi.advanceTimersByTimeAsync(31_000);
    await runControlTick();
    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 42, false],
    ]);

    // The meter swings further out, and the obvious reading of it is that the
    // array should be cut to the floor. But the inverter has not finished
    // ramping to the 42% it was told a moment ago, and the grid and PV sensors
    // do not update together — so acting on this now would be counting the
    // last correction twice rather than measuring a new excursion.
    ha.setState("sensor.grid_power", "-1500", { unit_of_measurement: "W" });
    ha.events.length = 0;

    await runControlTick();

    expect(messages().at(-1)).toContain("settling, 0s of 30s");
    expect(pvLimitEvents()).toEqual([]);

    // And once the wait is served it acts on whatever is true by then.
    await vi.advanceTimersByTimeAsync(31_000);
    await runControlTick();

    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 5, false],
    ]);
  });

  /**
   * The mock's day-ahead curve swings between about -0.045 and 0.225, so a band
   * anchored near zero would drift in and out of range depending on the time of
   * day the suite runs. These two put the threshold far below the injection
   * price and the edges far above it, which lands the price in the first band
   * whatever the clock says.
   */
  const BANDED = (
    strategy: "soft-ceiling" | "graded-export",
    exportPercent: number,
  ) => ({
    ...DEFAULT_CURTAILMENT_CONFIG,
    enabled: true,
    settleSeconds: 0,
    strategy,
    priceThresholdPerKwh: -11,
    bands: [
      { abovePerKwh: 2, ceilingPercent: 70, exportPercent },
      { abovePerKwh: 3, ceilingPercent: 80, exportPercent: 100 },
      { abovePerKwh: 4, ceilingPercent: 90, exportPercent: 100 },
    ],
  });

  it("publishes a soft ceiling without ever reading the meter", async () => {
    await onlyCurtailment(NEGATIVE_INJECTION, BANDED("soft-ceiling", 40));
    // The one strategy that still decides with the meter gone, which is the
    // whole of what it buys by not using it.
    ha.setState("sensor.grid_power", "unavailable", {});

    await runControlTick();

    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 70, false],
    ]);
    expect(logged("Soft ceiling")).toBe(true);
  });

  it("moves the target rather than the law under graded export", async () => {
    await onlyCurtailment(NEGATIVE_INJECTION, BANDED("graded-export", 40));

    await runControlTick();

    // Same feedback law, one different number in it: 40% of the 5000 W rating
    // is 2000 W of permitted export, so the target moves from 0 to -2000 W and
    // 1234.5 + (842 + 2000) is 4076 W — 82% rather than the 42% the same house
    // gets below the threshold.
    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 82, false],
    ]);
    expect(logged("up to 2000 W may cross the meter")).toBe(true);
  });

  it("releases the array rather than guessing when the grid goes unreadable", async () => {
    await onlyCurtailment();
    await runControlTick();
    ha.setState("sensor.grid_power", "unavailable", {});
    ha.events.length = 0;

    await runControlTick();

    // Fail open, and the opposite of what battery control does when blind: an
    // array left pinned loses a sunny day with nothing looking wrong.
    expect(logged("grid power sensor is not readable")).toBe(true);
    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 100, true],
    ]);
  });

  it("says nothing about an array nobody asked to curtail", async () => {
    await addPvEntity({ ...PV_ARRAY, curtailable: false });
    await savePriceConfig(NEGATIVE_INJECTION);
    await saveCurtailmentConfig(CURTAILMENT);

    await runControlTick();

    expect(pvLimitEvents()).toEqual([]);
    expect(logged("No PV array is curtailable")).toBe(true);
  });
});

describe("syncControlLoop, with curtailment", () => {
  it("releases the arrays when curtailment is switched off", async () => {
    await addPvEntity(PV_ARRAY);
    await savePriceConfig(NEGATIVE_INJECTION);
    await saveControlConfig({
      enabled: false,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await saveCurtailmentConfig(CURTAILMENT);
    await syncControlLoop();
    await pendingControlTick();
    ha.events.length = 0;

    await saveCurtailmentConfig({ ...CURTAILMENT, enabled: false });
    await syncControlLoop();

    // The single most important thing this feature does: an array that stops
    // being decided for must be handed back, or the last limit stands for ever.
    expect(pvLimitEvents()).toEqual([
      ["elias_ems_south_roof_pv_limit", 100, true],
    ]);
    expect(logged("Released the array to 100%.")).toBe(true);
  });

  it("runs the loop for curtailment alone, and says so in its own log", async () => {
    await addPvEntity(PV_ARRAY);
    await savePriceConfig(NEGATIVE_INJECTION);
    await saveControlConfig({
      enabled: false,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await saveCurtailmentConfig(CURTAILMENT);

    const status = await syncControlLoop();
    await pendingControlTick();

    // `running` is battery control's view, and it is deliberately narrower than
    // "a timer exists" — the home page would otherwise report the wrong feature
    // as running.
    expect(status.running).toBe(false);
    expect(logged("PV curtailment enabled")).toBe(true);
    expect(logged("Battery control enabled")).toBe(false);
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

  it("does not tick on an entity an automation moved on our behalf", async () => {
    // Whatever the automation does with a target on the way to the hardware
    // is an output, not a reading. Watching it would mean every target came
    // back as a change, provoked another tick and was published again — a
    // feedback loop with nothing damping it.
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
    ha.setState("input_number.battery_target", "-1200", {
      min: -5000,
      max: 5000,
    });

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
    // Named per feature rather than as one line about the loop: the loop is
    // shared with curtailment now, and "the loop stopped" would be the wrong
    // thing to say in battery control's box when the other feature is what was
    // switched off.
    expect(logged("Battery control disabled.")).toBe(true);

    // And it really is stopped, not merely reported as such.
    const before = decisionTicks();
    await advance(30_000);
    expect(decisionTicks()).toBe(before);
  });

  it("releases the batteries when control is switched off", async () => {
    // Switching control off has to leave the battery under its own control
    // again. Stopping the loop while a forced target stands would leave it
    // discharging at whatever it was last told, with nothing left running that
    // would ever change its mind.
    vi.useFakeTimers();
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await syncControlLoop();
    await pendingControlTick();

    expect(targetEvents()).toEqual([
      ["elias_ems_home_battery_target_power", -842],
    ]);

    await saveControlConfig({
      enabled: false,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await syncControlLoop();

    expect(targetEvents()).toEqual([
      ["elias_ems_home_battery_target_power", -842],
      ["elias_ems_home_battery_target_power", 0],
    ]);
    expect(logged("Released the battery to 0 W")).toBe(true);
  });

  it("releases unconditionally, and says it is letting go rather than stopping", async () => {
    // The deadband is a tick-rate optimisation, not something the release
    // should inherit: letting go is worth one event even when it looks
    // redundant, because what we think the battery is doing is the very thing
    // in doubt when something has gone wrong enough to be switching control
    // off. `released` is what lets an automation tell the two zeros apart.
    vi.useFakeTimers();
    ha.setState("sensor.grid_power", "4", { unit_of_measurement: "W" });
    await addBattery(BATTERY);
    await saveControlConfig({
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await syncControlLoop();
    await pendingControlTick();
    // A balanced house, so the tick above published nothing at all.
    expect(targetEvents()).toEqual([]);

    await saveControlConfig({
      enabled: false,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });
    await syncControlLoop();

    expect(targetEvents()).toEqual([
      ["elias_ems_home_battery_target_power", 0],
    ]);
    expect(ha.events.at(-1)?.data).toMatchObject({ released: true });
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

    // Reads only. The tick also *publishes* a target, which is a round trip
    // by definition and the one this exercise was never about avoiding.
    const stateReads = () =>
      ha.requests.filter((request) =>
        request.path.startsWith("/core/api/states"),
      ).length;

    const before = stateReads();
    await runControlTick();

    expect(logged("via live cache")).toBe(true);
    // The point of the whole exercise: a decision that costs no round trip.
    expect(stateReads()).toBe(before);
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
