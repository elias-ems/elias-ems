# Battery control strategies

A **strategy** decides what the battery should be doing over the next day or
two. There are two, and one registry that everything reads:

| Id | Label | What it optimises |
| --- | --- | --- |
| `evening-target` | Evening target | the battery's maximum charge by 18:00, in nominal and reduced solar, then cost — a bounded local search |
| `highs` | HiGHS cost optimizer | the lowest mean cost over the nominal and reduced-solar scenarios — an exact mixed-integer solve |

The registry is [addon/app/lib/strategies/index.ts](../../addon/app/lib/strategies/index.ts).
Four places read it, and none of them names a strategy itself:

- **Settings → Battery control** offers every registered strategy
  (`STRATEGIES` in `control.ts` is derived from it) and stores the chosen id in
  `control.json`.
- **The planning loop**
  ([charge-limit-loop.server.ts](../../addon/app/lib/charge-limit-loop.server.ts))
  plans with whichever id is stored, publishes the current interval, and names
  the strategy on the command event.
- **The Planner sandbox** on the documentation site
  ([site/lib/comparison.ts](../../site/lib/comparison.ts)) runs every
  registered strategy on an imported snapshot and shows them side by side.
- **The gym** ([gym/strategies.mjs](../../gym/strategies.mjs)) runs and scores
  them from the command line, for experiments and training loops.

So adding a strategy — a tuned variant, a learned policy, anything else — is a
module implementing `Strategy` and one line in the registry. Settings offers it,
production can run it, the sandbox compares it and the gym scores it, with
nothing else to change.

## The contract

In [strategies/types.ts](../../addon/app/lib/strategies/types.ts):

```ts
type Strategy<Id extends string> = {
  id: Id;                      // stored in control.json, sent as the event's `strategy`
  label: string;               // what Settings and the sandbox call it
  description: string;         // shown under the select in Settings
  supportedModes: Mode[];      // modes it can ever issue
  needsDeadline: boolean;      // needs a slot ending at the evening deadline
  plan(snapshot: PlanningSnapshot, context: StrategyContext): Promise<StrategyResult>;
};
```

**Inputs.** A `PlanningSnapshot` is the core of a planner export (snapshot
version 1): the battery `model` (capacity, SoC window, current SoC, device
steps, efficiency, wear), the `slots` (15-minute intervals with forecast solar,
household load, buy and sell prices and modelled PV curtailment), the
`terminalReserveKwh`, and Evening target's `settings` block, whose
`solarHaircut` defines the reduced-solar scenario every strategy is scored on
(and, mirrored, the excess-solar replay the sandbox reports beside it but
leaves out of `meanCost`).
The add-on builds it live in `preparePlannerInputs`; the sandbox and the gym
parse it from a file. The `StrategyContext` carries what is platform-specific:

| Field | Add-on | Sandbox | Gym |
| --- | --- | --- | --- |
| `capabilities` | the battery's ticked control modes (`batteryCapabilities`) | the exported battery's modes, balance only, or expanded (all four modes) | balance, or `--expanded` |
| `timeLimitSeconds` | 20 | the form's solver budget | 30 |
| `solveHighs` | a worker thread via `engine/node.mjs` | the sandbox's browser worker | a worker thread via `engine/node.mjs` |

