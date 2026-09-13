import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evening, replay } from "../algorithms/evening.mjs";

const data = JSON.parse(
  await readFile(
    new URL("../datasets/household-2026-09-11/input.json", import.meta.url),
    "utf8",
  ),
);
const settings = JSON.parse(
  await readFile(new URL("../experiment.json", import.meta.url), "utf8"),
);

test("evening search reaches target in both scenarios with intermediate stable limits", async () => {
  const plan = await evening(data, settings);
  const limits = plan.points.map((p) => p.limitW);
  for (const haircut of [0, settings.solarHaircut]) {
    const run = replay(data, limits, settings, haircut);
    assert.ok(run.deadlineSoc >= settings.targetSoc - 1e-6);
    assert.ok(
      run.points.every(
        (p) =>
          p.soc >= data.model.minSoc - 1e-6 &&
          p.soc <= data.model.maxSoc + 1e-6,
      ),
    );
  }
  assert.ok(limits.some((w) => w > 0 && w < 2000));
  assert.ok(limits.every((w) => w >= 0 && w <= 2000 && w % 100 === 0));
  assert.deepEqual((await evening(data, settings)).points, plan.points);
});

test("impossible target preserves maximum reachable SoC and reports infeasibility", async () => {
  const scarce = {
    ...data,
    slots: data.slots.map((s) => ({ ...s, solarW: 0 })),
  };
  const plan = await evening(scarce, settings);
  assert.ok(plan.target.reachableSoc.every((soc) => soc < settings.targetSoc));
  const maximum = replay(
    scarce,
    scarce.slots.map(() => 2000),
    settings,
  );
  assert.equal(
    replay(
      scarce,
      plan.points.map((p) => p.limitW),
      settings,
    ).deadlineSoc,
    maximum.deadlineSoc,
  );
});

test("invalid or out-of-window deadline is rejected", async () => {
  await assert.rejects(
    evening(data, { ...settings, deadline: "2026-09-12T18:00:00+02:00" }),
    /Deadline/,
  );
  await assert.rejects(
    evening(data, { ...settings, solarHaircut: 1 }),
    /Invalid/,
  );
});

test("charging moves to cheaper surplus while supplying intervening demand", async () => {
  const start = Date.parse("2026-09-11T08:00:00Z");
  const sample = {
    ...data,
    model: { ...data.model, capacityKwh: 2, soc: 5 },
    slots: [
      { solarW: 1500, loadW: 0, sell: 0.5 },
      { solarW: 0, loadW: 300, sell: 0.2 },
      { solarW: 2000, loadW: 0, sell: 0.01 },
    ].map((s, i) => ({
      ...s,
      buy: 1,
      estimatedPrice: false,
      start: start + i * 3600000,
      end: start + (i + 1) * 3600000,
    })),
  };
  const config = {
    ...settings,
    deadline: new Date(start + 3 * 3600000).toISOString(),
    solarHaircut: 0,
    switchCost: 0,
  };
  const plan = await evening(sample, config);
  assert.ok(plan.points[0].chargeW > 0 && plan.points[0].chargeW < 1500);
  assert.ok(plan.points[1].dischargeW >= 300 - 1e-6);
  assert.ok(plan.points[2].soc >= 100 - 1e-6);
});
