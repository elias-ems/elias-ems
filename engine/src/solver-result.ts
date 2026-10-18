import type { Milp } from "./algebra.ts";

type SolverResponse = {
  Status: string;
  Columns?: Record<string, unknown>;
};

/** A limit status is not evidence of an incumbent. Verify every bounded
 * variable, integer and constraint before exposing any solver values. */
export function inspectSolution(model: Milp, result: SolverResponse) {
  const values = Object.fromEntries(
    Object.entries(result.Columns ?? {}).map(([name, column]) => [
      name,
      column !== null &&
      typeof column === "object" &&
      "Primal" in column &&
      typeof column.Primal === "number"
        ? column.Primal
        : NaN,
    ]),
  );
  const usable =
    [
      "Optimal",
      "Time limit reached",
      "Iteration limit reached",
      "Bound on objective reached",
      "Target for objective reached",
    ].includes(result.Status) && model.feasible(values);
  return { values, usable, optimal: usable && result.Status === "Optimal" };
}
