import { describe, expect, it } from "vitest";
import { benchmarkDataset, runBenchmark } from "../../app/lib/benchmark.server";
import { benchmarkAlgorithms } from "../../app/lib/benchmark-algorithms";
import { parseBenchmarkValues } from "../../app/lib/benchmark-input";
import { replay } from "../../app/lib/charge-evening";

describe("fixed dataset benchmark", () => {
  it("rejects invalid edited data before planning and preserves signed tariffs", () => {
    const row = { solarW: 100, loadW: 200, buy: -0.1, sell: -0.2 };
    expect(parseBenchmarkValues(JSON.stringify([row]), 1)).toEqual([row]);
    for (const raw of [
      null,
      "not json",
      "[]",
      JSON.stringify([{ ...row, solarW: -1 }]),
      JSON.stringify([{ ...row, loadW: null }]),
      JSON.stringify([{ ...row, buy: "0.2" }]),
      JSON.stringify([{ ...row, sell: 101 }]),
    ]) {
      expect(() => parseBenchmarkValues(raw, 1)).toThrow();
    }
  });

  it("keeps concurrent edited runs separate and returns the exact submitted inputs", async () => {
    const original = structuredClone(benchmarkDataset().input);
    const values = original.slots.map((slot) => ({
      solarW: slot.solarW,
      loadW: slot.loadW + 1000,
      buy: slot.buy,
      sell: slot.sell,
    }));
    const baseline = runBenchmark();
    const edited = runBenchmark(values);
    expect(edited).not.toBe(baseline);
    expect(runBenchmark(values)).toBe(edited);
    values[0].loadW = 0;
    const [a, b] = await Promise.all([baseline, edited]);
    expect(b.input.slots[0].loadW).toBe(original.slots[0].loadW + 1000);
    expect(b.results[0].scenarios[0].energyCost).not.toBe(
      a.results[0].scenarios[0].energyCost,
    );
    expect(benchmarkDataset().input).toEqual(original);
  }, 30_000);

  it("runs every registered algorithm and independently evaluates both scenarios", async () => {
    const { input, settings } = benchmarkDataset();
    const before = JSON.stringify({ input, settings });
    const pending = runBenchmark();
    expect(runBenchmark()).toBe(pending);
    const report = await pending;
    expect(report.results.map((r) => r.id)).toEqual(
      Object.keys(benchmarkAlgorithms),
    );
    for (const result of report.results) {
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(result.scenarios.map((s) => s.solarHaircut)).toEqual([
        0,
        settings.solarHaircut,
      ]);
      for (const scenario of result.scenarios) {
        const limits = scenario.points.map((p) => p.limitW);
        const evaluated = replay(
          input,
          limits,
          settings,
          scenario.solarHaircut,
        );
        expect(scenario.energyCost).toBe(evaluated.energyCost);
        expect(scenario.deadlineSoc).toBe(evaluated.deadlineSoc);
        expect(scenario.points).toHaveLength(input.slots.length);
        expect(scenario.targetShortfallKwh).toBeGreaterThanOrEqual(0);
        for (const point of scenario.points) {
          expect(point.soc).toBeGreaterThanOrEqual(input.model.minSoc - 1e-6);
          expect(point.soc).toBeLessThanOrEqual(input.model.maxSoc + 1e-6);
        }
      }
    }
    expect(JSON.stringify({ input, settings })).toBe(before);
  }, 30_000);
});
