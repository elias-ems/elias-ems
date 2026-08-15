/**
 * The write path, against the mock Home Assistant. What matters here is not
 * whether a number reaches an entity — one case covers that — but the
 * decisions around it: what is worth writing at all, what a value is rounded
 * to, and what happens when a write fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HaState } from "../../app/lib/ha.server";
import {
  describeWrites,
  type SetpointTarget,
  WRITE_DEADBAND_W,
  writeSetpoints,
} from "../../app/lib/setpoints.server";
import { defaultStates, startHaMock } from "../ha-mock.js";

let ha: Awaited<ReturnType<typeof startHaMock>>;

/** Nothing listens on port 1, so a request there fails immediately. */
const UNREACHABLE_API = "http://127.0.0.1:1/core/api";

/** The fixture's writable entity: a -5000..5000 range in steps of 100. */
const SETPOINT = "input_number.battery_setpoint";

function state(entityId: string, value: number, step?: number): HaState {
  return {
    entity_id: entityId,
    state: String(value),
    attributes: { min: -5000, max: 5000, ...(step ? { step } : {}) },
  };
}

function target(overrides: Partial<SetpointTarget> = {}): SetpointTarget {
  return {
    batteryId: "b1",
    title: "Home battery",
    entityId: SETPOINT,
    state: state(SETPOINT, 0),
    commandW: -800,
    ...overrides,
  };
}

/** Every set_value the mock has been asked for, as [entity, value] pairs. */
function calls(): Array<[string, unknown]> {
  return ha.serviceCalls
    .filter((call) => call.service === "set_value")
    .map((call) => [
      String((call.data as { entity_id?: string }).entity_id),
      (call.data as { value?: unknown }).value,
    ]);
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

beforeEach(async () => {
  process.env.SUPERVISOR_API = ha.apiUrl;
  ha.setStates(await defaultStates());
  ha.serviceCalls.length = 0;
});

describe("writeSetpoints", () => {
  it("sets the value through the entity's own domain service", async () => {
    const [write] = await writeSetpoints([target()]);

    expect(write).toMatchObject({ status: "written", valueW: -800 });
    expect(calls()).toEqual([[SETPOINT, -800]]);
  });

  it("uses number.set_value for a number entity", async () => {
    // Same shape, different domain: the service name comes from the entity id
    // rather than being assumed, since the two are not interchangeable.
    await writeSetpoints([
      target({
        entityId: "number.battery_target_power",
        state: state("number.battery_target_power", 0),
        commandW: 400,
      }),
    ]);

    expect(ha.serviceCalls[0]).toMatchObject({
      domain: "number",
      service: "set_value",
    });
  });

  it("writes nothing when the decision was to leave the battery alone", async () => {
    const [write] = await writeSetpoints([target({ commandW: null })]);

    expect(write).toMatchObject({ status: "skipped", valueW: null });
    expect(calls()).toEqual([]);
  });

  it("writes nothing when the entity already reads what we want", async () => {
    // The loop can tick every second against a house that is never still. A
    // service call per tick would be thousands an hour, against hardware that
    // on some brands commits setpoints to flash.
    const [write] = await writeSetpoints([
      target({
        state: state(SETPOINT, -800 + (WRITE_DEADBAND_W - 1)),
        commandW: -800,
      }),
    ]);

    expect(write.status).toBe("unchanged");
    expect(calls()).toEqual([]);
  });

  it("writes again once the difference clears the deadband", async () => {
    const [write] = await writeSetpoints([
      target({
        state: state(SETPOINT, -800 + WRITE_DEADBAND_W),
        commandW: -800,
      }),
    ]);

    expect(write.status).toBe("written");
  });

  it("corrects an entity something else moved, with nothing remembered", async () => {
    // The deadband compares against what the entity says now, not against what
    // we last sent, so a value changed behind our back is simply a difference
    // and gets written back on the next tick.
    const [write] = await writeSetpoints([
      target({ state: state(SETPOINT, 2500), commandW: -800 }),
    ]);

    expect(write.status).toBe("written");
    expect(calls()).toEqual([[SETPOINT, -800]]);
  });

  it("rounds to the entity's own step", async () => {
    // A device that quantises 582 to 600 and reports the rounded value back
    // would otherwise leave a permanent gap between what we asked for and what
    // we read, and on a coarse enough step the deadband would stop hiding it.
    const [write] = await writeSetpoints([
      target({ state: state(SETPOINT, 0, 100), commandW: 582 }),
    ]);

    expect(write.valueW).toBe(600);
    expect(calls()).toEqual([[SETPOINT, 600]]);
  });

  it("refuses a domain it has no set_value for rather than guessing", async () => {
    const [write] = await writeSetpoints([
      target({ entityId: "sensor.battery_power", state: null }),
    ]);

    expect(write.status).toBe("unsupported");
    expect(calls()).toEqual([]);
  });

  it("reports a rejected write instead of throwing", async () => {
    // 9000 is outside the entity's own -5000..5000, which the mock refuses the
    // way Home Assistant does. A write that fails is one battery not doing as
    // it was told — worth a log line and another go next tick, not the end of
    // the control loop.
    const [write] = await writeSetpoints([target({ commandW: 9000 })]);

    expect(write.status).toBe("failed");
    expect(write.detail).toBeTruthy();
  });

  it("reports an unreachable Home Assistant instead of throwing", async () => {
    process.env.SUPERVISOR_API = UNREACHABLE_API;

    const [write] = await writeSetpoints([target()]);

    expect(write.status).toBe("failed");
  });

  it("keeps writing the other batteries when one of them fails", async () => {
    const writes = await writeSetpoints([
      target({ batteryId: "bad", entityId: "light.hallway", state: null }),
      target({ batteryId: "good" }),
    ]);

    expect(writes.map((write) => write.status)).toEqual([
      "unsupported",
      "written",
    ]);
    expect(calls()).toEqual([[SETPOINT, -800]]);
  });
});

describe("describeWrites", () => {
  it("says nothing when nothing was written", async () => {
    const writes = await writeSetpoints([target({ commandW: null })]);

    expect(describeWrites(writes)).toBeNull();
  });

  it("names what was written", async () => {
    const writes = await writeSetpoints([target()]);

    expect(describeWrites(writes)).toBe("Wrote: Home battery → -800 W");
  });

  it("names the trouble but only counts the quiet ones", async () => {
    // A balanced house produces a full set of skips every tick. Spelling each
    // one out would bury the writes that did happen under lines saying nothing
    // happened.
    const writes = await writeSetpoints([
      target({ batteryId: "quiet", commandW: null }),
      target({ batteryId: "bad", entityId: "light.hallway", state: null }),
    ]);

    const described = describeWrites(writes);
    expect(described).toContain("write unsupported");
    expect(described).not.toContain("skipped");
  });
});
