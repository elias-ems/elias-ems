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
import { DEFAULT_CONTROL_CONFIG } from "../../app/lib/control";
import {
  readControlConfig,
  saveControlConfig,
} from "../../app/lib/control-config.server";
import { readGrid, saveGrid } from "../../app/lib/grid.server";

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
    expect(await readGrid()).toEqual({
      importEntityId: "",
      exportEntityId: "",
    });
  });

  it("round-trips the two sensors", async () => {
    const grid = {
      importEntityId: "sensor.grid_import_power",
      exportEntityId: "sensor.grid_export_power",
    };

    await saveGrid(grid);

    expect(await readGrid()).toEqual(grid);
    expect(
      JSON.parse(await readFile(storedFile("grid.json"), "utf-8")),
    ).toEqual(grid);
  });

  it("tolerates a half-written file rather than throwing", async () => {
    await writeStored("grid.json", { importEntityId: " sensor.a " });

    expect(await readGrid()).toEqual({
      importEntityId: "sensor.a",
      exportEntityId: "",
    });
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
      strategy: "net-zero-energy" as const,
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
});
