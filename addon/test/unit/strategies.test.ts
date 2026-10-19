/**
 * The strategy registry and its contract. The planners' own arithmetic is
 * covered elsewhere (charge-plan.test.ts, engine/test); what matters here is
 * that every registered strategy turns a snapshot into commands the shared
 * physics accepts, and that the registry is the one list everything reads.
 */
import { describe, expect, it, vi } from "vitest";
import experiment from "../../app/lib/benchmark-data/experiment.json";
import input from "../../app/lib/benchmark-data/input.json";
import { evening } from "../../app/lib/charge-evening";
import {
  DEFAULT_CONTROL_CONFIG,
  normalizeControlConfig,
  STRATEGIES,
} from "../../app/lib/control";
import { solveHighs } from "../../app/lib/highs-runner.server";
import {
  type Capabilities,
  type PlanningSnapshot,
  STRATEGY_REGISTRY,
  type StrategyContext,
  scoreCommands,
  strategyById,
} from "../../app/lib/strategies/index.ts";

const { algorithm: _a, algorithms: _as, ...settings } = experiment;
const snapshot = {
  model: input.model,
  slots: input.slots,
  terminalReserveKwh: input.terminalReserveKwh,
  settings,
} as PlanningSnapshot;

const BALANCE: Capabilities = {
  modes: ["balance"],
  gridCharging: false,
  batteryExport: false,
};

const context = (
  solveHighs: StrategyContext["solveHighs"],
): StrategyContext => ({
  capabilities: BALANCE,
  timeLimitSeconds: 20,
  solveHighs,
});

describe("the registry", () => {
  it("holds exactly Evening target and HiGHS, with unique ids", () => {
    expect(STRATEGY_REGISTRY.map((s) => s.id)).toEqual([
      "evening-target",
      "highs",
    ]);
  });

  it("is what Settings offers", () => {
    expect(STRATEGIES.map((s) => s.id)).toEqual(
      STRATEGY_REGISTRY.map((s) => s.id),
    );
    expect(STRATEGIES.every((s) => s.label && s.description)).toBe(true);
  });

  it("rejects an id nobody registered", () => {
    expect(() => strategyById("net-zero-energy" as never)).toThrow(
      "Unknown strategy",
    );
  });
});

describe("stored strategy ids", () => {
  it("carries Evening target's old id across", () => {
    expect(
      normalizeControlConfig({
        enabled: true,
        strategy: "charge-limit" as never,
        intervalSeconds: 5,
      }),
    ).toEqual({
      enabled: true,
      strategy: "evening-target",
      intervalSeconds: 5,
    });
  });

  it("switches control off for the removed net zero energy", () => {
    // Its automations expect setpoints; a planner publishing balance commands
    // in its place would be a different instruction nobody asked for.
    expect(
      normalizeControlConfig({
        enabled: true,
        strategy: "net-zero-energy" as never,
        intervalSeconds: 5,
      }),
    ).toEqual({
      enabled: false,
      strategy: "evening-target",
      intervalSeconds: 5,
    });
  });

  it("keeps HiGHS", () => {
    expect(
      normalizeControlConfig({ ...DEFAULT_CONTROL_CONFIG, strategy: "highs" })
        .strategy,
    ).toBe("highs");
  });
});

describe("Evening target", () => {
  it("is the evening planner, as balance commands", async () => {
    const result = await strategyById("evening-target").plan(
      snapshot,
      context(() => Promise.reject(new Error("not used"))),
    );
    const plan = await evening(snapshot, snapshot.settings);

    expect(result.plan).toEqual(plan);
    expect(result.commands).toHaveLength(snapshot.slots.length);
    expect(result.commands.every((c) => c.mode === "balance")).toBe(true);
    expect(result.commands.map((c) => c.chargeLimitW)).toEqual(
      plan.points.map((p) => p.limitW),
    );
  });
});

describe("HiGHS", () => {
  it("reports a solve with no schedule as a failure, not an empty plan", async () => {
    await expect(
      strategyById("highs").plan(
        snapshot,
        context(async () => ({
          status: "Infeasible",
          optimal: false,
          statuses: ["Infeasible"],
          runtimeMs: 1,
          commands: undefined,
        })),
      ),
    ).rejects.toThrow("HiGHS returned no schedule: Infeasible.");
  });

  it("passes the snapshot and the context's capabilities to the solver", async () => {
    const solve = vi.fn().mockRejectedValue(new Error("stop"));
    await expect(
      strategyById("highs").plan(snapshot, context(solve)),
    ).rejects.toThrow("stop");
    expect(solve).toHaveBeenCalledWith({
      model: snapshot.model,
      slots: snapshot.slots,
      solarHaircut: 0.2,
      capabilities: BALANCE,
      timeLimitSeconds: 20,
    });
  });

  it("solves on a worker thread, and never costs more than Evening target", {
    timeout: 60_000,
  }, async () => {
    const real = context((engineInput) => solveHighs(engineInput));
    const [highs, eveningTarget] = await Promise.all([
      strategyById("highs").plan(snapshot, real),
      strategyById("evening-target").plan(snapshot, real),
    ]);

    expect(highs.commands).toHaveLength(snapshot.slots.length);
    expect(highs.commands.every((c) => c.mode === "balance")).toBe(true);
    expect(highs.plan.points).toHaveLength(snapshot.slots.length);

    // Both judged by the same replay. HiGHS minimises exactly this over every
    // balance schedule, of which Evening target's is one, so a proven optimum
    // cannot be beaten by it.
    const score = (commands: typeof highs.commands) =>
      scoreCommands(snapshot, commands, BALANCE);
    expect(score(highs.commands).scenarios).toHaveLength(2);
    if (highs.status === "Optimal for modeled objective")
      expect(score(highs.commands).meanCost).toBeLessThanOrEqual(
        score(eveningTarget.commands).meanCost + 1e-6,
      );
  });
});
