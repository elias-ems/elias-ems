import { benchmarkAlgorithms } from "./benchmark-algorithms";
import settings from "./benchmark-data/experiment.json";
import input from "./benchmark-data/input.json";
import { replay, validateSettings } from "./charge-evening";
import { deviceLimit } from "./charge-plan";

export function benchmarkDataset() {
  return {
    input,
    settings,
    algorithms: Object.values(benchmarkAlgorithms).map((a) => a.label),
  };
}

async function run() {
  validateSettings(input, settings);
  const results = [];
  for (const [id, algorithm] of Object.entries(benchmarkAlgorithms)) {
    // Keep every candidate isolated from mutation by other candidates.
    const started = performance.now();
    const plan = await algorithm.run(
      structuredClone(input),
      structuredClone(settings),
    );
    const elapsedMs = performance.now() - started;
    const limits = plan.points.map((p) => p.limitW);
    if (
      limits.length !== input.slots.length ||
      limits.some(
        (limit) =>
          !Number.isFinite(limit) ||
          Math.abs(deviceLimit(limit, input.model) - limit) > 1e-6,
      )
    )
      throw new Error(`${algorithm.label} returned an invalid schedule`);
    results.push({
      id,
      label: algorithm.label,
      elapsedMs,
      scenarios: [0, settings.solarHaircut].map((solarHaircut) => {
        const metrics = replay(input, limits, settings, solarHaircut);
        return {
          ...metrics,
          solarHaircut,
          targetShortfallKwh: Math.max(
            0,
            (input.model.capacityKwh * settings.targetSoc) / 100 -
              metrics.deadlineEnergy,
          ),
        };
      }),
    });
  }
  return { results, completedAt: new Date().toISOString() };
}

// Coalesce concurrent requests so several open tabs don't run duplicate searches.
let pending: ReturnType<typeof run> | undefined;
export function runBenchmark() {
  pending ??= run().finally(() => {
    pending = undefined;
  });
  return pending;
}