**Outputs.** A `StrategyResult` is one engine `Command` per slot — mode,
charge and discharge boundaries, setpoint — plus the same plan in the
`ChargePlan` shape the dashboard's plan card draws, a one-line `status`,
`notes`, and strategy-specific `details` (Evening target's reachable deadline
SoC, HiGHS's solver statuses).

**Strategies are pure.** No Home Assistant, no clock, no disk, no randomness:
everything comes in through the snapshot and the context, and the solver is
injected. That is what makes a plan reproducible from a snapshot, the sandbox
honest about production, and a gym possible.

## Scoring

`scoreCommands(snapshot, commands, capabilities)` in
[strategies/score.ts](../../addon/app/lib/strategies/score.ts) is the one rule
every strategy is judged by: the engine's physical replay
([engine/src/physics.ts](../../engine/src/physics.ts) `evaluate`) of the
commands under the forecast and under reduced solar, returning both scenarios
and their `meanCost` — import cost minus export revenue plus wear. A strategy's
own claimed cost is never used: each has its own internal objective, and
comparing those would compare preferences rather than outcomes.

`meanCost` counts nothing for energy left in the battery at the end of the
horizon, so compare `finalSoc` beside it. That is the main reason HiGHS can
look cheaper than Evening target on a snapshot: it may end emptier.

## Evening target

The original planner, wrapping `evening()` in
[charge-evening.ts](../../addon/app/lib/charge-evening.ts). Its behaviour and
fixed parameters are in [battery-control.md](battery-control.md#evening-target)
and [charge-limit.md](charge-limit.md#forecast-and-financial-model). It only
ever issues `balance`, and needs a slot ending at the next 18:00 to plan.

## HiGHS cost optimizer

The HiGHS/WASM engine in [engine/](../../engine/README.md), described in
[planning-engine.md](planning-engine.md). It minimises mean scenario cost
exactly, then, with any solver budget left, prefers more time in balance at
equal cost. It has no evening target, no shortfall penalty and **no terminal
value**, so a plan can end at the minimum SoC; the planning loop replanning
at every price interval moves that horizon along, but valuing the end state properly
is open work.

In production it plans with **the battery's own capabilities**:
`batteryCapabilities` in
[strategies/capabilities.ts](../../addon/app/lib/strategies/capabilities.ts)
turns the modes ticked in Settings into balance plus hold, charge and discharge
setpoints, with `charge` permitting grid charging and `discharge` battery
export, in the battery's power step. A battery with only balance gets exactly
what Evening target publishes: the charge ceiling and, when the automation can
limit discharge, the AC output ceiling. The Planner sandbox uses the same
function on an export, so its default run is what production planned.

The solver runs on a worker thread
([highs-runner.server.ts](../../addon/app/lib/highs-runner.server.ts) importing
`engine/node.mjs` from `../engine` at runtime, never bundled) with a 20-second
budget and the engine's own wall-clock deadline on top. A settings save aborts a
solve in progress. A solve with no schedule, a crash or an overrun is a
planning failure: the battery is released to its native self-consumption rather
than another strategy being substituted silently.

## Adding a strategy

1. Write `addon/app/lib/strategies/<name>.ts` exporting a `Strategy<"<id>">`.
   Import with `.ts` extensions and keep it pure, so Node can run it directly
   in the gym and Vite can bundle it in the add-on and the site.
2. Add it to `STRATEGY_REGISTRY` in `strategies/index.ts`.
3. Run `node gym/strategies.mjs <snapshot.json>` to score it beside the others,
   and the sandbox to look at it interval by interval.
4. Extend [strategies.test.ts](../../addon/test/unit/strategies.test.ts); the
   registry test pins the list on purpose.

A strategy whose commands use a mode outside the context's `capabilities` is
rejected by the replay, so a sandbox-only idea cannot reach production by
accident.

## The gym

```sh
node gym/strategies.mjs addon/app/lib/benchmark-data/input.json
node gym/strategies.mjs export.json highs --expanded
```

Prints each strategy's status, runtime, `meanCost` and the two scenario totals
as JSON. `runStrategies(snapshot, { ids, capabilities, timeLimitSeconds })` and
`snapshotOf(dataset, settings)` are exported for a training loop: the same
snapshot gives the same commands and the same score every time, which
[gym/test/strategies.test.mjs](../../gym/test/strategies.test.mjs) checks. A
learned policy is a strategy like any other — register it, and it is
selectable in production under the same capability limits.

The older [benchmark gym](../../gym/README.md) (`gym/run.mjs`,
`gym/benchmark.mjs`) predates the registry and compares the legacy cost
optimizer with Evening target on its own scoring; folding it onto the registry
is follow-up work.
