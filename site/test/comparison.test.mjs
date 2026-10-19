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
    expanded: false,
    setpointStepW: 100,
    timeLimitSeconds: 20,
  });
  assert.deepEqual(
    comparison.runs.map((run) => run.id),
    ["evening-target", "highs"],
  );
  for (const run of comparison.runs) {
    assert.equal(run.error, undefined, `${run.id}: ${run.error}`);
    assert.equal(run.result.commands.length, fixture.slots.length);
    assert.equal(run.scenarios.length, 2);
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
    expanded: false,
    setpointStepW: 100,
    // Outside the engine's accepted budget, so only HiGHS can fail.
    timeLimitSeconds: 0,
  });
  const [eveningTarget, highs] = comparison.runs;
  assert.ok(eveningTarget.scenarios);
  assert.match(highs.error, /./);
});
