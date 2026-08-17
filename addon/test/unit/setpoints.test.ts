/**
 * The publish path, against the mock Home Assistant. What matters here is not
 * whether an event reaches the bus — one case covers that — but the decisions
 * around it: what is worth saying at all, what the payload has to carry for an
 * automation to act on it, and what happens when Home Assistant cannot be
 * reached.
 *
 * The deadband cases turn on elapsed time, so `Date` is faked and nothing else
 * is: the publish itself is real I/O against the mock, and faking the timers
 * behind it would stall the request rather than hurry it along.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setpointEventType } from "../../app/lib/batteries";
import {
  describePublishes,
  forgetPublishedSetpoints,
  PUBLISH_DEADBAND_W,
  publishSetpoints,
  REPUBLISH_MS,
  type SetpointTarget,
} from "../../app/lib/setpoints.server";
import { startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;

/** Nothing listens on port 1, so a request there fails immediately. */
const UNREACHABLE_API = "http://127.0.0.1:1/core/api";

function target(overrides: Partial<SetpointTarget> = {}): SetpointTarget {
  return {
    batteryId: "b1",
    title: "Home battery",
    slug: "home_battery",
    commandW: -800,
    ...overrides,
  };
}

/** Every setpoint event fired so far, as the payloads an automation would see. */
function fired(): Array<Record<string, unknown>> {
  return ha.events
    .filter((event) => event.eventType.startsWith("elias_ems_"))
    .map((event) => event.data as Record<string, unknown>);
}

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

