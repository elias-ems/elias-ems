# Battery planner gym

Offline replay of the production TypeScript battery optimizer using Node 24.
Run commands from the repository root; no Home Assistant connection is needed.

## Fixed dataset

The EMS exposes this benchmark under **More → Benchmark**, with a **Run all
algorithms** button. The CLI and EMS share the algorithm registry, fixed input
and experiment settings. The input and settings live in
`addon/app/lib/benchmark-data/` so they ship with the add-on; the historical
context and frozen reference remain in `gym/datasets/household-2026-09-11/`.

- `addon/app/lib/benchmark-data/input.json`: 11 September 2026, 07:00–20:00 Brussels (52 quarter-hours).
  This is the only dataset used by the default runner and automated test.
- `yesterday.json`: 10 September, the full local day (96 quarter-hours), retained
  as historical context. The pure optimizer does not read this file.
- `reference.json`: frozen output of the original optimizer on today's input.
  Keep this unchanged when experimenting with algorithms.
- `curation.md`: persistent review notes for the fixed case.

The production planner uses history to forecast household demand. This harness
exercises only `optimizeCharge` and the shared `simulateCharge` evaluator from
`addon/app/lib/charge-plan.ts`. Demand is already prepared in each input slot;
forecast fetching, demand forecasting, reserve construction and the control loop
are outside this test.

## Run and review

```sh
node gym/run.mjs
node --test gym/test/*.test.mjs
# Preserve a particular experiment separately:
node gym/run.mjs addon/app/lib/benchmark-data/input.json gym/results/candidate-1
```

Runs write `report.json`, `schedule.csv` and `curation.md` to `results/latest`
by default. Results are ignored by Git; the committed reference is never
rewritten by the runner. Copy useful review findings into the dataset's committed
`curation.md`. Generated curation notes survive reruns.

Reports record input and algorithm SHA-256 hashes, git commit, runtime, the plan,
energy cost, terminal reserve penalty, final SoC and ceiling changes. Compare
candidate objectives with `reference.json` using the same input hash and evaluator;
lower is better. The automated test checks reproducibility and physical bounds,
not exact equality with the reference, so improvements can change the schedule.

`unrestricted` means the same simulation with maximum charging always allowed.
It is distinct from the frozen reference optimizer result. `objectiveImprovement`
is unrestricted objective minus candidate objective. The plan's `baselineSoc`
field also refers to unrestricted charging. CSV timestamps are UTC.

## Coverage and assumptions

This is a measured-hindsight experiment, not a replay of forecasts known at the
time. Hourly measured solar and reconstructed household demand are repeated over
four quarter-hours. Tariffs are time-weighted from recorded changes. Demand is
solar + grid import - grid export + battery discharge - battery charge, after
converting energy counter units. Solar may already include curtailment and battery
counters may include conversion losses. Model and terminal reserve assumptions
are recorded in each input.

Today's SMA history has a gap from 03:00–07:00 and the capture ended before the
day finished. The replay uses the contiguous 07:00–20:00 window without invented
zeros. Yesterday's normalized history is retained separately. These files do not
contain historical forecast snapshots, and simulated improvements are not claims
of achieved savings. Testing history-based forecasting needs a separate harness.

The one-off capture and preparation tools have been removed. Raw local captures
under `data/` remain ignored; the approved normalized dataset is versioned.

## Multiple algorithms and benchmark

```sh
node gym/benchmark.mjs
node gym/run.mjs addon/app/lib/benchmark-data/input.json gym/results/evening-target evening-target
```

The shared registry in `addon/app/lib/benchmark-algorithms.ts` exposes
`cost-optimized` (existing dynamic programming optimizer) and `evening-target`
(evening deadline algorithm). Add candidates there; `algorithms/index.mjs`
adapts that registry for CLI source hashing.
The runner takes input, output directory, algorithm name and optional settings
file; the benchmark takes input, output directory and optional settings file.

`experiment.json` specifies an explicit offset-qualified evening deadline, target
SoC, solar haircut, switching cost and search pass limit. The deadline must match
an interval end. These settings are separate from the frozen input and reference.
The initial experiment uses 18:00 Brussels, 100% SoC, 20% less solar and EUR 0.002
per ceiling change. They are experimental assumptions, not measured uncertainty
or live user configuration. A different day requires its own deadline setting.

The evening candidate starts with maximum acceptance, computes the reachable
energy at the deadline in nominal and reduced-solar scenarios, and preserves
those targets while searching discrete device ceilings. If full is unreachable,
it preserves the maximum reachable deadline energy and reports the shortfall.
It searches four-interval blocks and individual intervals over several passes.
This is a bounded local search, not a globally optimal solver.

Among feasible schedules it minimizes the equally weighted energy costs of the
two scenarios plus a switching penalty and an end reserve penalty. Import costs account for household demand
between charging periods; the battery minimum SoC remains the physical reserve.
There is no additional hard morning reserve. Lower solar provides headroom against
forecast error but cannot guarantee performance for all weather outcomes. Both
scenarios are known to the candidate; this is not an unseen stress test.

Review `results/benchmark/comparison.md`, and each algorithm's `schedule.csv` and
`report.json` beneath that directory. Both schedules are evaluated with the same
simulator on both scenarios. Reports show actual energy cost separately from the
legacy terminal-penalty objective and candidate search objective. Do not rank these
algorithms solely on the legacy objective: the new candidate has an explicit
evening requirement and a switching preference. Evaluator and algorithm hashes
are recorded. Runtime covers one planner call and is only indicative.

Both algorithms share their production implementation with the gym. The original committed reference output remains unchanged.

The benchmark also rebuilds `results/benchmark/index.html`, a standalone visual
report with comparison charts, scenario costs and a detailed interval table.
Open it in a browser; rerun the benchmark and reload to see updated results.
It uses local dataset time, embeds all data, and needs no server or internet.

Select a default run with `algorithm` in `experiment.json`; select benchmark
participants with the `algorithms` array. The live Battery control settings use
the same Cost optimized and Evening target choices. Live evening planning uses
the next configured local deadline and the battery maximum SoC; the solar margin
is applied once, as a reduced-solar scenario rather than reducing both scenarios.

`spikeBufferKwh` defaults to 0.54 for Evening target; 0 disables it. The
reported search objective includes a daytime buffer shortfall preference,
separate from simulated energy costs. The spike test compares the same
held-out demand pulse with and without a buffer, including discharge below
the buffer target. Smooth hindsight costs alone cannot measure this benefit.
