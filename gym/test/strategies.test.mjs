import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runStrategies, snapshotOf } from "../strategies.mjs";

const read = async (file) =>
  JSON.parse(await readFile(new URL(`../../${file}`, import.meta.url), "utf8"));

test("every registered strategy runs and is scored by the shared replay", async () => {
  const snapshot = snapshotOf(
    await read("addon/app/lib/benchmark-data/input.json"),
    await read("addon/app/lib/benchmark-data/experiment.json"),
  );
  const first = await runStrategies(snapshot, { timeLimitSeconds: 20 });
  assert.deepEqual(
    first.results.map((r) => r.id),
    ["evening-target", "highs"],
  );
  for (const result of first.results) {
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.commands.length, snapshot.slots.length);
    assert.equal(result.scenarios.length, 2);
    assert.ok(Number.isFinite(result.meanCost));
  }
  // Deterministic: the same snapshot gives the same schedule and score.
  const again = await runStrategies(snapshot, { timeLimitSeconds: 20 });
  for (const [i, result] of again.results.entries()) {
    assert.deepEqual(result.commands, first.results[i].commands);
    assert.equal(result.meanCost, first.results[i].meanCost);
  }
});
