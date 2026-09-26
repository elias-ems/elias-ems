import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evening, replay } from "../../addon/app/lib/charge-evening.ts";
import { parseDataset, runPlanner } from "../lib/planner.ts";

test("opens a whole morning restriction without sacrificing either evening target", async () => {
  // Numeric forecast only: no exported device identities or household metadata.
  const input = JSON.parse(
    readFileSync(
      new URL("./fixtures/morning-headroom.json", import.meta.url),
      "utf8",
    ),
  );
  const plan = await evening(input, input.settings);
  assert.ok(plan.points.slice(0, 8).every((p) => p.dischargeLimitW === 2000));
  assert.ok(plan.points.slice(0, 8).every((p) => p.dischargeW === 0));
  // The old local search scored 0.6056077758 on this snapshot.
  assert.ok(plan.searchObjective < 0.6056);
  for (const haircut of [0, 0.2]) {
    const run = replay(
      input,
      plan.points.map((p) => p.limitW),
      input.settings,
      haircut,
      plan.points.map((p) => p.dischargeLimitW),
    );
    assert.ok(Math.abs(run.deadlineSoc - 100) < 1e-7);
    assert.ok(run.points.every((p) => p.soc >= 5 - 1e-7));
  }
});

function fixture() {
  const start = Date.parse("2026-09-25T12:00:00Z");
  return {
    schemaVersion: 1,
    kind: "forecast-snapshot",
    id: "test",
    timeZone: "Europe/Brussels",
    currency: "EUR",
    assumptions: [],
    model: {
      capacityKwh: 5,
      minSoc: 5,
      maxSoc: 100,
      soc: 30,
      minW: 0,
      maxW: 1000,
      stepW: 500,
      dischargeW: 1000,
      efficiency: 0.95,
      wearPerKwh: 0,
    },
    terminalReserveKwh: 1,
    slots: Array.from({ length: 4 }, (_, i) => ({
      start: start + i * 900000,
      end: start + (i + 1) * 900000,
      solarW: i < 2 ? 1800 : 100,
      loadW: 400,
      buy: 0.3,
      sell: 0.05,
      estimatedPrice: false,
    })),
    settings: {
      deadline: new Date(start + 3600000).toISOString(),
      targetSoc: 60,
      solarHaircut: 0.2,
      switchCost: 0.002,
      passes: 1,
      spikeBufferKwh: 0.54,
    },
  };
}
test("imported snapshot runs the identical production algorithm without changing inputs", async () => {
  const input = fixture();
  const original = structuredClone(input);
  assert.deepEqual(
    await runPlanner(input),
    await evening(input, input.settings),
  );
  assert.deepEqual(input, original);
});
test("rejects unsupported files, malformed models, gaps and excessive work", () => {
  for (const mutate of [
    (d) => {
      d.schemaVersion = 2;
    },
    (d) => {
      delete d.model.capacityKwh;
    },
    (d) => {
      d.model.stepW = 1e-20;
    },
    (d) => {
      d.slots[1].start++;
    },
    (d) => {
      d.slots[0].solarW = -1;
    },
    (d) => {
      d.settings.deadline = "invalid";
    },
    (d) => {
      d.slots[0].curtailment = {};
    },
    (d) => {
      d.settings.passes = 21;
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => parseDataset(input));
  }
});
test("preserves curtailment, negative tariffs and controllable discharge", async () => {
  const input = fixture();
  input.model.dischargeMinW = 0;
  input.model.dischargeStepW = 500;
  input.slots[0].sell = -0.1;
  input.slots[0].curtailment = {
    fixedW: 0,
    availableW: 1800,
    floorW: 0,
    gridTargetW: 0,
    exportAllowanceW: 0,
  };
  const plan = await runPlanner(input);
  assert.equal(plan.points.length, 4);
  assert.ok(
    plan.points.every(
      (p) => Number.isFinite(p.soc) && p.dischargeLimitW !== undefined,
    ),
  );
});
