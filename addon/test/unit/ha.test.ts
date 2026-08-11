import http from "node:http";
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

/**
 * A Home Assistant that accepts the connection and then says nothing — a core
 * restart caught mid-request looks like this. Without a deadline the promise
 * never settles, and a caller that waits on it (the page's refresh loop, the
 * control loop) stops for good rather than failing and trying again.
 */
describe("a request Home Assistant never answers", () => {
  let silent: http.Server;

  beforeAll(async () => {
    silent = http.createServer(() => {
      // Deliberately no response.
    });
    await new Promise<void>((resolve) =>
      silent.listen(0, "127.0.0.1", resolve),
    );

    const address = silent.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.SUPERVISOR_API = `http://127.0.0.1:${port}/core/api`;
    process.env.HA_TIMEOUT_MS = "150";
  });

  afterAll(async () => {
    await new Promise((resolve) => silent.close(resolve));
    process.env.SUPERVISOR_API = ha.apiUrl;
    delete process.env.HA_TIMEOUT_MS;
  });

  it("gives up, and says so in terms the page can show", async () => {
    await expect(fetchHaState("sensor.inverter_power")).rejects.toThrow(
      "Home Assistant did not respond within 0.15s",
    );
  });

  it("gives up on the full state list too", async () => {
    await expect(fetchHaStates()).rejects.toThrow("did not respond");
  });
});
