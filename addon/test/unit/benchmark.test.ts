import { describe, expect, it } from "vitest";
import { benchmarkDataset, runBenchmark } from "../../app/lib/benchmark.server";
import { benchmarkAlgorithms } from "../../app/lib/benchmark-algorithms";
import {
  applySlotValues,
  parseBenchmarkValues,
  parseCustomDataset,
} from "../../app/lib/benchmark-input";
import { replay } from "../../app/lib/charge-evening";
import { simulateCharge } from "../../app/lib/charge-plan";

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

  it("parses valid custom datasets and rejects malformed datasets", () => {
    const valid = {
      slots: [
        {
          start: 0,
          end: 900_000,
          solarW: 100,
          loadW: 200,
          buy: 0.2,
          sell: 0.1,
        },
      ],
      model: {
        capacityKwh: 10,
        minSoc: 10,
        maxSoc: 90,
        minW: 0,
        maxW: 2000,
        stepW: 100,
        dischargeW: 2000,
        efficiency: 0.95,
        wearPerKwh: 0,
        soc: 50,
      },
      terminalReserveKwh: 5,
    };
    const parsed = parseCustomDataset(JSON.stringify(valid));
    expect(parsed).not.toBeNull();
    expect((parsed?.input.slots as unknown as unknown[])?.length).toBe(1);
    expect(parsed?.settings.targetSoc).toBe(90);

    expect(parseCustomDataset(null)).toBeNull();
    expect(() => parseCustomDataset("not json")).toThrow("not valid JSON");
    expect(() => parseCustomDataset(JSON.stringify({ slots: [] }))).toThrow(
      "slots array",
    );
    expect(() =>
      parseCustomDataset(JSON.stringify({ slots: valid.slots })),
    ).toThrow("battery model");
    expect(() =>
      parseCustomDataset(
        JSON.stringify({ ...valid, model: { capacityKwh: "invalid" } }),
      ),
    ).toThrow("missing or invalid");
  });

  it("runs benchmarks against custom datasets with arbitrary slot counts", async () => {
    const custom = structuredClone(benchmarkDataset().input);
    custom.slots = custom.slots.slice(0, 10);
    const customSettings = {
      ...benchmarkDataset().settings,
      deadline: new Date(
        custom.slots[custom.slots.length - 1].end,
      ).toISOString(),
    };
    const report = await runBenchmark(undefined, custom, customSettings);
    expect(report.input.slots).toHaveLength(10);
    expect(report.results).toHaveLength(
      Object.keys(benchmarkAlgorithms).length,
    );
    for (const result of report.results) {
      expect(result.scenarios[0].points).toHaveLength(10);
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

  it("executes the benchmark action with custom dataset submitted in formData", async () => {
    const { action } = await import("../../app/routes/benchmark");
    const custom = structuredClone(benchmarkDataset().input);
    custom.slots = custom.slots.slice(0, 4);
    const customSettings = {
      ...benchmarkDataset().settings,
      deadline: new Date(
        custom.slots[custom.slots.length - 1].end,
      ).toISOString(),
    };
    const values = custom.slots.map((s) => ({
      solarW: s.solarW,
      loadW: s.loadW,
      buy: s.buy,
      sell: s.sell,
    }));
    const formData = new FormData();
    formData.append("dataset", JSON.stringify(values));
    formData.append(
      "customDataset",
      JSON.stringify({ ...custom, settings: customSettings }),
    );
    const request = new Request("http://localhost/benchmark", {
      method: "POST",
      body: formData,
    });
    const result = (await action({
      request,
      params: {},
      context: {},
    } as unknown as Parameters<typeof action>[0])) as {
      error: string | null;
      report: unknown;
    };
    expect(result.error).toBeNull();
    expect(result.report).toBeDefined();
    const report = result.report as Awaited<ReturnType<typeof runBenchmark>>;
    expect(report.input.slots).toHaveLength(4);
    expect(report.results).toHaveLength(
      Object.keys(benchmarkAlgorithms).length,
    );
  }, 30_000);

  it("scales curtailment inputs consistently with edited solar", () => {
    const slot = {
      start: 0,
      end: 3_600_000,
      solarW: 3000,
      loadW: 500,
      buy: 0.2,
      sell: 0.1,
      estimatedPrice: false,
      curtailment: {
        fixedW: 1000,
        availableW: 2000,
        floorW: 200,
        ceilingW: 1000,
        gridTargetW: 0,
        exportAllowanceW: 0,
        fixedArrays: [{ availableW: 1000, ceilingW: 2000 }],
        modulatingArrays: [{ availableW: 2000, floorW: 200, ceilingW: 1000 }],
      },
    };

    // Case 1: Edit solar to 0 W with loadW=500
    const zeroSolar = applySlotValues(slot, {
      solarW: 0,
      loadW: 500,
      buy: 0.2,
      sell: 0.1,
    });
    expect(zeroSolar.curtailment?.fixedW).toBe(0);
    expect(zeroSolar.curtailment?.availableW).toBe(0);
    expect(zeroSolar.curtailment?.floorW).toBe(0);
    expect(zeroSolar.curtailment?.fixedArrays?.[0].availableW).toBe(0);
    expect(zeroSolar.curtailment?.modulatingArrays?.[0].availableW).toBe(0);
    expect(zeroSolar.curtailment?.modulatingArrays?.[0].floorW).toBe(0);

    const model = {
      capacityKwh: 10,
      minSoc: 10,
      maxSoc: 90,
      minW: 0,
      maxW: 3000,
      stepW: 100,
      dischargeW: 3000,
      efficiency: 1,
      wearPerKwh: 0,
      soc: 50,
    };
    const step = simulateCharge(zeroSolar, 5, 3000, model);
    expect(step.solarW).toBe(0);
    expect(step.chargeW).toBe(0);
    expect(step.dischargeW).toBe(500);

    // Case 2: Edit solar to 1500 W (50% reduction)
    const halfSolar = applySlotValues(slot, {
      solarW: 1500,
      loadW: 500,
      buy: 0.2,
      sell: 0.1,
    });
    expect(halfSolar.curtailment?.fixedW).toBe(500);
    expect(halfSolar.curtailment?.availableW).toBe(1000);
    expect(halfSolar.curtailment?.floorW).toBe(200);
    expect(halfSolar.curtailment?.fixedArrays?.[0].availableW).toBe(500);
    expect(halfSolar.curtailment?.modulatingArrays?.[0].availableW).toBe(1000);
    expect(halfSolar.curtailment?.modulatingArrays?.[0].floorW).toBe(200);
  });

  it("returns settings on the report object", async () => {
    const report = await runBenchmark();
    expect(report.settings).toBeDefined();
    expect(report.settings.targetSoc).toBe(
      benchmarkDataset().settings.targetSoc,
    );
    expect(report.settings.solarHaircut).toBe(
      benchmarkDataset().settings.solarHaircut,
    );
  });
});
