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

## Future event contract (not implemented)

`BatteryControlEvent` version 1 carries battery identity, unique command identity,
owner epoch, issue time and either release or one coherent interval command.
The interval's start/end are its validity period. Apply includes mode, both
boundaries, the applicable signed setpoint (none for balance, zero for hold),
and explicit grid-charging/battery-export permissions.
A future adapter must reject stale epochs/commands, expired commands and modes
it cannot implement. Publication acknowledgement is not confirmation of device
application; readback/adapter acknowledgement must be separate.

Future activation must acquire exclusive ownership and restore/release the old
charge-limit leases before publishing new commands. On disable, failure or expiry,
release ownership and restore the recorded native mode/limits; do not equate
release with hold. On restart, recover outstanding restorations, create a fresh
epoch and require a new plan before applying. Device-side expiry/watchdog behavior
must work even if Elias is down. Neither publisher, watchdog nor migration is
installed by this change.

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
