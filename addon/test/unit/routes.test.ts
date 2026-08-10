/**
 * Loaders are plain functions, so they can be called directly — no router, no
 * rendering. That covers the data shaping the UI depends on; whether the page
 * that consumes it actually hydrates is the end-to-end suite's job.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { defaultStates, startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;
let dataDir: string;

/**
 * Nothing listens on port 1, so a request there fails immediately. Simpler and
 * steadier than stopping and restarting the mock mid-suite.
 */
const UNREACHABLE_API = "http://127.0.0.1:1/core/api";

beforeAll(async () => {
  ha = await startHaMock();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "elias-ems-routes-"));
  process.env.SUPERVISOR_API = ha.apiUrl;
  process.env.SUPERVISOR_TOKEN = ha.token;
  process.env.DATA_DIR = dataDir;
});

afterAll(async () => {
  await ha.close();
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Undoes whatever the outage tests pointed it at.
  process.env.SUPERVISOR_API = ha.apiUrl;
  ha.setStates(await defaultStates());
  vi.resetModules();
});

describe("GET /api/entities", () => {
  async function loadEntities(query: string) {
    const { loader } = await import("../../app/routes/api.entities");
    return loader({
      request: new Request(`http://localhost/api/entities${query}`),
    } as Parameters<typeof loader>[0]);
  }

  it("offers only sensors — a switch is not a reading", async () => {
    const { entities, error } = await loadEntities("");

    expect(error).toBeNull();
    const ids = entities.map((entity) => entity.entityId);
    expect(ids).toContain("sensor.inverter_power");
    expect(ids).not.toContain("switch.pv_curtailment");
    expect(ids).not.toContain("binary_sensor.grid_connected");
  });

  it("matches the query against both the id and the friendly name", async () => {
    const byId = await loadEntities("?q=garage_inverter");
    const byName = await loadEntities("?q=Garage inverter");

    expect(byId.entities.map((entity) => entity.entityId)).toEqual(
      byName.entities.map((entity) => entity.entityId),
    );
    expect(byId.entities.length).toBe(2);
  });

  it("reports a unit of null rather than omitting entities that have none", async () => {
    const { entities } = await loadEntities("?q=no_unit_counter");

    expect(entities).toEqual([
      {
        entityId: "sensor.no_unit_counter",
        name: "Counter without a unit",
        unit: null,
      },
    ]);
  });

  it("caps the list so the dropdown stays usable", async () => {
    ha.setStates(
      Array.from({ length: 40 }, (_, index) => ({
        entity_id: `sensor.meter_${index}`,
        state: "1",
        attributes: { friendly_name: `Meter ${index}` },
      })),
    );

    const { entities } = await loadEntities("");

    expect(entities).toHaveLength(25);
  });

  it("surfaces a Home Assistant outage as an error instead of an empty list", async () => {
    // An empty dropdown would look exactly like a Home Assistant with no
    // sensors, so the outage has to reach the UI as an error.
    process.env.SUPERVISOR_API = UNREACHABLE_API;

    const { entities, error } = await loadEntities("");

    expect(entities).toEqual([]);
    expect(error).toBeTruthy();
  });
});

describe("GET / (dashboard)", () => {
  async function loadIndex() {
    const { loader } = await import("../../app/routes/_index");
    return loader();
  }

  async function addEntity(fields: {
    title: string;
    powerEntityId: string;
    energyEntityId: string;
  }) {
    const { addPvEntity } = await import("../../app/lib/pv-entities.server");
    return addPvEntity(fields);
  }

  beforeEach(async () => {
    const { listPvEntities, removePvEntity } = await import(
      "../../app/lib/pv-entities.server"
    );
    for (const entity of await listPvEntities())
      await removePvEntity(entity.id);
    vi.resetModules();
  });

  it("returns nothing to show before any PV entity is configured", async () => {
    expect(await loadIndex()).toEqual({ arrays: [], error: null });
  });

  it("formats readings with their unit, grouped and rounded", async () => {
    await addEntity({
      title: "Roof",
      powerEntityId: "sensor.inverter_power",
      energyEntityId: "sensor.inverter_energy_total",
    });

    const { arrays, error } = await loadIndex();

    expect(error).toBeNull();
    expect(arrays).toHaveLength(1);
    // The loader formats with the *server's* locale, so the separators differ
    // between machines (en-US "8,421.33" vs en-BE "8.421,33"). `\D` keeps the
    // real assertions — grouping, rounding to two decimals, and the unit —
    // without pinning the suite to whichever locale wrote it.
    expect(arrays[0].power).toEqual({
      display: expect.stringMatching(/^1\D?234\D5 W$/),
      ok: true,
    });
    // 8421.334 rounded to 8421.33.
    expect(arrays[0].energy).toEqual({
      display: expect.stringMatching(/^8\D?421\D33 kWh$/),
      ok: true,
    });
  });

  it("marks an unavailable sensor as not ok rather than showing a stale number", async () => {
    await addEntity({
      title: "Shed",
      powerEntityId: "sensor.shed_inverter_power",
      energyEntityId: "sensor.inverter_energy_total",
    });

    const { arrays } = await loadIndex();

    expect(arrays[0].power).toEqual({ display: "unavailable", ok: false });
  });

  it("says so when a saved entity id has gone stale", async () => {
    await addEntity({
      title: "Old array",
      powerEntityId: "sensor.removed_months_ago",
      energyEntityId: "sensor.inverter_energy_total",
    });

    const { arrays } = await loadIndex();

    expect(arrays[0].power).toEqual({ display: "no such entity", ok: false });
  });

  it("still lists the configured arrays when Home Assistant is unreachable", async () => {
    await addEntity({
      title: "Roof",
      powerEntityId: "sensor.inverter_power",
      energyEntityId: "sensor.inverter_energy_total",
    });
    process.env.SUPERVISOR_API = UNREACHABLE_API;

    const { arrays, error } = await loadIndex();

    expect(error).toBeTruthy();
    expect(arrays).toEqual([
      { id: expect.any(String), title: "Roof", power: null, energy: null },
    ]);
  });
});
