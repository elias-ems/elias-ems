/**
 * The dashboard has two ways to read an entity — the live cache and REST — and
 * they have to produce the same page. The cache is the fast path, and the one
 * allowed to be absent, so what matters here is that neither the presence nor
 * the absence of a socket is visible in the result.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { addBattery } from "../../app/lib/batteries.server";
import {
  readDashboard,
  watchedEntityIds,
} from "../../app/lib/dashboard.server";
import { saveGrid } from "../../app/lib/grid.server";
import {
  haLiveStatus,
  startHaLive,
  stopHaLive,
} from "../../app/lib/ha-live.server";
import { defaultStates, startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;
let dataDir: string;

beforeAll(async () => {
  ha = await startHaMock();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "elias-ems-dashboard-"));
  process.env.SUPERVISOR_API = ha.apiUrl;
  process.env.SUPERVISOR_WS = ha.wsUrl;
  process.env.SUPERVISOR_TOKEN = ha.token;
  process.env.DATA_DIR = dataDir;

  await saveGrid({ powerEntityId: "sensor.grid_power" });
  await addBattery({
    title: "Home battery",
    capacityKwh: 10,
    minChargePercent: 10,
    maxChargePercent: 90,
    energyEntityId: "sensor.battery_energy_total",
    powerEntityId: "sensor.battery_power",
    socEntityId: "sensor.battery_state_of_charge",
  });
});

afterAll(async () => {
  await ha.close();
  await rm(dataDir, { recursive: true, force: true });
  delete process.env.SUPERVISOR_API;
  delete process.env.SUPERVISOR_WS;
  delete process.env.SUPERVISOR_TOKEN;
  delete process.env.DATA_DIR;
});

afterEach(async () => {
  // An open socket keeps node's event loop alive; each case decides for itself
  // whether there is one.
  stopHaLive();
  ha.setStates(await defaultStates());
});

describe("readDashboard", () => {
  it("reads over REST when the subscription isn't up", async () => {
    // No startHaLive: this is first paint, and every local run outside Home
    // Assistant.
    const readings = await readDashboard();

    expect(readings.grid.power?.display).toBe("842 W");
    expect(readings.error).toBeNull();
    expect(
      ha.requests.some(
        (request) => request.path === "/core/api/states/sensor.grid_power",
      ),
    ).toBe(true);
  });

  it("reads from the live cache once it is, without touching REST", async () => {
    startHaLive();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));

    const before = ha.requests.length;
    const readings = await readDashboard();

    expect(readings.grid.power?.display).toBe("842 W");
    expect(readings.batteries[0].charge?.display).toBe("76 %");
    // The whole point: a reading that costs no round trip.
    expect(ha.requests.length).toBe(before);
  });

  it("keeps up with a state change without being asked again", async () => {
    startHaLive();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));

    ha.setState("sensor.grid_power", "-1500", { unit_of_measurement: "W" });

    await vi.waitFor(async () => {
      const readings = await readDashboard();
      expect(readings.grid.power?.display).toMatch(/^-1\D?500 W$/);
    });
  });
});

describe("watchedEntityIds", () => {
  it("lists the configured entities, deduplicated", async () => {
    const ids = await watchedEntityIds();

    expect([...ids].sort()).toEqual([
      "sensor.battery_energy_total",
      "sensor.battery_power",
      "sensor.battery_state_of_charge",
      "sensor.grid_power",
    ]);
  });
});
