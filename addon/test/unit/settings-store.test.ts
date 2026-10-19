/**
 * Persistence for the three things battery control adds to settings. `DATA_DIR`
 * is read per call by store.server.ts, so unlike the older suites these don't
 * need `vi.resetModules()` — setting the variable is enough.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addBattery,
  listBatteries,
  removeBattery,
  updateBattery,
} from "../../app/lib/batteries.server";
import type { BatteryMode } from "../../app/lib/battery-command";
import { DEFAULT_CONTROL_CONFIG } from "../../app/lib/control";
import {
  readControlConfig,
  saveControlConfig,
} from "../../app/lib/control-config.server";
import {
  clearDiagnostics,
  readDiagnostics,
} from "../../app/lib/diagnostics.server";
import { readGrid, saveGrid } from "../../app/lib/grid.server";
import { readJson, writeJson } from "../../app/lib/store.server";

let dataDir: string;

const storedFile = (name: string) => path.join(dataDir, name);

async function writeStored(name: string, value: unknown) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(storedFile(name), JSON.stringify(value));
}

const battery = {
  title: "Home battery",
  capacityKwh: 10,
  minChargePercent: 10,
  maxChargePercent: 90,
  energyEntityId: "sensor.battery_energy_total",
  powerEntityId: "sensor.battery_power",
  socEntityId: "sensor.battery_state_of_charge",
  steered: true,
  controlModes: ["balance", "hold", "charge", "discharge"] as BatteryMode[],
  dischargeLimitSupported: false,
  powerStepW: 100,
  chargeLimitPlanning: false,
  commandContract: 1,
  maxChargePowerW: null,
  maxDischargePowerW: null,
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "elias-ems-control-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("grid", () => {
  it("reads nothing configured before anything is saved", async () => {
    expect(await readGrid()).toEqual({ powerEntityId: "" });
  });

  it("round-trips the sensor", async () => {
    const grid = { powerEntityId: "sensor.grid_power" };

    await saveGrid(grid);

    expect(await readGrid()).toEqual(grid);
    expect(
      JSON.parse(await readFile(storedFile("grid.json"), "utf-8")),
    ).toEqual(grid);
  });

  it("tolerates a hand-edited file rather than throwing", async () => {
    await writeStored("grid.json", { powerEntityId: " sensor.a " });

    expect(await readGrid()).toEqual({ powerEntityId: "sensor.a" });
  });
});

describe("batteries", () => {
  it("starts empty and creates the data directory on the first write", async () => {
    expect(await listBatteries()).toEqual([]);

    const created = await addBattery(battery);

    expect(created.id).toBeTruthy();
    expect(await listBatteries()).toEqual([created]);
  });

  it("keeps the id across an update", async () => {
    const created = await addBattery(battery);

    const updated = await updateBattery(created.id, {
      ...battery,
      title: "Garage battery",
      capacityKwh: 15,
    });

    expect(updated).toMatchObject({
      id: created.id,
      title: "Garage battery",
      capacityKwh: 15,
    });
    expect(await listBatteries()).toEqual([updated]);
  });

  it("returns null for an id that is no longer there", async () => {
    expect(await updateBattery("gone", battery)).toBeNull();
  });

  it("removes only the named battery", async () => {
    const first = await addBattery(battery);
    const second = await addBattery({ ...battery, title: "Second" });

    await removeBattery(first.id);

    expect(await listBatteries()).toEqual([second]);
  });

  it("normalizes what it reads, not just what it writes", async () => {
    // Straight from a hand-edited batteries.json: the numbers are strings.
    await writeStored("batteries.json", [
      { ...battery, id: "b1", capacityKwh: "10", minChargePercent: "5" },
    ]);

    const [stored] = await listBatteries();

    expect(stored.capacityKwh).toBe(10);
    expect(stored.minChargePercent).toBe(5);
  });
});

describe("control config", () => {
  it("defaults to disabled on a five-second interval", async () => {
    expect(await readControlConfig()).toEqual(DEFAULT_CONTROL_CONFIG);
  });

  it("round-trips what the form saved", async () => {
    const config = {
      enabled: true,
      strategy: "highs" as const,
      intervalSeconds: 15,
    };

    await saveControlConfig(config);

    expect(await readControlConfig()).toEqual(config);
  });

  it("clamps an interval that is out of range on disk", async () => {
    await writeStored("control.json", { enabled: true, intervalSeconds: 0 });

    expect(await readControlConfig()).toMatchObject({
      enabled: true,
      intervalSeconds: 1,
    });
  });

  it("migrates a removed strategy once, even when reads race at boot", async () => {
    // At startup the planning loop, the curtailment loop and the first page
    // load all read this file at once. Each used to write the migration back,
    // and a read landing mid-write saw an empty file — a 500 on the first
    // page in CI.
    clearDiagnostics();
    await writeStored("control.json", {
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 5,
    });

    const reads = await Promise.all(
      Array.from({ length: 50 }, () => readControlConfig()),
    );

    for (const config of reads)
      expect(config).toEqual({
        enabled: false,
        strategy: "evening-target",
        intervalSeconds: 5,
      });
    expect(
      JSON.parse(await readFile(path.join(dataDir, "control.json"), "utf-8")),
    ).toEqual({
      enabled: false,
      strategy: "evening-target",
      intervalSeconds: 5,
    });
    // Identical lines collapse into one entry with a repeat count, so the
    // count is what says how many times it was logged.
    expect(
      readDiagnostics()
        .filter((entry) => entry.message.includes("has been removed"))
        .reduce((total, entry) => total + entry.repeat, 0),
    ).toBe(1);
  });
});

describe("the JSON store", () => {
  it("never shows a reader a half-written file", async () => {
    const big = { padding: "x".repeat(200_000) };
    await writeJson("race.json", big);

    // A plain write truncates first, so a read in between parses "".
    for (let round = 0; round < 20; round++) {
      const work = Array.from({ length: 40 }, (_, i) =>
        i % 2 ? writeJson("race.json", big) : readJson("race.json", null),
      );
      await expect(Promise.all(work)).resolves.toBeDefined();
    }
  });
});
