/**
 * Curtailment's publish path, against the mock Home Assistant. The sibling of
 * `targets.test.ts`, and the same split of concerns: not whether an event
 * reaches the bus — one case covers that — but what is worth saying at all,
 * what the payload has to carry for an automation to act on it, and what
 * happens when Home Assistant cannot be reached.
 *
 * The restatement case turns on elapsed time, so `Date` is faked and nothing
 * else is: the publish itself is real I/O against the mock, and faking the
 * timers behind it would stall the request rather than hurry it along.
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
import {
  describePvLimitPublishes,
  forgetPublishedLimit,
  forgetPublishedLimits,
  type PvLimitCommand,
  publishPvLimits,
  REPUBLISH_MS,
} from "../../app/lib/pv-limits.server";
import { startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;

/** Nothing listens on port 1, so a request there fails immediately. */
const UNREACHABLE_API = "http://127.0.0.1:1/core/api";

function command(overrides: Partial<PvLimitCommand> = {}): PvLimitCommand {
  return {
    arrayId: "a1",
    title: "South roof",
    slug: "south_roof",
    ratedPowerW: 5000,
    commandPercent: 40,
    released: false,
    ...overrides,
  };
}

/** Every limit event fired so far, as the payloads an automation would see. */
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
  // each case starts with an array that has never been told anything.
  forgetPublishedLimits();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("publishPvLimits", () => {
  it("fires an event named after the array, carrying what an automation needs", async () => {
    const [publish] = await publishPvLimits([command()]);

    expect(publish).toMatchObject({ status: "published", percent: 40 });
    expect(ha.events.map((event) => event.eventType)).toEqual([
      "elias_ems_south_roof_pv_limit",
    ]);
    expect(fired()).toEqual([
      {
        slug: "south_roof",
        array_id: "a1",
        title: "South roof",
        limit_percent: 40,
        // Both forms, because some inverters take a percentage of nameplate
        // and others an export setpoint in watts. Doing the arithmetic here
        // keeps it out of an automation, where it is easy to get wrong.
        limit_w: 2000,
        rated_power_w: 5000,
        released: false,
      },
    ]);
  });

  it("says nothing at all when the decision was to leave the array alone", async () => {
    const [publish] = await publishPvLimits([
      command({ commandPercent: null }),
    ]);

    expect(publish.status).toBe("skipped");
    expect(ha.events).toEqual([]);
  });

  it("does not repeat a limit that has not moved", async () => {
    await publishPvLimits([command()]);
    const [second] = await publishPvLimits([command()]);

    // On the other end of each event is an automation writing to real
    // hardware, which on some brands commits every change to flash.
    expect(second.status).toBe("unchanged");
    expect(ha.events).toHaveLength(1);
  });

  it("publishes as soon as the limit moves by a single step", async () => {
    await publishPvLimits([command({ commandPercent: 40 })]);
    const [second] = await publishPvLimits([command({ commandPercent: 41 })]);

    // No deadband beside this, unlike a battery target: the strategy has
    // already quantised to whole percent, so "the value changed" is exactly
    // "it moved by at least one step".
    expect(second.status).toBe("published");
    expect(ha.events).toHaveLength(2);
  });

  it("restates a standing limit once it is old enough", async () => {
    vi.useFakeTimers();
    await publishPvLimits([command()]);

    await vi.advanceTimersByTimeAsync(REPUBLISH_MS);
    const [second] = await publishPvLimits([command()]);

    // The memory of what was published is an assumption about what an
    // automation did with an event, and this is what stops it being an
    // indefinite one: a reloaded automation or a power-cycled inverter
    // recovers on its own rather than waiting for the limit to happen to move.
    expect(second.status).toBe("published");
  });

  it("publishes a release even when it believes the array is already there", async () => {
    await publishPvLimits([command({ commandPercent: 100 })]);
    ha.events.length = 0;

    const [publish] = await publishPvLimits([
      command({ commandPercent: 100, released: true, force: true }),
    ]);

    // Letting go is worth one event regardless of what we think, because what
    // we think is the very thing in doubt at the moment we stop steering.
    expect(publish.status).toBe("published");
    expect(fired()[0]).toMatchObject({ limit_percent: 100, released: true });
  });

  it("reports a failure without recording it as said", async () => {
    process.env.SUPERVISOR_API = UNREACHABLE_API;

    const [failed] = await publishPvLimits([command()]);
    expect(failed.status).toBe("failed");

    // An event that never made it onto the bus must not count as something the
    // array has been told, or the next tick would decide it had already said
    // this and skip the retry.
    process.env.SUPERVISOR_API = ha.apiUrl;
    const [retried] = await publishPvLimits([command()]);
    expect(retried.status).toBe("published");
  });

  it("publishes each array independently of its neighbour", async () => {
    // One array's event failing must not stop another being told what to do,
    // which is why nothing here rejects.
    const publishes = await publishPvLimits([
      command({ arrayId: "a1", slug: "south_roof" }),
      command({ arrayId: "a2", slug: "east_roof", title: "East roof" }),
    ]);

    expect(publishes.map((publish) => publish.status)).toEqual([
      "published",
      "published",
    ]);
  });
});

describe("forgetPublishedLimit", () => {
  it("forgets one array without disturbing the others", async () => {
    await publishPvLimits([
      command({ arrayId: "a1" }),
      command({ arrayId: "a2", slug: "east_roof" }),
    ]);
    ha.events.length = 0;

    // What a released array is given next must not look like a repeat of the
    // limit it no longer holds.
    forgetPublishedLimit("a1");
    const publishes = await publishPvLimits([
      command({ arrayId: "a1" }),
      command({ arrayId: "a2", slug: "east_roof" }),
    ]);

    expect(publishes.map((publish) => publish.status)).toEqual([
      "published",
      "unchanged",
    ]);
  });
});

describe("describePvLimitPublishes", () => {
  it("names what went out and leaves out what did not", async () => {
    const line = describePvLimitPublishes([
      {
        arrayId: "a1",
        title: "South roof",
        slug: "s",
        percent: 40,
        status: "published",
      },
      {
        arrayId: "a2",
        title: "East roof",
        slug: "e",
        percent: 40,
        status: "unchanged",
      },
      {
        arrayId: "a3",
        title: "Shed",
        slug: "h",
        percent: null,
        status: "skipped",
      },
    ]);

    // A house sitting inside the deadband produces a full set of unchanged and
    // skipped limits every tick; spelling each one out would bury the ones
    // that did go out under lines saying nothing happened.
    expect(line).toBe("Published: South roof → 40%");
  });

  it("says nothing when nothing happened", () => {
    expect(
      describePvLimitPublishes([
        {
          arrayId: "a1",
          title: "South roof",
          slug: "s",
          percent: 40,
          status: "unchanged",
        },
      ]),
    ).toBeNull();
  });

  it("names a failure, since a silent one is the worst kind", () => {
    const line = describePvLimitPublishes([
      {
        arrayId: "a1",
        title: "South roof",
        slug: "s",
        percent: 40,
        status: "failed",
        detail: "connect ECONNREFUSED",
      },
    ]);

    expect(line).toContain("South roof: event failed (connect ECONNREFUSED)");
  });
});
