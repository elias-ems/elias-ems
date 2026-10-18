import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { ChargeLimitsData } from "../../app/lib/charge-limit-status";
import {
  chargeBatteryFixture,
  chargeEntityFixture,
  chargeForecastFixture,
} from "../charge-forecast-fixture.js";
import { defaultStates } from "../ha-mock.js";
import { startStack } from "../stack.js";

let directory: string;
let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => {
  directory = await mkdtemp(
    path.join(os.tmpdir(), "elias-charge-integration-"),
  );
  await writeFile(
    path.join(directory, "batteries.json"),
    JSON.stringify([
      { ...chargeBatteryFixture, dischargeLimitSupported: true },
    ]),
  );
  // An upgrade mid-plan: the version before the battery command event had
  // capped this entity at 200 W and journalled its original 2000 W.
  await writeFile(
    path.join(directory, "charge-limit-leases.json"),
    JSON.stringify([
      {
        batteryId: chargeBatteryFixture.id,
        entityId: chargeEntityFixture.entity_id,
        originalW: 2000,
        previousW: 2000,
        requestedW: 200,
        at: Date.now() - 600_000,
      },
    ]),
  );
  await writeFile(
    path.join(directory, "prices.json"),
    JSON.stringify({
      source: "home-assistant",
      forecastEntityId: "sensor.energi_epex_spot",
      consumptionFormula: "price + 0.15",
      productionFormula: "price",
    }),
  );
  await writeFile(
    path.join(directory, "control.json"),
    JSON.stringify({
      enabled: true,
      strategy: "charge-limit",
      intervalSeconds: 5,
    }),
  );
  stack = await startStack({
    dataDir: directory,
    haStates: [
      ...(await defaultStates()),
      { ...chargeEntityFixture, state: "200" },
      { ...chargeEntityFixture, entity_id: "number.ac_output", state: "1700" },
    ],
    haCommandResults: chargeForecastFixture(),
  });
});
afterAll(async () => {
  await stack?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** Battery commands the add-on has published, as payloads. */
const commands = () =>
  stack.ha.events
    .filter((event) => event.eventType.endsWith("_battery_command"))
    .map((event) => event.data as Record<string, unknown>);

it("restores an earlier version's limit, plans in the background, publishes commands and releases on a settings change", {
  timeout: 35_000,
}, async () => {
  let status: ChargeLimitsData | undefined;
  await vi.waitFor(
    async () => {
      const response = await fetch(`${stack.baseUrl}api/charge-limits`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      status = (await response.json()) as ChargeLimitsData;
      expect(status.batteries[0].state, status.batteries[0].message).toBe(
        "active",
      );
    },
    { timeout: 30_000, interval: 100 },
  );
  expect(status?.batteries[0].plan?.points.length).toBeGreaterThan(3);

  // The direct write from before the upgrade is undone, and nothing new is
  // written to the entity.
  const state = await fetch(
    `${stack.ha.apiUrl}/states/${chargeEntityFixture.entity_id}`,
    { headers: { Authorization: `Bearer ${stack.ha.token}` } },
  ).then((r) => r.json());
  expect(Number(state.state)).toBe(2000);

  const [command] = commands();
  expect(command).toMatchObject({
    schema_version: 1,
    action: "apply",
    strategy: "charge-limit",
    mode: "balance",
    setpoint_w: null,
    charge_limit_w: status?.batteries[0].requestedW,
    discharge_limit_w: status?.batteries[0].requestedDischargeW,
  });
  expect(
    stack.ha.events.find((e) => e.eventType.endsWith("_battery_command"))
      ?.eventType,
  ).toBe("elias_ems_home_battery_battery_command");

  const html = await fetch(stack.baseUrl).then((r) => r.text());
  expect(html).toContain("Recommended charge ceiling");
  expect(html).toContain("Recommended AC output ceiling");
  expect(html).toContain("View full plan");
  expect(html).not.toContain("Forecast and schedule details");
  const plans = await fetch(`${stack.baseUrl}plans`).then((r) => r.text());
  expect(plans).toContain("Energy plans");
  expect(plans).toContain("Schedule table");

  const body = new URLSearchParams({
    intent: "control-save",
    strategy: "charge-limit",
    intervalSeconds: "5",
  });
  const saved = await fetch(`${stack.baseUrl}settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: stack.origin,
    },
    body,
  });
  expect(saved.ok).toBe(true);
  expect(commands().at(-1)).toMatchObject({
    action: "release",
    strategy: "charge-limit",
    release_reason: "disabled",
  });
});
