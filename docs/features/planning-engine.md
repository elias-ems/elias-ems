# Experimental battery planning engine

The documentation site's Planner sandbox compares the production Evening target
planner with a TypeScript HiGHS/WASM engine under `engine/`. Production control
continues to use Evening target. The new engine only calculates plans.

Import a version 1 planner snapshot and choose equivalent capabilities (native
balance and the exported writable boundaries) or expanded capabilities (explicitly
assumed hold, charge and discharge modes). Grid charging and battery export are
separate opt-in assumptions. Expanded setpoint resolution is supplied by the
user; power-limit entities do not establish direct-control support.

Both planners receive the same snapshot, maximum-SoC target and deadline, then
share physical evaluation for nominal and reduced solar. The table compares
cost including wear, evening/final SoC, shortfall and runtime. Interval commands
show mode, boundaries, applicable signed setpoint and predicted battery power.
Existing snapshot exports remain version 1; downloaded comparison results add
the engine inputs and assumptions alongside the original Evening target result.

HiGHS either gives evening shortfall lexicographic priority over cost or prices
shortfall explicitly. Its cost objective includes import/export tariffs, losses,
wear and conservative terminal reserve value. Evening target additionally uses
switching and spike-buffer preferences. A cheaper schedule ending emptier is not
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

The versioned future event contract carries a coherent command with mode,
boundaries, setpoint, permissions, identity and validity. Future execution must own mode and
limits exclusively, restore old leases during migration, reject expired commands,
and distinguish publication from device confirmation. This implementation
publishes no events and performs no live writes.
