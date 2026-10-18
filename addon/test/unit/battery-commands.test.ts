/**
 * The battery command publish path, against the mock Home Assistant. What
 * matters here is not whether an event reaches the bus — one case covers that —
 * but the decisions around it: what is worth saying at all, what the payload
 * has to carry for an automation to act on it, which strategy may let go of
 * which battery, and what happens when Home Assistant cannot be reached.
 *
 * The restatement cases turn on elapsed time, so `Date` is faked and nothing
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
  balanceCommand,
  commandEventType,
  commandPayload,
  setpointCommand,
} from "../../app/lib/battery-command";
import {
  type CommandRequest,
  commandOwner,
  describePublishes,
  forgetPublishedCommands,
  ownerEpoch,
  PUBLISH_DEADBAND_W,
  publishCommands,
  publishedSetpointW,
  releaseCommands,
} from "../../app/lib/battery-commands.server";
import { startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;

/** Nothing listens on port 1, so a request there fails immediately. */
const UNREACHABLE_API = "http://127.0.0.1:1/core/api";
const NOW = Date.parse("2026-10-18T12:00:00Z");
const UNCAPPED = { maxChargeW: null, maxDischargeW: null };

function request(
  targetW: number | null,
  overrides: Partial<CommandRequest> = {},
): CommandRequest {
  return {
    batteryId: "b1",
    title: "Home battery",
    slug: "home_battery",
    strategy: "net-zero-energy",
    command:
      targetW === null
        ? null
        : setpointCommand(targetW, UNCAPPED, NOW, NOW + 180_000),
    restateAt: Date.now() + 30_000,
    deadbandW: PUBLISH_DEADBAND_W,
    ...overrides,
  };
}

const garage = { batteryId: "b2", title: "Garage battery", slug: "garage" };

/** Every command event fired so far, as the payloads an automation would see. */
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
  forgetPublishedCommands();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("commands", () => {
  it("maps a signed target onto charge, discharge and hold", () => {
    expect(setpointCommand(1200, UNCAPPED, 0, 1)).toMatchObject({
      mode: "charge",
      setpointW: 1200,
    });
    expect(setpointCommand(-561.4, UNCAPPED, 0, 1)).toMatchObject({
      mode: "discharge",
      setpointW: -561,
    });
    // Zero battery power is a mode of its own, not a balanced meter.
    expect(setpointCommand(0.3, UNCAPPED, 0, 1)).toMatchObject({
      mode: "hold",
      setpointW: 0,
    });
  });

  it("gives balance boundaries and no setpoint", () => {
    expect(
      commandPayload(
        {
          slug: "s",
          batteryId: "b",
          title: "t",
          commandId: "c",
          ownerEpoch: "e",
          issuedAt: NOW,
        },
        {
          action: "apply",
          strategy: "charge-limit",
          command: balanceCommand(
            { chargeLimitW: 1500.4, dischargeLimitW: null },
            NOW,
            NOW + 900_000,
          ),
        },
      ),
    ).toMatchObject({
      mode: "balance",
      setpoint_w: null,
      charge_w: 0,
      discharge_w: 0,
      charge_limit_w: 1500,
      discharge_limit_w: null,
      valid_until: new Date(NOW + 900_000).toISOString(),
    });
  });
});

