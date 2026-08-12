import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  haLiveStatus,
  liveStates,
  onHaChange,
  startHaLive,
  stopHaLive,
} from "../../app/lib/ha-live.server";
import { startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;

beforeEach(async () => {
  ha = await startHaMock();
  process.env.SUPERVISOR_WS = ha.wsUrl;
  process.env.SUPERVISOR_TOKEN = ha.token;
});

afterEach(async () => {
  // Before the mock: an open socket both keeps node's event loop alive and
  // reconnects to a server that is on its way out.
  stopHaLive();
  await ha.close();
  delete process.env.SUPERVISOR_WS;
  delete process.env.SUPERVISOR_TOKEN;
});

/** The state of one entity as the cache currently has it. */
const cached = (entityId: string) =>
  liveStates([entityId])?.get(entityId)?.state;

describe("the live subscription", () => {
  it("authenticates, reads every state once, and subscribes", async () => {
    startHaLive();

    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));

    // The seed is what makes entities that never change readable at all —
    // events alone would only ever mention the ones that move.
    expect(cached("sensor.inverter_power")).toBe("1234.5");
    expect(haLiveStatus().entities).toBeGreaterThan(1);
    expect(ha.subscriberCount()).toBe(1);
  });

  it("has nothing to say before it is connected", async () => {
    // Null is the signal to read over REST instead. An empty map would be a
    // claim that Home Assistant has no such entities.
    expect(liveStates(["sensor.inverter_power"])).toBeNull();

    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));
    expect(liveStates(["sensor.inverter_power"])).not.toBeNull();
  });

  it("applies a state change and names what moved", async () => {
    startHaLive();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));

    const changes: Array<string | null> = [];
    const unsubscribe = onHaChange((changed) => changes.push(changed));

    ha.setState("sensor.inverter_power", "2000", {
      unit_of_measurement: "W",
    });

    await vi.waitFor(() =>
      expect(cached("sensor.inverter_power")).toBe("2000"),
    );
    expect(changes).toContain("sensor.inverter_power");

    unsubscribe();
  });

  it("forgets an entity Home Assistant removes", async () => {
    startHaLive();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));

    // A null new_state is a removal, not a quiet sensor. Keeping the last known
    // value would leave the page showing a number for something gone.
    ha.removeState("sensor.inverter_power");

    await vi.waitFor(() =>
      expect(cached("sensor.inverter_power")).toBeUndefined(),
    );
    // Still connected, so the map is still authoritative — it simply reports
    // this entity as missing, exactly as REST's 404 would.
    expect(
      liveStates(["sensor.inverter_power"])?.get("sensor.inverter_power"),
    ).toBeNull();
  });

  it("reconnects after Home Assistant hangs up, and re-reads what it missed", async () => {
    startHaLive();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));

    ha.dropSockets();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(false));

    // Changed while nobody was listening: no event for this will ever be
    // delivered, so only a fresh seed can produce it.
    ha.setState("sensor.inverter_power", "4242", {
      unit_of_measurement: "W",
    });

    await vi.waitFor(
      () => expect(cached("sensor.inverter_power")).toBe("4242"),
      { timeout: 10_000 },
    );
  });

  it("says so when the token is refused, rather than looking unreachable", async () => {
    process.env.SUPERVISOR_TOKEN = "not-the-right-token";
    startHaLive();

    await vi.waitFor(() =>
      expect(haLiveStatus().lastError).toMatch(/rejected the token/),
    );
    expect(haLiveStatus().connected).toBe(false);
  });

  it("stays quiet outside Home Assistant, where there is no token", async () => {
    delete process.env.SUPERVISOR_TOKEN;
    startHaLive();

    expect(haLiveStatus()).toMatchObject({
      connected: false,
      lastError: "SUPERVISOR_TOKEN is not set",
    });
    // Nothing was dialled, so nothing has to be given up on.
    expect(ha.subscriberCount()).toBe(0);
  });
});