beforeEach(() => {
  process.env.SUPERVISOR_API = ha.apiUrl;
  ha.events.length = 0;
  // What was last published outlives a test the way it outlives a tick, so
  // each case starts with a battery that has never been told anything.
  forgetPublishedSetpoints();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("publishSetpoints", () => {
  it("fires an event named after the battery, carrying what an automation needs", async () => {
    const [publish] = await publishSetpoints([target()]);

    expect(publish).toMatchObject({ status: "published", valueW: -800 });
    // The battery is named by the event type, so an automation's trigger says
    // which battery it is for in the line hardest to get wrong.
    expect(ha.events.map((event) => event.eventType)).toEqual([
      "elias_ems_home_battery_target",
    ]);
    expect(fired()).toEqual([
      {
        slug: "home_battery",
        battery_id: "b1",
        title: "Home battery",
        power_w: -800,
        // The signed value split by direction: an inverter with separate
        // charge and discharge registers wants a magnitude, not a sign.
        charge_w: 0,
        discharge_w: 800,
        released: false,
      },
    ]);
  });

  it("splits a charge the other way round", async () => {
    await publishSetpoints([target({ commandW: 1200 })]);

    expect(fired()[0]).toMatchObject({
      power_w: 1200,
      charge_w: 1200,
      discharge_w: 0,
    });
  });

  it("rounds to whole watts", async () => {
    // There is no entity step to snap to any more, and a setpoint carried to
    // fifteen decimals only makes an automation's trace harder to read.
    await publishSetpoints([target({ commandW: -561.3333333 })]);

    expect(fired()[0]).toMatchObject({ power_w: -561 });
  });

  it("says nothing when the decision was to leave the battery alone", async () => {
    const [publish] = await publishSetpoints([target({ commandW: null })]);

    expect(publish).toMatchObject({ status: "skipped", valueW: null });
    expect(fired()).toEqual([]);
  });

  it("says nothing again while the setpoint has barely moved", async () => {
    // The loop can tick every second against a house that is never still. An
    // event per tick would be thousands an hour, and on the other end of each
    // one is an automation writing to real hardware.
    await publishSetpoints([target()]);
    const [publish] = await publishSetpoints([
      target({ commandW: -800 + (PUBLISH_DEADBAND_W - 1) }),
    ]);

    expect(publish.status).toBe("unchanged");
    expect(fired()).toHaveLength(1);
  });

  it("publishes again once the move clears the deadband", async () => {
    await publishSetpoints([target()]);
    const [publish] = await publishSetpoints([
      target({ commandW: -800 + PUBLISH_DEADBAND_W }),
    ]);

    expect(publish.status).toBe("published");
    expect(fired()).toHaveLength(2);
  });

  it("restates a setpoint that has gone stale, even though nothing moved", async () => {
    // The deadband compares against what we last published, not against what
    // the battery is set to — an event has no read-back. Without this, an
    // automation reloaded or an inverter power-cycled after the last publish
    // would be left at whatever it happened to be doing until the house moved
    // by 50 W.
    vi.useFakeTimers({ toFake: ["Date"] });

    await publishSetpoints([target()]);
    vi.advanceTimersByTime(REPUBLISH_MS);
    const [publish] = await publishSetpoints([target()]);

    expect(publish.status).toBe("published");
    expect(fired()).toHaveLength(2);
  });

  it("publishes past the deadband when it is told to let go", async () => {
    // Releasing is worth one event even when we think the battery is already
    // at 0, because what we think is the very thing in doubt when something
    // has gone wrong enough to be stopping.
    await publishSetpoints([target({ commandW: 0 })]);
    const [publish] = await publishSetpoints([
      target({ commandW: 0, force: true }),
    ]);

    expect(publish.status).toBe("published");
    expect(fired()).toHaveLength(2);
    // And it says which of the two kinds of zero this is, so an automation
    // that has to put an inverter back into self-consumption has something to
    // trigger on.
    expect(fired()[0]).toMatchObject({ released: false });
    expect(fired()[1]).toMatchObject({ released: true });
  });

  it("gives each battery its own event type", async () => {
    await publishSetpoints([
      target(),
      target({
        batteryId: "b2",
        title: "Garage battery",
        slug: "garage_battery",
      }),
    ]);

    expect(ha.events.map((event) => event.eventType)).toEqual([
      setpointEventType("home_battery"),
      setpointEventType("garage_battery"),
    ]);
  });

  it("holds each battery's deadband on its own", async () => {
    // Two batteries rarely move together — one at its SoC ceiling or pinned at
    // its power cap sits still while its neighbour takes the whole swing — and
    // a shared event would wake every automation in the house for that.
    const garage = { batteryId: "b2", title: "Garage battery", slug: "garage" };
    await publishSetpoints([target(), target(garage)]);
    ha.events.length = 0;

    const publishes = await publishSetpoints([
      target({ commandW: -2000 }),
      target(garage),
    ]);

    expect(publishes.map((publish) => publish.status)).toEqual([
      "published",
      "unchanged",
    ]);
    expect(ha.events.map((event) => event.eventType)).toEqual([
      setpointEventType("home_battery"),
    ]);
  });

  it("reports an unreachable Home Assistant instead of throwing", async () => {
    process.env.SUPERVISOR_API = UNREACHABLE_API;

    const publishes = await publishSetpoints([
      target({ batteryId: "b1" }),
      target({ batteryId: "b2", title: "Garage battery", slug: "garage" }),
    ]);

    // Nothing rejects: one battery's event failing must not stop its
    // neighbour's, and the loop wants every outcome as a value it can log.
    expect(publishes.map((publish) => publish.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(publishes[0].detail).toBeTruthy();
  });

  it("does not remember a setpoint that never made it out", async () => {
    // Otherwise the deadband would suppress the retry, and one blip would
    // leave the battery on a stale setpoint until the house moved by 50 W.
    process.env.SUPERVISOR_API = UNREACHABLE_API;
    await publishSetpoints([target()]);

    process.env.SUPERVISOR_API = ha.apiUrl;
    const [publish] = await publishSetpoints([target()]);

    expect(publish.status).toBe("published");
    expect(fired()).toHaveLength(1);
  });
});

describe("describePublishes", () => {
  it("says nothing when nothing went out", async () => {
    const publishes = await publishSetpoints([target({ commandW: null })]);

    expect(describePublishes(publishes)).toBeNull();
  });

  it("names what went out", async () => {
    const publishes = await publishSetpoints([target()]);

    expect(describePublishes(publishes)).toBe(
      "Published: Home battery → -800 W",
    );
  });

  it("names the trouble but only counts the quiet ones", async () => {
    // A balanced house produces a full set of skips every tick. Spelling each
    // one out would bury the setpoints that did go out under lines saying
    // nothing happened.
    process.env.SUPERVISOR_API = UNREACHABLE_API;
    const publishes = await publishSetpoints([
      target({ batteryId: "quiet", commandW: null }),
      target({ batteryId: "bad", title: "Garage battery", slug: "garage" }),
    ]);

    const described = describePublishes(publishes);
    expect(described).toContain("Garage battery: event failed");
    expect(described).not.toContain("skipped");
  });
});