describe("publishCommands", () => {
  it("fires an event named after the battery, carrying what an automation needs", async () => {
    const [publish] = await publishCommands([request(-800)]);

    expect(publish.status).toBe("published");
    expect(ha.events.map((event) => event.eventType)).toEqual([
      "elias_ems_home_battery_battery_command",
    ]);
    expect(fired()).toEqual([
      {
        schema_version: 1,
        slug: "home_battery",
        battery_id: "b1",
        title: "Home battery",
        command_id: expect.any(String),
        owner_epoch: ownerEpoch(),
        issued_at: expect.any(String),
        action: "apply",
        strategy: "net-zero-energy",
        released: false,
        mode: "discharge",
        setpoint_w: -800,
        // The signed value split by direction: an inverter with separate
        // charge and discharge registers wants a magnitude, not a sign.
        charge_w: 0,
        discharge_w: 800,
        charge_limit_w: null,
        discharge_limit_w: null,
        grid_charging: false,
        battery_export: false,
        valid_from: new Date(NOW).toISOString(),
        valid_until: new Date(NOW + 180_000).toISOString(),
        release_reason: null,
      },
    ]);
    expect(publishedSetpointW("b1")).toBe(-800);
  });

  it("gives every command its own id", async () => {
    await publishCommands([request(-800)]);
    await publishCommands([request(800)]);

    const [first, second] = fired();
    expect(first.command_id).not.toBe(second.command_id);
  });

  it("says nothing when the decision was to leave the battery alone", async () => {
    const [publish] = await publishCommands([request(null)]);

    expect(publish.status).toBe("skipped");
    expect(fired()).toEqual([]);
  });

  it("says nothing again while the setpoint has barely moved", async () => {
    await publishCommands([request(-800)]);
    const [publish] = await publishCommands([
      request(-800 + (PUBLISH_DEADBAND_W - 1)),
    ]);

    expect(publish.status).toBe("unchanged");
    expect(fired()).toHaveLength(1);
  });

  it("publishes again once the move clears the deadband", async () => {
    await publishCommands([request(-800)]);
    const [publish] = await publishCommands([
      request(-800 + PUBLISH_DEADBAND_W),
    ]);

    expect(publish.status).toBe("published");
  });

  it("publishes a change of mode however small the watts", async () => {
    // -20 W and 0 W are inside the deadband, but discharge and hold are
    // different instructions to an adapter.
    await publishCommands([request(-20)]);
    const [publish] = await publishCommands([request(0)]);

    expect(publish.status).toBe("published");
  });

  it("publishes any change to a boundary", async () => {
    const limits = (chargeLimitW: number) =>
      request(null, {
        strategy: "charge-limit",
        command: balanceCommand(
          { chargeLimitW, dischargeLimitW: null },
          NOW,
          NOW + 1,
        ),
      });
    await publishCommands([limits(1500)]);
    const [publish] = await publishCommands([limits(1510)]);

    expect(publish.status).toBe("published");
  });

  it("restates a command once its restatement is due, even though nothing moved", async () => {
    // An event has no read-back. Without this, an automation reloaded or an
    // inverter power-cycled after the last publish would be left at whatever
    // it happened to be doing until the house moved.
    vi.useFakeTimers({ toFake: ["Date"] });

    await publishCommands([request(-800)]);
    vi.advanceTimersByTime(30_000);
    const [publish] = await publishCommands([request(-800)]);

    expect(publish.status).toBe("published");
    expect(fired()).toHaveLength(2);
  });

  it("holds each battery's deadband on its own", async () => {
    await publishCommands([request(-800), request(-800, garage)]);
    ha.events.length = 0;

    const publishes = await publishCommands([
      request(-2000),
      request(-800, garage),
    ]);

    expect(publishes.map((publish) => publish.status)).toEqual([
      "published",
      "unchanged",
    ]);
    expect(ha.events.map((event) => event.eventType)).toEqual([
      commandEventType("home_battery"),
    ]);
  });

  it("reports an unreachable Home Assistant instead of throwing", async () => {
    process.env.SUPERVISOR_API = UNREACHABLE_API;

    const publishes = await publishCommands([
      request(-800),
      request(-800, garage),
    ]);

    expect(publishes.map((publish) => publish.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(publishes[0].detail).toBeTruthy();
  });

  it("does not remember a command that never made it out", async () => {
    process.env.SUPERVISOR_API = UNREACHABLE_API;
    await publishCommands([request(-800)]);

    process.env.SUPERVISOR_API = ha.apiUrl;
    const [publish] = await publishCommands([request(-800)]);

    expect(publish.status).toBe("published");
    expect(fired()).toHaveLength(1);
  });
});

describe("releaseCommands", () => {
  const target = {
    batteryId: "b1",
    title: "Home battery",
    slug: "home_battery",
  };

  it("lets go past the deadband, and says it is a release rather than a hold", async () => {
    await publishCommands([request(0)]);
    const [release] = await releaseCommands([target], "disabled", {
      strategy: "net-zero-energy",
    });

    expect(release.status).toBe("published");
    expect(fired()[1]).toMatchObject({
      action: "release",
      released: true,
      mode: null,
      setpoint_w: null,
      release_reason: "disabled",
      strategy: "net-zero-energy",
    });
    expect(commandOwner("b1")).toBeNull();
    expect(publishedSetpointW("b1")).toBeNull();
  });

  it("does not release a battery another strategy has taken over", async () => {
    await publishCommands([
      request(null, {
        strategy: "charge-limit",
        command: balanceCommand(
          { chargeLimitW: 1000, dischargeLimitW: null },
          NOW,
          NOW + 1,
        ),
      }),
    ]);
    const publishes = await releaseCommands([target], "disabled", {
      strategy: "net-zero-energy",
    });

    expect(publishes).toEqual([]);
    expect(commandOwner("b1")).toBe("charge-limit");
  });

  it("releases a battery nothing in this process has told anything", async () => {
    // What an earlier process said is exactly what is in doubt.
    const [release] = await releaseCommands([target], "disabled", {
      strategy: "net-zero-energy",
    });

    expect(release.status).toBe("published");
  });

  it("only releases what is known to be held when asked to", async () => {
    expect(
      await releaseCommands([target], "disabled", {
        strategy: "charge-limit",
        onlyIfHeld: true,
      }),
    ).toEqual([]);
  });

  it("publishes the next command after a release", async () => {
    await publishCommands([request(-800)]);
    await releaseCommands([target], "shutdown");
    const [publish] = await publishCommands([request(-800)]);

    expect(publish.status).toBe("published");
  });
});

describe("describePublishes", () => {
  it("says nothing when nothing went out", async () => {
    const publishes = await publishCommands([request(null)]);

    expect(describePublishes(publishes)).toBeNull();
  });

  it("names what went out", async () => {
    const publishes = await publishCommands([request(-800)]);

    expect(describePublishes(publishes)).toBe(
      "Published: Home battery → discharge 800 W",
    );
  });

  it("names the trouble but leaves the quiet ones out", async () => {
    process.env.SUPERVISOR_API = UNREACHABLE_API;
    const publishes = await publishCommands([
      request(null, { batteryId: "quiet" }),
      request(-800, garage),
    ]);

    const described = describePublishes(publishes);
    expect(described).toContain("Garage battery: event failed");
    expect(described).not.toContain("Home battery");
  });
});
