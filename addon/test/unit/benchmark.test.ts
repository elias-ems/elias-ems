import { describe, expect, it } from "vitest";
import { benchmarkDataset, runBenchmark } from "../../app/lib/benchmark.server";
import { benchmarkAlgorithms } from "../../app/lib/benchmark-algorithms";
import { replay } from "../../app/lib/charge-evening";

describe("fixed dataset benchmark", () => {
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
