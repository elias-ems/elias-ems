# Battery planner gym

Offline replay of the production TypeScript battery optimizer using Node 24.
Run commands from the repository root; no Home Assistant connection is needed.

## Fixed dataset

`datasets/household-2026-09-11/` contains the approved, committed inputs:

- `input.json`: today, 11 September 2026, 07:00–20:00 Brussels (52 quarter-hours).
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
node gym/run.mjs gym/datasets/household-2026-09-11/input.json gym/results/candidate-1
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
