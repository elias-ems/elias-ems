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
  // The liveness clock, compressed: 300ms between pings, so the deadlines
  // derived from it (100ms for a pong, 150ms for a handshake) are reachable in
  // a test rather than in the half-minute the real defaults take.
  process.env.HA_HEARTBEAT_MS = "300";
});

afterEach(async () => {
  // Before the mock: an open socket both keeps node's event loop alive and
  // reconnects to a server that is on its way out.
  stopHaLive();
  await ha.close();
  delete process.env.SUPERVISOR_WS;
  delete process.env.SUPERVISOR_TOKEN;
  delete process.env.HA_HEARTBEAT_MS;
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

  it("hangs up on a socket that has gone mute, and comes back", async () => {
    startHaLive();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));

    // Open, and answering nothing — a dropped route, a NAT table that forgot
    // us. No `close` will ever fire, and a quiet Home Assistant looks exactly
    // like this, so only the unanswered ping can tell the difference.
    ha.goSilent();

    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(false), {
      timeout: 10_000,
    });
    expect(haLiveStatus().lastError).toMatch(/stopped answering/);

    ha.stopSilent();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true), {
      timeout: 20_000,
    });
    expect(haLiveStatus().reconnects).toBeGreaterThan(0);
  }, 30_000);

  it("does not let an older state overwrite a newer one", async () => {
    startHaLive();
    await vi.waitFor(() => expect(haLiveStatus().connected).toBe(true));

    ha.setState("sensor.inverter_power", "500", { unit_of_measurement: "W" });
    await vi.waitFor(() => expect(cached("sensor.inverter_power")).toBe("500"));

    // Ordering makes this impossible against a real Home Assistant, which is
    // why it is worth pinning: a seed landing on top of a newer event would put
    // the cache quietly in the past, and nothing downstream could tell.
    ha.pushState({
      entity_id: "sensor.inverter_power",
      state: "1",
      attributes: { unit_of_measurement: "W" },
      last_updated: new Date(Date.now() - 60_000).toISOString(),
      last_changed: new Date(Date.now() - 60_000).toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cached("sensor.inverter_power")).toBe("500");
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
