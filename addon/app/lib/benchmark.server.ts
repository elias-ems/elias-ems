import { benchmarkAlgorithms } from "./benchmark-algorithms";
import settings from "./benchmark-data/experiment.json";
import input from "./benchmark-data/input.json";
import { applySlotValues, type BenchmarkValues } from "./benchmark-input";
import { replay, validateSettings } from "./charge-evening";
import { deviceLimit } from "./charge-plan";

export type BenchmarkInput = ReturnType<typeof benchmarkDataset>["input"];
export type BenchmarkSettings = ReturnType<typeof benchmarkDataset>["settings"];

export function benchmarkDataset() {
  return {
    input,
    settings,
    algorithms: Object.values(benchmarkAlgorithms).map((a) => a.label),
  };
}

async function run(
  datasetInput: BenchmarkInput,
  datasetSettings: BenchmarkSettings,
) {
  validateSettings(datasetInput, datasetSettings);
  const results = [];
  for (const [id, algorithm] of Object.entries(benchmarkAlgorithms)) {
    // Keep every candidate isolated from mutation by other candidates.
    const started = performance.now();
    const plan = await algorithm.run(
      structuredClone(datasetInput),
      structuredClone(datasetSettings),
    );
    const elapsedMs = performance.now() - started;
    const limits = plan.points.map((p) => p.limitW);
    if (
      limits.length !== datasetInput.slots.length ||
      limits.some(
        (limit) =>
          !Number.isFinite(limit) ||
          Math.abs(deviceLimit(limit, datasetInput.model) - limit) > 1e-6,
      )
    )
      throw new Error(`${algorithm.label} returned an invalid schedule`);
    results.push({
      id,
      label: algorithm.label,
      elapsedMs,
      scenarios: [0, datasetSettings.solarHaircut].map((solarHaircut) => {
        const metrics = replay(
          datasetInput,
          limits,
          datasetSettings,
          solarHaircut,
          plan.points.some((p) => p.dischargeLimitW !== undefined)
            ? plan.points.map(
                (p) => p.dischargeLimitW ?? datasetInput.model.dischargeW,
              )
            : undefined,
        );
        return {
          ...metrics,
          solarHaircut,
          targetShortfallKwh: Math.max(
            0,
            (datasetInput.model.capacityKwh * datasetSettings.targetSoc) / 100 -
              metrics.deadlineEnergy,
          ),
        };
      }),
    });
  }
  return {
    results,
    input: datasetInput,
    settings: datasetSettings,
    completedAt: new Date().toISOString(),
  };
}

// Coalesce concurrent requests so several open tabs don't run duplicate searches.
const pending = new Map<string, ReturnType<typeof run>>();
export function runBenchmark(
  values?: BenchmarkValues[],
  customInput?: BenchmarkInput,
  customSettings?: BenchmarkSettings,
) {
  const snapshot = structuredClone(customInput ?? input);
  const activeSettings = structuredClone(customSettings ?? settings);
  if (values) {
    if (values.length !== snapshot.slots.length) {
      throw new Error(
        `Values length (${values.length}) does not match slots length (${snapshot.slots.length})`,
      );
    }
    snapshot.slots = snapshot.slots.map((slot, index) =>
      applySlotValues(slot, values[index]),
    );
  }
  const key = JSON.stringify([snapshot, activeSettings]);
  let task = pending.get(key);
  if (!task) {
    task = run(snapshot, activeSettings).finally(() => {
      pending.delete(key);
    });
    pending.set(key, task);
  }
  return task;
}
