import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchHaState, fetchHaStates } from "../../app/lib/ha.server";
import { startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;

beforeAll(async () => {
  ha = await startHaMock();
  process.env.SUPERVISOR_API = ha.apiUrl;
  process.env.SUPERVISOR_TOKEN = ha.token;
});

afterAll(async () => {
  await ha.close();
  delete process.env.SUPERVISOR_API;
  delete process.env.SUPERVISOR_TOKEN;
});

describe("fetchHaStates", () => {
  it("returns every entity Home Assistant knows about", async () => {
    const states = await fetchHaStates();

    expect(states.length).toBeGreaterThan(0);
    expect(states.map((state) => state.entity_id)).toContain(
      "sensor.inverter_power",
    );
  });

  it("throws when the token is wrong, rather than returning nothing", async () => {
    process.env.SUPERVISOR_TOKEN = "not-the-right-token";

    // A silent empty list here would look identical to a Home Assistant with no
    // entities, which is why the failure has to surface as an error.
    await expect(fetchHaStates()).rejects.toThrow("401");

    process.env.SUPERVISOR_TOKEN = ha.token;
  });

  it("explains itself when SUPERVISOR_TOKEN is missing entirely", async () => {
    delete process.env.SUPERVISOR_TOKEN;

    await expect(fetchHaStates()).rejects.toThrow(
      "SUPERVISOR_TOKEN is not set",
    );

    process.env.SUPERVISOR_TOKEN = ha.token;
  });
});

describe("fetchHaState", () => {
  it("returns the entity's current state", async () => {
    const state = await fetchHaState("sensor.inverter_power");

    expect(state).toMatchObject({
      entity_id: "sensor.inverter_power",
      state: "1234.5",
    });
    expect(state?.attributes?.unit_of_measurement).toBe("W");
  });

  it("returns null for an entity id that no longer exists", async () => {
    // The id was valid when it was saved; the sensor has since been removed.
    expect(await fetchHaState("sensor.deleted_last_week")).toBeNull();
  });

  it("url-encodes the entity id", async () => {
    await fetchHaState("sensor.odd id/with slash");

    expect(ha.requests.map((request) => request.path)).toContain(
      "/core/api/states/sensor.odd%20id%2Fwith%20slash",
    );
  });
});
