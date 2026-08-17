/**
 * The control loop has to start when the add-on starts, with nobody looking at
 * the panel. That is the difference between an energy management system and a
 * dashboard, and it is the one property none of the other suites can show:
 *
 *   - the unit tests call `syncControlLoop()` themselves;
 *   - the other integration tests and the end-to-end suite switch control on
 *     through the settings form, which calls it too.
 *
 * So this boots the real `server.js` against a data directory that already says
 * `enabled: true` and asks it what the loop is doing, without posting anything
 * first. The only thing that can have started it is the top-level call in
 * `app/entry.server.tsx` — a call that is one `sideEffects` hint or one bundler
 * upgrade away from being quietly dropped from the production build, with no
 * symptom other than an add-on that stops controlling anything until somebody
 * opens the panel. (`sideEffects` has already cost this project once: it shipped
 * the app unstyled by tree-shaking the stylesheet import.)
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosticsData } from "../../app/lib/diagnostics";
import { startStack } from "../stack.js";

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "elias-ems-boot-"));

  const write = (name: string, value: unknown) =>
    writeFile(path.join(dataDir, name), JSON.stringify(value));

  await Promise.all([
    write("grid.json", { powerEntityId: "sensor.grid_power" }),
    write("batteries.json", [
      {
        id: "b1",
        title: "Home battery",
        capacityKwh: 10,
        minChargePercent: 10,
        maxChargePercent: 90,
        energyEntityId: "sensor.battery_energy_total",
        powerEntityId: "sensor.battery_power",
        socEntityId: "sensor.battery_state_of_charge",
        steered: true,
      },
    ]),
    // One second, so the assertions below don't have to wait on a real clock.
    write("control.json", {
      enabled: true,
      strategy: "net-zero-energy",
      intervalSeconds: 1,
    }),
  ]);

  stack = await startStack({ dataDir });
}, 60_000);

afterAll(async () => {
  if (!stack) return;
  await stack.close();
  await rm(stack.dataDir, { recursive: true, force: true });
});

/** Battery control's own entries, as the home page's box asks for them. */
async function messages(): Promise<string[]> {
  const response = await fetch(
    `${stack.baseUrl}api/diagnostics?origin=battery-control`,
  );
  expect(response.status).toBe(200);
  const { entries } = (await response.json()) as DiagnosticsData;
  return entries.map((entry) => entry.message);
}

describe("a restart with battery control already enabled", () => {
  it("has started the loop before anything asks it to", async () => {
    // The line `syncControlLoop()` writes when it starts an interval. Nothing
    // in this process has posted the settings form, so the only thing that can
    // have produced it is the boot-time call in `entry.server.tsx`.
    expect(await messages()).toContainEqual(
      "Battery control enabled — net-zero-energy, on every change and at most every 1s.",
    );
  });

  it("is already deciding, not just scheduled to", async () => {
    await expect
      .poll(messages, { timeout: 5_000 })
      .toContainEqual(expect.stringContaining("Home battery: discharge at"));
  });
});
