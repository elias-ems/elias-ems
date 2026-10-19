/**
 * Runs registered battery control strategies on a planning snapshot and scores
 * each with the shared physical replay — the entry point for experiments and
 * for a training loop that wants a strategy's cost on many snapshots.
 *
 *   node gym/strategies.mjs <snapshot.json> [strategy-id ...] [--expanded]
 *
 * Prints one JSON document: per strategy its status, runtime, mean cost and
 * the nominal and reduced-solar scenario totals. The same registry the add-on
 * and the Planner sandbox read, so a strategy added there is runnable here.
 */
import { readFile } from "node:fs/promises";
import {
  engineInput,
  STRATEGY_REGISTRY,
  scoreCommands,
} from "../addon/app/lib/strategies/index.ts";
import { plan } from "../engine/node.mjs";

const BALANCE = {
  modes: ["balance"],
  gridCharging: false,
  batteryExport: false,
};
const EXPANDED = {
  modes: ["balance", "hold", "charge", "discharge"],
  gridCharging: true,
  batteryExport: true,
  setpointStepW: 100,
};

/** A snapshot from a planner export, or a gym dataset plus its settings. */
export function snapshotOf(data, settings = data.settings) {
  if (!settings)
    throw new Error("The snapshot carries no settings; pass a settings file.");
  const { algorithm: _a, algorithms: _as, ...rest } = settings;
  return {
    model: data.model,
    slots: data.slots,
    terminalReserveKwh: data.terminalReserveKwh,
    settings: rest,
  };
}

/** Run and score strategies; deterministic for a given snapshot and budget. */
export async function runStrategies(
  snapshot,
  { ids, capabilities = BALANCE, timeLimitSeconds = 30 } = {},
) {
  const selected = ids?.length
    ? ids.map((id) => {
        const strategy = STRATEGY_REGISTRY.find((s) => s.id === id);
        if (!strategy) throw new Error(`Unknown strategy: ${id}`);
        return strategy;
      })
    : STRATEGY_REGISTRY;
  const results = [];
  for (const strategy of selected) {
    const started = performance.now();
    try {
      const result = await strategy.plan(snapshot, {
        capabilities,
        timeLimitSeconds,
        solveHighs: (input) => plan(input),
      });
      const score = scoreCommands(snapshot, result.commands, capabilities);
      results.push({
        id: strategy.id,
        status: result.status,
        runtimeMs: performance.now() - started,
        meanCost: score.meanCost,
        scenarios: score.scenarios.map(({ points: _p, ...total }) => total),
        commands: result.commands,
      });
    } catch (error) {
      results.push({
        id: strategy.id,
        runtimeMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    input: engineInput(snapshot, capabilities, timeLimitSeconds),
    results,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const expanded = args.includes("--expanded");
  const [file, ...ids] = args.filter((a) => a !== "--expanded");
  if (!file)
    throw new Error(
      "Usage: node gym/strategies.mjs <snapshot.json> [strategy-id ...] [--expanded]",
    );
  const data = JSON.parse(await readFile(file, "utf8"));
  const settings =
    data.settings ??
    JSON.parse(
      await readFile("addon/app/lib/benchmark-data/experiment.json", "utf8"),
    );
  const { input: _input, results } = await runStrategies(
    snapshotOf(data, settings),
    { ids, capabilities: expanded ? EXPANDED : BALANCE },
  );
  console.log(
    JSON.stringify(
      results.map(({ commands: _c, ...summary }) => summary),
      null,
      2,
    ),
  );
}
