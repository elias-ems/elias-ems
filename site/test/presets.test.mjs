import assert from "node:assert/strict";
import test from "node:test";
import { compare } from "../lib/comparison.ts";
import { parseDataset, runPlanner } from "../lib/planner.ts";
import { presets } from "../lib/presets.ts";

test("every preset is a distinct, valid forecast snapshot", () => {
  assert.equal(presets.length, 4);
  assert.equal(new Set(presets.map((p) => p.key)).size, presets.length);
  for (const preset of presets) {
    const d = parseDataset(structuredClone(preset.dataset));
    assert.equal(d.timeZone, "Europe/Brussels");
    assert.equal(d.currency, "EUR");
    assert.ok(d.slots.length >= 96 && d.slots.length <= 192, preset.key);
    assert.ok(d.slots.every((s) => s.end - s.start === 900_000));
    assert.ok(d.model.capacityKwh >= 3.6 && d.model.capacityKwh <= 10);
    assert.match(d.assumptions[0], /^Synthetic preset/);
  }
});

test("presets are reproducible: fixed timestamps, no clock reads", async () => {
  const again = await import(`../lib/presets.ts?again=${Math.random()}`);
  assert.deepEqual(again.presets, presets);
});

test("each preset exercises the behaviour it is named for", () => {
  const byKey = Object.fromEntries(presets.map((p) => [p.key, p.dataset]));
  const surplus = byKey["marginal-surplus"].slots
    .map((s) => s.solarW - s.loadW)
    .filter((w) => w > 0);
  assert.ok(surplus.length >= 3 && surplus.every((w) => w <= 15));
  const summer = byKey["summer-curtailment"].slots;
  assert.ok(summer.some((s) => s.curtailment && s.sell < 0));
  assert.ok(summer.every((s) => !s.curtailment || s.sell < 0));
  assert.ok(byKey["negative-night"].slots.some((s) => s.buy < 0));
  assert.ok(byKey["winter-spread"].slots.every((s) => s.solarW <= 260));
});

test("Evening target plans every preset", async () => {
  for (const preset of presets) {
    // One search pass keeps the suite quick; the inputs are what is under test.
    const dataset = structuredClone(preset.dataset);
    dataset.settings.passes = 1;
    const plan = await runPlanner(dataset);
    assert.equal(plan.points.length, preset.dataset.slots.length);
    assert.ok(
      plan.points.every((p) => Number.isFinite(p.soc)),
      preset.key,
    );
  }
});

test("HiGHS widens balance boundaries past a few watts of surplus", async () => {
  const preset = presets.find((p) => p.key === "marginal-surplus");
  const { engine, engineError } = await compare(preset.dataset, {
    expanded: false,
    setpointStepW: 100,
    timeLimitSeconds: 30,
  });
  assert.equal(engineError, "");
  assert.equal(engine.optimal, true);
  const points = engine.scenarios[0].points.filter(
    (_, i) => preset.dataset.slots[i].solarW > preset.dataset.slots[i].loadW,
  );
  assert.ok(points.length > 0);
  for (const p of points)
    assert.equal(p.chargeLimitW, preset.dataset.model.maxW);
});
