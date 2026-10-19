# Experimental battery planning engine

The TypeScript HiGHS/WASM engine under `engine/` is the planner behind the
**HiGHS cost optimizer** [battery control strategy](strategies.md), selectable
beside Evening target in Battery control and compared with it in the
documentation site's Planner sandbox. The engine itself only calculates plans;
the add-on's planning loop publishes them.

Import a version 1 planner snapshot and choose equivalent capabilities (native
balance and the exported writable boundaries) or expanded capabilities (explicitly
assumed hold, charge and discharge modes). Expanded capabilities are the sandbox default and always assume permission
for grid charging and battery export. Equivalent capabilities remain balance-only. Expanded setpoint resolution is supplied by the
user; power-limit entities do not establish direct-control support.

The sandbox runs every registered strategy on the same physical snapshot and
scores each with the same evaluation for nominal and reduced solar
(`scoreCommands`). Evening target alone receives its deadline and target. The
table compares cost including wear, final SoC and runtime. Interval commands
show mode, boundaries, applicable signed setpoint and predicted battery power.
Existing snapshot exports remain version 1; a downloaded comparison carries the
dataset, the engine inputs and every strategy's result.

HiGHS optimizes only mean scenario cost: import charges minus export revenue
plus configured wear. After proving optimal cost, it uses any remaining solver
budget to prefer more time in balance at equal cost (within numerical tolerance),
and reports that preference separately from cost optimality. Selected power
boundaries still apply. Losses are modeled physically. It has no evening target,
shortfall penalty or terminal reserve value. Evening target retains its deadline,
reserve, switching and spike-buffer preferences. A cheaper schedule ending emptier is not
a like-for-like saving. Solar use is priced through lost export revenue and
modeled curtailment rather than rewarded regardless of price.

The engine models discrete limits, all four modes, native SoC protection and PV
curtailment. Expanded control assumes an adapter clips power to enforce explicit
grid charging/export permissions against live conditions. Curtailment remains an
equilibrium forecast, not a prediction of controller transients. Initial SoC
may be outside the configured operating window, provided it is within 0–100%.
Planning preserves the actual reading: below the minimum, discharge stops until
charging restores energy above the floor; above the maximum, charging stops
until discharge creates room. Neither boundary forces an immediate correction
or changes permission to charge from the grid.

Both strategies run in a browser worker in the sandbox; in the add-on and the
gym the engine runs on a worker thread through `engine/node.mjs`.
Solver status and independent physical replay gate every returned schedule.
Time-limited feasible plans are unproven, infeasible/no-incumbent runs return no
schedule, and only proven solver results claim modeled optimality. Reduced solar
is a second modeled scenario, not a guarantee against unexpected weather.

The versioned event contract — a coherent command with mode, boundaries,
setpoint, permissions, identity and validity — is what every strategy publishes
([battery commands](battery-control.md#publishing-commands)), and carries the
hold, charge and discharge modes this engine plans in. **In production HiGHS
plans with equivalent capabilities only** — balance with the battery's
boundaries, no grid charging or export — because direct modes need an adapter
that enforces permissions against live power. Expanded capabilities stay in the
sandbox until then.
