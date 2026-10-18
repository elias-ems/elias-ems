import { evaluate } from "./physics.ts";
import type { Command, Input } from "./types.ts";

type Scenario = ReturnType<typeof evaluate>;

/** Exact per-interval agreement: same flows, PV, energy and cost everywhere. */
function same(a: Scenario, b: Scenario) {
  return a.points.every((p, i) => {
    const q = b.points[i];
    return (
      Math.abs(p.chargeW - q.chargeW) < 1e-6 &&
      Math.abs(p.dischargeW - q.dischargeW) < 1e-6 &&
      Math.abs(p.generatedSolarW - q.generatedSolarW) < 1e-6 &&
      Math.abs(p.soc - q.soc) < 1e-9 &&
      Math.abs(p.cost - q.cost) < 1e-12
    );
  });
}

/** Rewrite direct-mode intervals as balance wherever balance, with boundaries
 * at the direct setpoint, reproduces both scenarios exactly. This is the
 * balance preference without a second solve, so it also applies to a plan
 * whose cost is not proven optimal; it never changes energy, flows or cost. */
export function preferBalance(input: Input, commands: Command[]) {
  const m = input.model;
  const haircuts = [0, input.solarHaircut];
  let current = commands;
  let scenarios = haircuts.map((h) => evaluate(input, current, h));
  let relabelled = 0;
  if (!input.capabilities.modes.includes("balance"))
    return { commands: current, scenarios, relabelled };
  for (const [i, u] of commands.entries()) {
    if (u.mode === "balance") continue;
    const chargeLimits = [
      ...(u.mode === "charge" ? [u.setpointW] : []),
      m.minW,
    ];
    const dischargeLimits =
      m.dischargeStepW === undefined
        ? [m.dischargeW]
        : [
            ...(u.mode === "discharge" ? [-u.setpointW] : []),
            m.dischargeMinW ?? 0,
          ];
    search: for (const chargeLimitW of chargeLimits)
      for (const dischargeLimitW of dischargeLimits) {
        const candidate = current.map(
          (v, j): Command =>
            j === i
              ? {
                  start: u.start,
                  end: u.end,
                  mode: "balance",
                  chargeLimitW,
                  dischargeLimitW,
                }
              : v,
        );
        let replayed: Scenario[];
        try {
          replayed = haircuts.map((h) => evaluate(input, candidate, h));
        } catch {
          continue; // Boundary not writable on this device.
        }
        if (replayed.every((s, j) => same(s, scenarios[j]))) {
          current = candidate;
          scenarios = replayed;
          relabelled++;
          break search;
        }
      }
  }
  return { commands: current, scenarios, relabelled };
}
