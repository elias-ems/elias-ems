# Battery planning engine

Uses [highs-js](https://github.com/lovasoa/highs-js), pinned as `highs@1.15.4`.

Experimental planning only. No Home Assistant imports, service calls, event
publishing, persistence or production-control changes.

Install with `npm ci --prefix engine`. The site build now requires this install
as well as `npm ci --prefix site`. Engine lint/types borrow the add-on toolchain:

```sh
npm ci --prefix addon
npm test --prefix engine
npm run typecheck --prefix engine
npm run lint --prefix engine
```

Node callers use `plan(input, { signal })` from `engine/node.mjs`. It constructs
the model and loads HiGHS in a disposable worker thread, with cancellation and a
wall-clock deadline. Node 24+ can load the TypeScript sources directly. Do not
import `src/solve.ts` onto a UI or server thread. The browser sandbox runs both
planners in its own disposable Web Worker. Its WASM URL is emitted by Vite,
including the GitHub Pages base path; no CDN or network solver is used.

## Model and results

The inputs use AC watts and DC kWh. Charge is positive, discharge negative.
Each interval is constant forecast power; SoC saturation reduces average power.
The same schedule is evaluated in nominal and reduced solar. Battery efficiencies
apply separately in each direction; wear is charged per AC kWh entering the
battery, matching existing exports. Imports and exports are mutually exclusive,
as are charge and discharge. The actual meter is load + charging - discharge -
generated solar. Negative tariffs do not relax these equations.

Balance follows native self-consumption clipped by writable boundaries and SoC.
Hold requests zero battery power, regardless of the grid meter. Charge/discharge
request a signed, discrete AC setpoint within the boundaries. Expanded scenarios
explicitly assume these modes exist, with native SoC protection and a local
adapter enforcing grid-charge and battery-export permissions against live power.
A future device without that adapter cannot execute those assumptions safely.
Existing limit entities never establish direct-control capability. A missing
output limit retains fixed native discharge in balance, including in comparison.

The mixed-integer model encodes the physical replay as bounded piecewise-linear
expressions, including min/max clipping, discrete device steps, mode selection,
PV floors/ceilings, proportional array allocation and fixed-step episode state.
PV first gives the battery forecast acceptance before applying curtailment;
direct discharge also reduces PV demand. This is an equilibrium approximation,
not a simulation of controller ramps, delays or percent quantization. Fixed-step
threshold ties can be numerically ambiguous; a result whose exact replay differs
in energy, PV generation, battery flow or cost is rejected.

The primary objective is mean nominal/reduced-solar cost: grid import charges minus
export revenue plus configured battery wear. There is no evening deadline,
SoC target, shortfall penalty, terminal reserve value, switching penalty or
spike-buffer preference. SoC minimum/maximum bounds still protect the battery.
The engine may finish at minimum SoC when using the stored energy saves money.
No value or tariff is invented beyond the supplied horizon.

Evening target retains its original target and reserve preferences in the
sandbox. Its settings remain in version 1 snapshots for backward compatibility,
but the adapter does not pass them to HiGHS. Compare final SoC alongside cost:
a cheaper schedule may simply leave less energy stored for later.

Only HiGHS `Optimal` (within numerical tolerances), with validated primal constraints and physical replay, can
produce an optimality claim for the modeled cost problem. Once cost is proven
optimal, a second solve maximizes time in balance mode while keeping that cost
(with a 1e-8 currency-unit numerical tolerance over the horizon). This is a
lexicographic tie-breaker, not a monetary incentive. It uses the remaining shared
budget and is skipped for balance-only capabilities or when balance is unavailable.
A limited or rejected second result never replaces the first with a costlier plan;
the original cost-optimal plan remains available. `balancePreference` reports
whether the tie-break itself was proven. Limits still apply in balance mode;
this preference does not maximize those limits or guarantee unrestricted response
to unexpected demand. Feasible time-limited incumbents are labeled unproven; no feasible
incumbent, infeasibility, invalid input or replay mismatch yields no schedule.
The solver time budget is shared by initialization, construction and both solves;
Node also has an outer termination deadline. Browser users can cancel the worker.
The current input limit is 384 contiguous intervals. Initial SoC outside the configured window is explicitly unsupported rather
than clamped, since clamping would invent energy. No forecast resampling occurs.

## Event contract

`BatteryControlEvent` version 1 is now published by the add-on for both
production strategies, as `elias_ems_<slug>_battery_command` — see
[`battery-command.ts`](../addon/app/lib/battery-command.ts) and [Publishing
commands](../docs/features/battery-control.md#publishing-commands). It carries
battery identity, unique command identity, owner epoch, issue time, and either a
release or one coherent command: mode, both boundaries, the applicable signed
setpoint (none for balance, zero for hold), grid-charging/battery-export
permissions and a validity period. An engine `Command` maps onto it field for
field, so wiring HiGHS into execution needs no contract change; the add-on's
payload is the snake_case, flat form an automation reads from Jinja.

What already holds: the add-on releases rather than holds on disable, failure,
un-steering and shutdown; a strategy only releases batteries it owns; a fresh
epoch is created on every restart; and the limit-entity leases of the old
charge-limit writer are restored before any command for that battery is
published. Publication is still not confirmation — an adapter acknowledgement
would be a separate event.

Still for the engine's integration: an adapter that rejects stale epochs and
commands, expired commands and modes it cannot implement, and enforces the
permissions against live power. Today every battery has a hand-written
automation, and the direct modes' explicit permissions are only as safe as
it is. Device-side expiry must work even if Elias is down; no watchdog is
installed automatically.

## Verification

The tests exercise the actual WASM solver in Node workers, exhaustive small-case
optimality, native-simulator parity, stateful PV, losses/conservation, negative
prices, permissions, infeasibility and a depleted solver budget. CI defines native
x86-64 and ARM64 jobs. Defining those jobs is not evidence of an ARM64 run.

The production-browser smoke test is `node site/test/browser-planner.mjs` after
building and serving the site with `npm run docs:preview --prefix site -- --port
4173`. It uses the add-on's Playwright package; set `CHROMIUM_PATH` to use an
installed Chromium. Set `PLANNER_BROWSER=firefox` or `PLANNER_BROWSER=webkit`
to select another Playwright browser. It checks both capability comparisons,
WASM delivery under `/elias-ems/`, result downloads and phone-width layout.

Local verification on Linux x86-64: Node 24.22.0 and the checkout's pinned
26.12.0 ran the engine tests; Chromium 154 and Playwright Firefox 153 ran the
built sandbox in both capability modes at desktop and phone width. Site and add-on production builds,
site tests, engine/site lint and typechecks passed. Vite reports the solver's
conditional `node:module` import as externalized; the production browser test
verifies the browser branch works. WebKit 26.5 downloaded but could not launch:
the host lacks libicu74, libxml2 and libflite1. Docker image checks could not run
because this session cannot access the Docker daemon. Native ARM64 was not tested locally. Both native ARM64 and amd64 engine jobs
passed lint, typechecking and all 18 tests in
[CI for 6475807](https://github.com/elias-ems/elias-ems/actions/runs/39137086264).

Deterministic tests reject missing, fractional, out-of-bounds and
constraint-violating primal values even when the status says Optimal. Cost-only
regressions verify that the engine does not buy energy just to fill the battery
and can spend the available energy down to minimum SoC without preserving an
evening or terminal reserve.
