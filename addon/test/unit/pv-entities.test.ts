import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DATA_DIR is read once, when pv-entities.server.ts is first imported, so it
// has to be set before the import — and the module cache dropped between tests,
// since each test gets a directory of its own.
let dataDir: string;

async function load() {
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  return import("../../app/lib/pv-entities.server");
}

const storedFile = () => path.join(dataDir, "pv-entities.json");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "elias-ems-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("listPvEntities", () => {
  it("returns an empty list before anything has been saved", async () => {
    const { listPvEntities } = await load();
    expect(await listPvEntities()).toEqual([]);
  });

  it("falls back to the power entity id for records saved before titles existed", async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      storedFile(),
      JSON.stringify([
        { id: "a", powerEntityId: "sensor.p", energyEntityId: "sensor.e" },
        {
          id: "b",
          title: "   ",
          powerEntityId: "sensor.p2",
          energyEntityId: "sensor.e2",
        },
      ]),
    );

    const { listPvEntities } = await load();
    const titles = (await listPvEntities()).map((entity) => entity.title);

    expect(titles).toEqual(["sensor.p", "sensor.p2"]);
  });
});

describe("addPvEntity", () => {
  it("creates the data directory and persists the entity", async () => {
    const { addPvEntity, listPvEntities } = await load();

    const created = await addPvEntity({
      title: "Roof",
      powerEntityId: "sensor.inverter_power",
      energyEntityId: "sensor.inverter_energy_total",
    });

    expect(created.id).toBeTruthy();
    expect(await listPvEntities()).toEqual([created]);
    expect(JSON.parse(await readFile(storedFile(), "utf-8"))).toHaveLength(1);
  });

  it("gives each entity a distinct id", async () => {
    const { addPvEntity } = await load();
    const fields = {
      title: "Roof",
      powerEntityId: "sensor.p",
      energyEntityId: "sensor.e",
    };

    const first = await addPvEntity(fields);
    const second = await addPvEntity(fields);

    expect(first.id).not.toBe(second.id);
  });
});

describe("updatePvEntity", () => {
  it("changes the stored fields and leaves the id alone", async () => {
    const { addPvEntity, updatePvEntity, listPvEntities } = await load();
    const created = await addPvEntity({
      title: "Roof",
      powerEntityId: "sensor.p",
      energyEntityId: "sensor.e",
    });

    const updated = await updatePvEntity(created.id, {
      title: "Garage",
      powerEntityId: "sensor.p2",
      energyEntityId: "sensor.e2",
    });

    expect(updated).toMatchObject({ id: created.id, title: "Garage" });
    expect(await listPvEntities()).toEqual([updated]);
  });

  it("returns null for an unknown id", async () => {
    const { updatePvEntity } = await load();
    const result = await updatePvEntity("does-not-exist", {
      title: "x",
      powerEntityId: "sensor.p",
      energyEntityId: "sensor.e",
    });

    expect(result).toBeNull();
  });
});

describe("removePvEntity", () => {
  it("removes only the named entity", async () => {
    const { addPvEntity, removePvEntity, listPvEntities } = await load();
    const first = await addPvEntity({
      title: "Roof",
      powerEntityId: "sensor.p",
      energyEntityId: "sensor.e",
    });
    const second = await addPvEntity({
      title: "Garage",
      powerEntityId: "sensor.p2",
      energyEntityId: "sensor.e2",
    });

    await removePvEntity(first.id);

    expect(await listPvEntities()).toEqual([second]);
  });
});
