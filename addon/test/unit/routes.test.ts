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

/**
 * A battery as the settings form posts it — every field a string, and the two
 * optional power caps left out entirely, which is what a browser sends for a
 * field nobody filled in.
 */
const postedBattery = {
  title: "Home battery",
  capacityKwh: "10",
  minChargePercent: "10",
  maxChargePercent: "90",
  energyEntityId: "sensor.battery_energy_total",
  powerEntityId: "sensor.battery_power",
  socEntityId: "sensor.battery_state_of_charge",
  // What a ticked checkbox posts, rather than the boolean it becomes.
  steered: "on",
};

/** The same battery as it should end up on disk, with real numbers. */
const storedBattery = {
  ...postedBattery,
  capacityKwh: 10,
  minChargePercent: 10,
  maxChargePercent: 90,
  steered: true,
  maxChargePowerW: null,
  maxDischargePowerW: null,
};

/**
 * Back to a blank installation. Every suite here shares one data directory, so
 * a battery left behind by one test would show up as an extra card in another.
 */
async function clearStoredSettings() {
  const [pv, batteries, grid, control] = await Promise.all([
    import("../../app/lib/pv-entities.server"),
    import("../../app/lib/batteries.server"),
    import("../../app/lib/grid.server"),
    import("../../app/lib/control-config.server"),
  ]);

  for (const entity of await pv.listPvEntities()) {
    await pv.removePvEntity(entity.id);
  }
  for (const battery of await batteries.listBatteries()) {
    await batteries.removeBattery(battery.id);
  }
  await grid.saveGrid({ powerEntityId: "" });
  await control.saveControlConfig({
    enabled: false,
    strategy: "net-zero-energy",
    intervalSeconds: 5,
  });
}

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

  it("offers sensors only, whatever else the house has", async () => {
    // Every field that picks an entity is picking a reading: a target leaves
    // as an event rather than as a value set on an entity, so there is no
    // writable field for these suggestions to serve.
    const { entities } = await loadEntities("");

    const ids = entities.map((entity) => entity.entityId);
    expect(ids).not.toContain("number.battery_target_power");
    expect(ids).not.toContain("input_number.battery_target");
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
    // Uncurtailable and unrated: these cases are about what the dashboard
    // shows, and curtailment has its own suites.
    return addPvEntity({ ...fields, ratedPowerW: null, curtailable: false });
  }

  beforeEach(async () => {
    await clearStoredSettings();
    vi.resetModules();
  });

  it("returns nothing to show before anything is configured", async () => {
    expect(await loadIndex()).toEqual({
      arrays: [],
      grid: { configured: false, power: null },
      batteries: [],
      // Unconfigured is not an error: no source has been picked, so there is
      // nothing to have failed at.
      prices: {
        configured: false,
        consumption: null,
        production: null,
        spot: null,
        slot: null,
        coverage: null,
        error: null,
      },
      control: {
        enabled: false,
        status: {
          running: false,
          strategy: "net-zero-energy",
          intervalSeconds: 5,
          lastTickAt: null,
        },
        diagnostics: [],
      },
      error: null,
      // `lastError` is left out on purpose: whether the failed connection to a
      // Home Assistant that isn't there has been reported yet is a race, and
      // not what this case is about.
      health: expect.objectContaining({
        connected: false,
        lastEventAt: null,
        reconnects: 0,
        // Nothing was read, because nothing is configured — which is a
        // different thing from having read nothing.
        source: null,
      }),
    });
  });

  it("shows the grid reading once the sensor is configured", async () => {
    const { saveGrid } = await import("../../app/lib/grid.server");
    await saveGrid({ powerEntityId: "sensor.grid_power" });

    const { grid } = await loadIndex();

    expect(grid.configured).toBe(true);
    expect(grid.power).toEqual({
      display: "842 W",
      ok: true,
      // Stamped by Home Assistant, carried through so the page can say how old
      // the number is rather than implying it is current by showing it at all.
      updatedAt: expect.any(Number),
    });
  });

  it("shows a battery's charge window alongside its three readings", async () => {
    const { addBattery } = await import("../../app/lib/batteries.server");
    await addBattery(storedBattery);

    const { batteries } = await loadIndex();

    expect(batteries).toEqual([
      {
        id: expect.any(String),
        title: "Home battery",
        window: "10–90% of 10 kWh",
        charge: { display: "76 %", ok: true, updatedAt: expect.any(Number) },
        power: { display: "0 W", ok: true, updatedAt: expect.any(Number) },
        energy: {
          display: expect.stringMatching(/^2\D?450\D75 kWh$/),
          ok: true,
          updatedAt: expect.any(Number),
        },
      },
    ]);
  });

  it("reads a sensor configured in two places only once", async () => {
    // Deduplicating matters at the interval this page refreshes on: the same
    // meter legitimately appears as a PV array's power and as the grid sensor.
    await addEntity({
      title: "Roof",
      powerEntityId: "sensor.grid_power",
      energyEntityId: "sensor.inverter_energy_total",
    });
    const { saveGrid } = await import("../../app/lib/grid.server");
    await saveGrid({ powerEntityId: "sensor.grid_power" });

    ha.requests.length = 0;
    await loadIndex();

    const asked = ha.requests.filter((request) =>
      request.path.endsWith("sensor.grid_power"),
    );
    expect(asked).toHaveLength(1);
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
      updatedAt: expect.any(Number),
    });
    // 8421.334 rounded to 8421.33.
    expect(arrays[0].energy).toEqual({
      display: expect.stringMatching(/^8\D?421\D33 kWh$/),
      ok: true,
      updatedAt: expect.any(Number),
    });
  });

  it("marks an unavailable sensor as not ok rather than showing a stale number", async () => {
    await addEntity({
      title: "Shed",
      powerEntityId: "sensor.shed_inverter_power",
      energyEntityId: "sensor.inverter_energy_total",
    });

    const { arrays } = await loadIndex();

    expect(arrays[0].power).toEqual({
      display: "unavailable",
      ok: false,
      // Still stamped: knowing *when* a sensor went unavailable is exactly what
      // makes it diagnosable.
      updatedAt: expect.any(Number),
    });
  });

  it("says so when a saved entity id has gone stale", async () => {
    await addEntity({
      title: "Old array",
      powerEntityId: "sensor.removed_months_ago",
      energyEntityId: "sensor.inverter_energy_total",
    });

    const { arrays } = await loadIndex();

    expect(arrays[0].power).toEqual({
      display: "no such entity",
      ok: false,
      updatedAt: null,
    });
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

describe("GET /api/diagnostics", () => {
  async function loadDiagnostics(query: string) {
    const { loader } = await import("../../app/routes/api.diagnostics");
    return loader({
      request: new Request(`http://localhost/api/diagnostics${query}`),
    } as Parameters<typeof loader>[0]);
  }

  /** A fresh module graph means a fresh buffer, so each case seeds its own. */
  async function seed() {
    const { appendDiagnostic } = await import(
      "../../app/lib/diagnostics.server"
    );
    appendDiagnostic("battery-control", "info", "A control decision");
  }

  it("answers without touching Home Assistant", async () => {
    // A diagnostics box polls this every couple of seconds while it is open, so
    // it must not be doing a round of entity reads behind the scenes.
    await seed();
    ha.requests.length = 0;

    const { entries } = await loadDiagnostics("");

    expect(entries).toMatchObject([{ origin: "battery-control" }]);
    expect(ha.requests).toEqual([]);
  });

  it("narrows to one origin when asked", async () => {
    await seed();

    expect(
      (await loadDiagnostics("?origin=battery-control")).entries,
    ).toHaveLength(1);
  });

  it("treats an unknown origin as no filter rather than as an error", async () => {
    // The only thing that can produce one is a stale client after an origin was
    // renamed; showing it the whole log beats showing it a failure.
    await seed();

    expect((await loadDiagnostics("?origin=nonsense")).entries).toHaveLength(1);
  });
});

describe("GET /tools", () => {
  it("hands the page every feature's entries, newest first", async () => {
    const { appendDiagnostic } = await import(
      "../../app/lib/diagnostics.server"
    );
    appendDiagnostic("battery-control", "info", "Older");
    appendDiagnostic("battery-control", "info", "Newer");

    const { loader } = await import("../../app/routes/tools");
    const { entries } = await loader();

    expect(entries.map((entry) => entry.message)).toEqual(["Newer", "Older"]);
  });
});

describe("GET /api/diagnostics.txt", () => {
  it("hands over a text file the browser will save", async () => {
    const { appendDiagnostic } = await import(
      "../../app/lib/diagnostics.server"
    );
    appendDiagnostic("battery-control", "warn", "Something to keep");

    const { loader } = await import("../../app/routes/api.diagnostics[.]txt");
    const response = await loader();

    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="elias-ems-diagnostics-[\d-]{10}T[\d-]{8}\.txt"$/,
    );
    expect(await response.text()).toContain(
      "battery-control  warn\n    Something to keep",
    );
  });
});

describe("POST /settings", () => {
  /** The route module and the loop module from the same fresh module graph. */
  async function loadSettings() {
    const [route, loop] = await Promise.all([
      import("../../app/routes/settings"),
      import("../../app/lib/control-loop.server"),
    ]);
    return { route, loop };
  }

  async function post(fields: Record<string, string>) {
    const { route } = await loadSettings();
    const body = new URLSearchParams(fields);
    return route.action({
      request: new Request("http://localhost/settings", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
    } as Parameters<typeof route.action>[0]);
  }

  /** A 400 from the action is `data(...)`, which carries its payload and status. */
  function failure(result: unknown) {
    const wrapped = result as { data: unknown; init?: { status?: number } };
    return { payload: wrapped.data, status: wrapped.init?.status };
  }

  beforeEach(async () => {
    await clearStoredSettings();
    vi.resetModules();
  });

  it("saves the grid sensor", async () => {
    const result = await post({
      intent: "grid-save",
      powerEntityId: "sensor.grid_power",
    });

    expect(result).toEqual({ section: "grid", ok: true });
    const { readGrid } = await import("../../app/lib/grid.server");
    expect(await readGrid()).toEqual({ powerEntityId: "sensor.grid_power" });
  });

  it("tags a rejected grid form so only that section shows the error", async () => {
    const result = await post({ intent: "grid-save", powerEntityId: "" });

    const { payload, status } = failure(result);
    expect(status).toBe(400);
    expect(payload).toMatchObject({ section: "grid", recordId: null });
  });

  it("stores a battery's typed-in numbers as numbers", async () => {
    const result = await post({ intent: "battery-add", ...postedBattery });

    expect(result).toEqual({ section: "battery", ok: true });
    const { listBatteries } = await import("../../app/lib/batteries.server");
    expect(await listBatteries()).toEqual([
      { id: expect.any(String), ...storedBattery },
    ]);
  });

  it("refuses a second battery whose name makes the same event", async () => {
    // "Home battery" and "home-battery" are different titles and one event
    // type. Both batteries would take each other's targets, and nothing
    // anywhere would report a problem.
    await post({ intent: "battery-add", ...postedBattery });

    const result = await post({
      intent: "battery-add",
      ...postedBattery,
      title: "home-battery",
    });

    const { payload, status } = failure(result);
    expect(status).toBe(400);
    expect(payload).toMatchObject({
      section: "battery",
      errors: { title: expect.stringContaining("same event") },
    });

    const { listBatteries } = await import("../../app/lib/batteries.server");
    expect(await listBatteries()).toHaveLength(1);
  });

  it("lets a battery keep its own name across an edit", async () => {
    // The clash check has to skip the record being edited, or changing a
    // battery's capacity would fail on its own title.
    const { addBattery } = await import("../../app/lib/batteries.server");
    const battery = await addBattery(storedBattery);

    const result = await post({
      intent: "battery-update",
      id: battery.id,
      ...postedBattery,
      capacityKwh: "15",
    });

    expect(result).toEqual({ section: "battery", ok: true });
  });

  it("points a rejected edit at the row being edited, not at the add form", async () => {
    const { addBattery } = await import("../../app/lib/batteries.server");
    const battery = await addBattery(storedBattery);

    const result = await post({
      intent: "battery-update",
      id: battery.id,
      ...postedBattery,
      capacityKwh: "0",
    });

    const { payload, status } = failure(result);
    expect(status).toBe(400);
    expect(payload).toMatchObject({
      section: "battery",
      recordId: battery.id,
      errors: { capacityKwh: expect.any(String) },
    });
  });

  it("removes a battery", async () => {
    const { addBattery, listBatteries } = await import(
      "../../app/lib/batteries.server"
    );
    const battery = await addBattery(storedBattery);

    await post({ intent: "battery-remove", id: battery.id });

    expect(await listBatteries()).toEqual([]);
  });

  it("saves the control settings without starting a loop while it is off", async () => {
    const result = await post({
      intent: "control-save",
      strategy: "net-zero-energy",
      intervalSeconds: "10",
    });

    expect(result).toEqual({ section: "control", ok: true });
    const { readControlConfig } = await import(
      "../../app/lib/control-config.server"
    );
    expect(await readControlConfig()).toEqual({
      enabled: false,
      strategy: "net-zero-energy",
      intervalSeconds: 10,
    });

    const { loop } = await loadSettings();
    expect(loop.controlLoopStatus().running).toBe(false);
  });

  it("starts the loop as soon as the box is ticked", async () => {
    // Waiting for a restart would be indistinguishable from the feature not
    // working, which is the whole reason the action re-syncs the loop.
    const { addBattery } = await import("../../app/lib/batteries.server");
    await addBattery(storedBattery);

    const { loop } = await loadSettings();
    try {
      await post({
        intent: "control-save",
        enabled: "on",
        strategy: "net-zero-energy",
        intervalSeconds: "5",
      });

      expect(loop.controlLoopStatus()).toMatchObject({
        running: true,
        intervalSeconds: 5,
      });
    } finally {
      // The interval is real here; leaving it running would tick against a
      // torn-down mock for the rest of the file.
      await loop.pendingControlTick();
      loop.resetControlLoop();
    }
  });

  it("refuses to enable control when no battery is steered", async () => {
    // A loop that decides correctly and commands nothing is indistinguishable
    // from a broken one, so this is a rejection rather than a warning.
    const { addBattery } = await import("../../app/lib/batteries.server");
    await addBattery({ ...storedBattery, steered: false });

    const result = await post({
      intent: "control-save",
      enabled: "on",
      strategy: "net-zero-energy",
      intervalSeconds: "5",
    });

    const { payload, status } = failure(result);
    expect(status).toBe(400);
    expect(payload).toMatchObject({
      section: "control",
      errors: { enabled: expect.stringContaining("steered") },
    });

    const { readControlConfig } = await import(
      "../../app/lib/control-config.server"
    );
    expect((await readControlConfig()).enabled).toBe(false);
  });

  it("still lets control be switched off with nothing steered", async () => {
    // The way out of the state above: refusing this too would leave a stored
    // `enabled: true` with no way to clear it from the form.
    const { addBattery } = await import("../../app/lib/batteries.server");
    await addBattery({ ...storedBattery, steered: false });

    const result = await post({
      intent: "control-save",
      strategy: "net-zero-energy",
      intervalSeconds: "5",
    });

    expect(result).toEqual({ section: "control", ok: true });
  });

  it("enables control when only one of several batteries is steerable", async () => {
    const { addBattery } = await import("../../app/lib/batteries.server");
    await addBattery({ ...storedBattery, steered: false });
    await addBattery(storedBattery);

    const { loop } = await loadSettings();
    try {
      const result = await post({
        intent: "control-save",
        enabled: "on",
        strategy: "net-zero-energy",
        intervalSeconds: "5",
      });

      expect(result).toEqual({ section: "control", ok: true });
    } finally {
      await loop.pendingControlTick();
      loop.resetControlLoop();
    }
  });

  it("rejects an interval outside the allowed range", async () => {
    const result = await post({
      intent: "control-save",
      enabled: "on",
      strategy: "net-zero-energy",
      intervalSeconds: "0",
    });

    const { payload, status } = failure(result);
    expect(status).toBe(400);
    expect(payload).toMatchObject({
      section: "control",
      errors: { intervalSeconds: expect.any(String) },
    });
  });

  const postedPrices = {
    intent: "prices-save",
    source: "home-assistant",
    forecastEntityId: "sensor.energi_epex_spot",
    consumptionFormula: "((price * 1.02) + 0.1272) * 1.06",
    productionFormula: "max(price * 0.98 - 0.015, 0)",
  };

  it("saves a price source and both formulas", async () => {
    const result = await post(postedPrices);

    expect(result).toEqual({ section: "prices", ok: true });
    const { readPriceConfig } = await import("../../app/lib/prices.server");
    expect(await readPriceConfig()).toEqual({
      source: "home-assistant",
      forecastEntityId: "sensor.energi_epex_spot",
      consumptionFormula: "((price * 1.02) + 0.1272) * 1.06",
      productionFormula: "max(price * 0.98 - 0.015, 0)",
    });
  });

  it("rejects a formula the action itself cannot parse", async () => {
    // The form previews formulas in the browser, but the check has to be here
    // too: nothing stops a form being posted directly, and a formula that first
    // fails at 03:00 is a price feature with no price.
    const result = await post({
      ...postedPrices,
      productionFormula: "price * spot",
    });

    const { payload, status } = failure(result);
    expect(status).toBe(400);
    expect(payload).toMatchObject({
      section: "prices",
      recordId: null,
      errors: { productionFormula: expect.any(String) },
    });
  });

  it("refuses a formula that reaches for anything but price", async () => {
    const result = await post({
      ...postedPrices,
      consumptionFormula: "process.exit(1)",
    });

    expect(failure(result).status).toBe(400);
  });

  it("requires an entity once Home Assistant is the source", async () => {
    const result = await post({ ...postedPrices, forecastEntityId: "" });

    expect(failure(result).payload).toMatchObject({
      section: "prices",
      errors: { forecastEntityId: expect.any(String) },
    });
  });

  it("accepts turning the source off without asking for the rest", async () => {
    // Those fields are hidden in that state, so validating them would reject a
    // form nobody can see to fix.
    const result = await post({ intent: "prices-save", source: "none" });

    expect(result).toEqual({ section: "prices", ok: true });
  });

  it("files what it found under the prices origin", async () => {
    await post(postedPrices);

    const { readDiagnostics } = await import(
      "../../app/lib/diagnostics.server"
    );
    const entries = readDiagnostics({ origin: "prices" });

    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain("sensor.energi_epex_spot");
  });
});
