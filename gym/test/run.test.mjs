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
        ["gym/run.mjs", "addon/app/lib/benchmark-data/input.json", output],
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

test("benchmark runner works with embedded dataset settings", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ems-gym-benchmark-"));
  const datasetFile = path.join(tempDir, "dataset.json");
  const outputDir = path.join(tempDir, "results");
  try {
    const rawInput = JSON.parse(
      await readFile(
        path.join(root, "addon/app/lib/benchmark-data/input.json"),
        "utf8",
      ),
    );
    const experiment = JSON.parse(
      await readFile(
        path.join(root, "addon/app/lib/benchmark-data/experiment.json"),
        "utf8",
      ),
    );
    rawInput.settings = {
      ...experiment,
      algorithms: ["cost-optimized"],
    };
    await writeFile(datasetFile, JSON.stringify(rawInput));

    execFileSync(
      process.execPath,
      ["gym/benchmark.mjs", datasetFile, outputDir],
      { cwd: root },
    );

    const comparison = JSON.parse(
      await readFile(path.join(outputDir, "comparison.json"), "utf8"),
    );
    assert.equal(comparison.length, 1);
    assert.equal(comparison[0].algorithm, "cost-optimized");
    assert.ok(comparison[0].scenarios.length >= 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
