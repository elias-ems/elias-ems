import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("offline runner is reproducible and preserves curation", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = await mkdtemp(path.join(os.tmpdir(), "ems-gym-test-"));
  try {
    const run = () =>
      execFileSync(
        process.execPath,
        ["gym/run.mjs", "gym/datasets/household-2026-09-11/input.json", output],
        { cwd: root },
      );
    run();
    const first = JSON.parse(
      await readFile(path.join(output, "report.json"), "utf8"),
    );
    assert.equal(first.kind, "measured-hindsight");
    assert.equal(first.plan.points.length, 52);
    assert.ok(first.objectiveImprovement >= -1e-6);
    assert.ok(
      first.plan.points.every(
        (p) =>
          p.soc >= 5 - 1e-6 &&
          p.soc <= 100 + 1e-6 &&
          p.chargeW <= p.limitW + 1e-6,
      ),
    );
    await writeFile(path.join(output, "curation.md"), "Keep my review");
    run();
    const second = JSON.parse(
      await readFile(path.join(output, "report.json"), "utf8"),
    );
    assert.deepEqual(first.plan, second.plan);
    assert.equal(first.datasetSha256, second.datasetSha256);
    assert.equal(
      await readFile(path.join(output, "curation.md"), "utf8"),
      "Keep my review",
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
