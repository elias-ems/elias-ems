import assert from "node:assert/strict";
import test from "node:test";
import { Milp } from "../src/algebra.ts";
import { inspectSolution } from "../src/solver-result.ts";

function model() {
  const model = new Milp();
  const x = model.variable(0, 3, true);
  const y = model.variable(0, 5);
  model.constrain(model.add(x, y), "=", 4);
  return model;
}
const incumbent = { x0: { Primal: 1 }, x1: { Primal: 3 } };

test("a feasible limited incumbent is usable but never proves optimality", () => {
  for (const Status of [
    "Time limit reached",
    "Iteration limit reached",
    "Bound on objective reached",
    "Target for objective reached",
  ]) {
    const result = inspectSolution(model(), { Status, Columns: incumbent });
    assert.equal(result.usable, true);
    assert.equal(result.optimal, false);
  }
  assert.equal(
    inspectSolution(model(), { Status: "Optimal", Columns: incumbent }).optimal,
    true,
  );
});
test("no-incumbent, fractional and physically infeasible primals are rejected even under Optimal", () => {
  for (const Columns of [
    undefined,
    {},
    { x0: { Primal: 1 } },
    { x0: { Primal: NaN }, x1: { Primal: 3 } },
    { x0: { Primal: 1.5 }, x1: { Primal: 2.5 } },
    { x0: { Primal: 1 }, x1: { Primal: 4 } },
    { x0: { Primal: 4 }, x1: { Primal: 0 } },
  ]) {
    for (const Status of ["Optimal", "Time limit reached"]) {
      const result = inspectSolution(model(), { Status, Columns });
      assert.equal(result.usable, false);
      assert.equal(result.optimal, false);
    }
  }
});
test("failed or indeterminate solver statuses cannot expose stale feasible values", () => {
  for (const Status of [
    "Infeasible",
    "Unbounded",
    "Unknown",
    "Solve error",
    "Not Set",
  ]) {
    assert.equal(
      inspectSolution(model(), { Status, Columns: incumbent }).usable,
      false,
    );
  }
});
