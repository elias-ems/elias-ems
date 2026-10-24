import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compare } from "../lib/comparison.ts";

// The planner fixture, wrapped as the version 1 snapshot the sandbox imports.
const fixture = {
  schemaVersion: 1,
  kind: "forecast-snapshot",
  id: "morning-headroom",
  timeZone: "Europe/Brussels",
  currency: "EUR",
  assumptions: [],
  ...JSON.parse(
    await readFile(
      new URL("./fixtures/morning-headroom.json", import.meta.url),
    ),
  ),
};

test("compares every registered strategy on one snapshot", async () => {
  const comparison = await compare(fixture, {
    capabilities: "balance",
    setpointStepW: 100,
    timeLimitSeconds: 20,
  });
  assert.deepEqual(
    comparison.runs.map((run) => run.id),
    ["evening-target", "highs", "dynamic-programming"],
  );
  // One baseline for the chart, independent of which strategy succeeded.
  assert.equal(comparison.baseline.points.length, fixture.slots.length);
  assert.ok(comparison.baseline.points.every((p) => p.mode === "balance"));
  for (const run of comparison.runs) {
    assert.equal(run.error, undefined, `${run.id}: ${run.error}`);
    assert.equal(run.result.commands.length, fixture.slots.length);
    assert.equal(run.scenarios.length, 2);
    // More solar never means less generated before curtailment is counted.
    assert.ok(
      run.excess.generatedKwh + run.excess.curtailedKwh >=
        run.scenarios[0].generatedKwh + run.scenarios[0].curtailedKwh,
    );
    assert.ok(Number.isFinite(run.meanCost));
    assert.ok(run.result.commands.every((c) => c.mode === "balance"));
  }
  // The same replay judges both; HiGHS minimises it over balance schedules.
  const [eveningTarget, highs] = comparison.runs;
  if (highs.result.status === "Optimal for modeled objective")
    assert.ok(highs.meanCost <= eveningTarget.meanCost + 1e-6);
});

test("reports a strategy that fails without hiding the others", async () => {
  const comparison = await compare(fixture, {
    capabilities: "balance",
    setpointStepW: 100,
    // Outside the engine's accepted budget, so only HiGHS can fail.
    timeLimitSeconds: 0,
  });
  const [eveningTarget, highs] = comparison.runs;
  assert.ok(eveningTarget.scenarios);
  assert.match(highs.error, /./);
});

test("plans with the exported battery's own modes", async () => {
  const comparison = await compare(
    {
      ...fixture,
      devices: {
        battery: { controlModes: ["balance", "charge"], powerStepW: 50 },
      },
    },
    { capabilities: "battery", setpointStepW: 100, timeLimitSeconds: 5 },
  );
  // Charge implies grid charging; discharge, and so export, is not allowed.
  assert.deepEqual(comparison.input.capabilities, {
    modes: ["balance", "charge"],
    gridCharging: true,
    batteryExport: false,
    setpointStepW: 50,
  });
  for (const run of comparison.runs)
    assert.ok(
      run.result.commands.every((c) => ["balance", "charge"].includes(c.mode)),
      run.id,
    );
});

test("refuses battery capabilities an export does not record", async () => {
  await assert.rejects(
    compare(fixture, {
      capabilities: "battery",
      setpointStepW: 100,
      timeLimitSeconds: 20,
    }),
    /does not record the battery's control modes/,
  );
});
