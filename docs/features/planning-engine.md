# Experimental battery planning engine

The documentation site's Planner sandbox compares the production Evening target
planner with a TypeScript HiGHS/WASM engine under `engine/`. Production control
continues to use Evening target. The new engine only calculates plans.

Import a version 1 planner snapshot and choose equivalent capabilities (native
balance and the exported writable boundaries) or expanded capabilities (explicitly
assumed hold, charge and discharge modes). Expanded capabilities are the sandbox default and always assume permission
for grid charging and battery export. Equivalent capabilities remain balance-only. Expanded setpoint resolution is supplied by the
user; power-limit entities do not establish direct-control support.

Both planners use the same physical snapshot and share evaluation for nominal
and reduced solar. Evening target alone receives its deadline and target. The table compares
cost including wear, final SoC and runtime. Interval commands
show mode, boundaries, applicable signed setpoint and predicted battery power.
Existing snapshot exports remain version 1; downloaded comparison results add
the engine inputs and assumptions alongside the original Evening target result.

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
outside the configured window is unsupported and reported; it is never clamped.

Both planners run in a browser worker; Node engine calls use worker threads.
Solver status and independent physical replay gate every returned schedule.
Time-limited feasible plans are unproven, infeasible/no-incumbent runs return no
schedule, and only proven solver results claim modeled optimality. Reduced solar
is a second modeled scenario, not a guarantee against unexpected weather.

The versioned event contract — a coherent command with mode, boundaries,
setpoint, permissions, identity and validity — is now what both production
strategies publish ([battery commands](battery-control.md#publishing-commands)),
including the hold, charge and discharge modes this engine plans in. The engine
itself still publishes no events and performs no live writes; production uses
Evening target and net zero energy.
