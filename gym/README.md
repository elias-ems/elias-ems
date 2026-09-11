# Battery planner gym

A local, offline experiment harness. `gym/` is a project convention, not a
dependency on Python Gymnasium or a reinforcement-learning framework. Node 24
runs the production TypeScript optimizer directly; no second implementation or
package install is needed. Run commands from the repository root.

## Run and curate

```sh
node gym/run.mjs gym/examples/synthetic.json gym/results/synthetic
node --test gym/test/*.test.mjs
```

Each run writes `report.json`, `schedule.csv`, and `curation.md`. The report
records dataset and algorithm SHA-256 hashes, git commit, runtime, energy cost,
terminal reserve penalty, end SoC and ceiling changes. The comparison is against
the same simulator always allowing maximum charging. Lower objective is better;
energy cost and terminal penalty are shown separately so emptying the battery
at the horizon does not masquerade as savings. CSV timestamps are UTC; dataset
metadata records the household timezone. Curation notes survive reruns. Use a
new output directory for each experiment to retain previous reports.

The baseline imports `optimizeCharge` and `simulateCharge` from
`addon/app/lib/charge-plan.ts`. It exercises that pure optimization core, not
the server's forecast fetching, reserve construction or five-minute control
loop. It never commands Home Assistant. Future candidates should use identical
datasets and an unchanged evaluator; first curate inputs and expected behavior
before optimizing a score or asking models to change the algorithm.

## Private captures

`data/` and `results/` are gitignored. Do not commit household captures, endpoint
URLs or tokens. Only synthetic examples belong in version control.

Set `HA_MCP_URL` in your local shell to your private unofficial HA MCP endpoint.
The capture command permits only state/history/search reads and Energy
preferences with `mode=get`:

```sh
node gym/capture.mjs ha_manage_energy_prefs '{"mode":"get"}' gym/data/session/energy-prefs.json
node gym/capture.mjs ha_get_history '{"entity_ids":["sensor.example_energy"],"source":"statistics","period":"hour","statistic_types":["change"],"start_time":"2026-09-10T00:00:00+02:00","end_time":"2026-09-11T00:00:00+02:00","limit":1000}' gym/data/session/energy-history.json
```

For preparation, capture all grid/solar/battery energy counters in
`energy-history.json`, their state/units in `counter-units.json`, and buy/sell
tariffs plus SoC history in `state-history.json`. Resolve pagination before
preparing: truncated captures are rejected. The MCP statistics API does not
request a standard energy unit; preparation converts Wh/kWh/MWh explicitly.
Missing units, unavailable values, negative energy and gaps fail visibly.
Current units are assumed unchanged over the historical window.

```sh
node gym/prepare.mjs gym/data/session gym/data/session/spec.json gym/data/session/day.json
node gym/run.mjs gym/data/session/day.json gym/results/day-baseline
```

The spec has `id`, offset-qualified `start` and `end`, `timeZone`, `currency`,
`buyEntity`, `sellEntity`, `socEntity`, `model`, `terminalReserveKwh` and an
`assumptions` array. Model fields match the synthetic example except `soc`, which
is read at the start from historical data. Supply actual configured capacity,
SoC bounds, hardware power limits, device step, efficiency and wear. The reserve
is explicit and curated, not silently derived from future measurements.

## Initial household capture: 11 September 2026

Local files are under `data/2026-09-11/`. They include Energy preferences,
roughly two weeks of hourly energy history, yesterday/today tariff and SoC
history, current battery metadata, and a current Helios/price snapshot.

- `yesterday.json`: 10 September, full local day (96 quarter-hours).
- `today.json`: 11 September, 07:00–20:00 Brussels (52 quarter-hours).
  SMA statistics are missing from 03:00–07:00; no zeros were invented. The
  capture ended before today finished. Earlier available hours remain in raw
  history. `spec-10.json` and `spec-11.json` make preparation reproducible.
- Results: `results/2026-09-10-baseline/` and `results/2026-09-11-baseline/`.

These are **measured-hindsight** cases. Hourly measured energy is distributed
uniformly over four quarter-hours; tariffs are time-weighted from recorded
changes. Solar may already include curtailment. Recorded battery charge and
discharge counters reconstruct demand and may include conversion losses.
Today's snapshot is not yesterday's forecast. Neither these simulations nor
their improvements are claims of achieved household savings.

Historical forecast snapshots were not recovered. For realistic forecast
evaluation later, record inputs with an `asOf` timestamp at each planning
decision, keep subsequently measured outcomes separate, and never give a
candidate future observations. Keep a held-out set beyond these two days to
avoid tuning an algorithm to a single household/day. That is the next phase,
after input and result curation.
