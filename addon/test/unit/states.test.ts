/**
 * The reader both the dashboard and the control loop go through. What matters
 * is that the two sources are interchangeable in what they say, and honest
 * about which one said it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  haLiveStatus,
  startHaLive,
  stopHaLive,
} from "../../app/lib/ha-live.server";
import { readingAge, readStates } from "../../app/lib/states.server";
import { startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;

beforeEach(async () => {
  ha = await startHaMock();
  process.env.SUPERVISOR_API = ha.apiUrl;
  process.env.SUPERVISOR_WS = ha.wsUrl;
  process.env.SUPERVISOR_TOKEN = ha.token;
});

afterEach(async () => {
  stopHaLive();
  await ha.close();
  delete process.env.SUPERVISOR_API;
  delete process.env.SUPERVISOR_WS;
  delete process.env.SUPERVISOR_TOKEN;
});

const ID = "sensor.inverter_power";

describe("readStates", () => {
  it("falls back to REST before the subscription is up", async () => {
    const { states, error } = await readStates([ID]);

    expect(error).toBeNull();
    expect(states.get(ID)).toMatchObject({
      source: "rest",
      updatedAt: expect.any(Number),
    });
    expect(states.get(ID)?.state?.state).toBe("1234.5");
  });

  it("uses the subscription once it is, and says so", async () => {
    startHaLive();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));

    const before = ha.requests.length;
    const { states } = await readStates([ID]);

    expect(states.get(ID)).toMatchObject({ source: "live" });
    expect(ha.requests.length).toBe(before);
  });

  it("reports an entity Home Assistant doesn't have, rather than omitting it", async () => {
    const { states } = await readStates(["sensor.removed_last_week"]);

    // Present in the map with a null state: "we asked and it isn't there" is a
    // different answer from "we never asked", and callers render them
    // differently.
    expect(states.has("sensor.removed_last_week")).toBe(true);
    expect(states.get("sensor.removed_last_week")).toMatchObject({
      state: null,
      updatedAt: null,
    });
  });

  it("reports an unreachable Home Assistant once, for the whole read", async () => {
    process.env.SUPERVISOR_API = "http://127.0.0.1:1/core/api";

    const { states, error } = await readStates([ID, "sensor.grid_power"]);

    expect(error).toMatch(/ECONNREFUSED|fetch failed/);
    expect(states.size).toBe(0);
  });

  it("dates a reading by when it changed, not by when it was read", async () => {
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    ha.setStates([
      {
        entity_id: ID,
        state: "7",
        attributes: { unit_of_measurement: "W" },
        last_changed: anHourAgo,
        last_updated: anHourAgo,
      },
    ]);

    const { states } = await readStates([ID]);

    // Fetched a millisecond ago, and an hour old. Reporting the read time here
    // would be the reassuring lie this whole mechanism exists to prevent.
    const { oldestSeconds } = readingAge(states);
    expect(oldestSeconds).toBeGreaterThan(3_500);
  });
});

describe("readingAge", () => {
  it("reports the oldest of the readings, since that is the weakest link", async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    ha.setStates([
      { entity_id: ID, state: "1", attributes: {} },
      {
        entity_id: "sensor.grid_power",
        state: "2",
        attributes: {},
        last_changed: old,
        last_updated: old,
      },
    ]);

    const { states } = await readStates([ID, "sensor.grid_power"]);

    expect(readingAge(states)).toMatchObject({
      source: "rest",
      oldestSeconds: expect.any(Number),
    });
    expect(readingAge(states).oldestSeconds).toBeGreaterThanOrEqual(120);
  });

  it("has no source to report when nothing was asked for", async () => {
    const { states } = await readStates([]);

    expect(readingAge(states)).toEqual({ source: null, oldestSeconds: null });
  });
});
