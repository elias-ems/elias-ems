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
    JSON.stringify([{ ...chargeBatteryFixture, chargeLimitMode: "active" }]),
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
  stack = await startStack({
    dataDir: directory,
    haStates: [
      ...(await defaultStates()),
      { ...chargeEntityFixture, state: "200" },
    ],
    haCommandResults: chargeForecastFixture(),
  });
});
afterAll(async () => {
  await stack?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("plans in the background, serves Home through ingress and restores on a settings change", async () => {
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
    { timeout: 15_000, interval: 100 },
  );
  expect(status?.batteries[0].plan?.points.length).toBeGreaterThan(3);
  const state = await fetch(
    `${stack.ha.apiUrl}/states/${chargeEntityFixture.entity_id}`,
    { headers: { Authorization: `Bearer ${stack.ha.token}` } },
  ).then((r) => r.json());
  expect(Number(state.state)).toBe(status?.batteries[0].requestedW);
  const html = await fetch(stack.baseUrl).then((r) => r.text());
  expect(html).toContain("Recommended charge ceiling");
  expect(html).toContain("Forecast and schedule details");

  const body = new URLSearchParams(
    Object.entries({
      ...chargeBatteryFixture,
      chargeLimitMode: "off",
      intent: "battery-update",
    })
      .filter(([key]) => key !== "steered")
      .map(([k, v]) => [k, String(v)]),
  );
  const saved = await fetch(`${stack.baseUrl}settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: stack.origin,
    },
    body,
  });
  expect(saved.ok).toBe(true);
  const restored = await fetch(
    `${stack.ha.apiUrl}/states/${chargeEntityFixture.entity_id}`,
    { headers: { Authorization: `Bearer ${stack.ha.token}` } },
  ).then((r) => r.json());
  expect(Number(restored.state)).toBe(200);
});
