# Self-consumption charge-limit optimization

Elias plans a battery's **maximum charging power** and optional **maximum AC
output power** while it remains in native self-consumption mode, and publishes
the current interval as a `balance` [battery
command](battery-control.md#publishing-commands). Reducing output during
cheaper hours preserves energy for higher-priced demand, including the morning
before solar recovery. This is the feature both [battery control
strategies](strategies.md) run in: **Evening target** plans with the local
search described below, **HiGHS cost optimizer** with an exact solver, and both
publish the same kind of command. A battery is only commanded when **Steer this
battery** is checked, and planning still requires one configured household
battery.
Elias does not request grid charging or change the operating mode or native SoC
limits. The minimum charge setting (for example 5%) remains the protective floor.

**Elias no longer writes the limits itself.** An automation listening for the
battery's command event applies `charge_limit_w` and `discharge_limit_w` to the
inverter, and puts its normal limits back on a release — see [Boundaries in
balance](battery-control.md#boundaries-in-balance). That is what lets a second
battery, with different entities, be a second automation rather than a change
here.

The output search also tries opening an entire constant-ceiling stretch and the
whole forecast horizon. This avoids unnecessary restrictions that persist when
opening only a short block would add switching costs. These moves must preserve
the reachable evening target in both forecast and reduced-solar simulations and
must not worsen the objective; equal scores favor output headroom for load spikes.

## Setup

In Settings → Batteries, edit the battery:

1. Match the capacity, minimum/maximum SoC, and charge/discharge hardware limits
   to the battery's native configuration. Both power limits are required: they
   are the top of the range the boundaries are planned in. Elias does not change
   its SoC settings.
2. Set **Power step (W)** to the step of the limit setting the automation will
   write (100 W by default).
3. Tick **Can limit discharge (AC output) in balance** only if the automation can
   cap battery output — not combined PV/inverter output or grid export. Leave it
   off to retain native discharge.
4. Tick **Plan charge limits** and save. Home automatically calculates a preview,
   even while Battery control is disabled, with the selected strategy.
   Efficiency defaults to 95% in each direction. The other planning inputs are
   fixed; see [Fixed planning settings](#fixed-planning-settings).
5. Write the automation for the battery's `elias_ems_<slug>_battery_command`
   event, then tick **Steer this battery**. Set self-consumption on the device.
6. Check the Home plan, then select **Evening target** or **HiGHS cost
   optimizer** and enable Battery control to publish commands. The plan is
   refreshed five minutes before each price interval ends, and the next
   interval's command goes out as it starts.

Once battery control is enabled, the choice of strategy persists across
restarts and updates. The plan card checks the saved control settings and
battery configuration independently of planning, without waiting for the history
fetch or taking the execution lock. Enabled control shows a neutral waiting
message while a plan is being prepared; it does not ask for settings to be saved
again. Disabled control and conflicting battery settings show their specific
settings action immediately. Planning failures and incompatible forecast inputs
remain separate warnings; a command is only published after a valid plan passes
all execution checks.

### Upgrading from direct limit writes

Earlier versions wrote the two limit entities themselves and journalled each
entity's original value in `charge-limit-leases.json` first. On upgrade:

- **The battery arrives unsteered**, with **Plan charge limits** ticked, and
  **Can limit discharge** ticked if it had an output entity. The preview keeps
  working; commands start once the automation exists and the box is ticked
  again.
- **Outstanding limits are restored.** Every 30-second tick puts back any
  journalled original value — but only one Elias still owns: an entity whose
  value somebody changed since is left alone. Each direction is restored
  independently, failures are retried, and the journal shrinks to empty. Until
  it is, the plan card says it is restoring and no command is published for that
  battery, so the old writes and the new events never steer it at the same time.

The migration only ever restores. It writes no new leases, and once the journal
is empty it does nothing at all.

Dynamic consumption and production price formulas must be configured. In Home
Assistant's Energy dashboard, configure the grid, battery charge/discharge
energy counters, and a forecast for every solar source. Three complete samples
of every hour of the day are required within the last fourteen days.

One configured household battery is supported. Elias automatically sums all grid
energy counters configured in the Energy dashboard, including tariff and
accounting entries. Import and export direction comes from Home Assistant's
configuration, not entity names. No separate counter selection is needed;
previously saved selections are ignored. Duplicate statistic IDs are rejected.
Elias never modifies Energy dashboard preferences.

PV curtailment no longer suppresses the preview. Curtailment is modeled at
equilibrium when every forecast solar source matches a configured, rated array.
The model covers the grid target, minimum limit, uncurtailable and fixed-step
arrays, and both marginal-price strategies. Each Energy dashboard solar source
retains its selected forecast and is matched by its energy counter to an array.
Individual inverter floors and ceilings apply to that array's forecast; output
is not split by inverter rating. Controller transients are not predicted.
Fixed-step arrays enter their step when forecast export exceeds the configured
deadband after battery acceptance, and hold it until the price recovers. Both
algorithms carry this episode state; live planning seeds existing steps from
the controller's last published limits. Device behavior after a restart, before
any limit has been published, is assumed released. Sub-interval ramps and
whole-percent feedback quantization remain outside the equilibrium forecast.

An unmatched or unrated solar source, a forecast provider shared between arrays,
or a configured flexible-charger override,
shows an explicitly **hypothetical preview assuming uncurtailed solar**. Commands
are blocked until that configuration can be modeled or curtailment is disabled.
Another active battery strategy likewise makes the preview hypothetical. Other
external battery or PV controllers must not change the model's assumptions.

## Forecast and financial model

Elias reads `energy/get_prefs` and `energy/solar_forecast`, following the Energy
dashboard's selected providers, including Helios. Selected entry IDs are
deduplicated. Hourly `wh_hours` values are summed only where all selected sources
have data; missing hours are never silently replaced with zero. The available
forecast horizon is reported on Home. Hourly energy is spread uniformly within
its hour; dividing it into price intervals does not add forecast precision.

Recorder hourly changes, requested in kWh, reconstruct household consumption:

`solar + grid imports - grid exports + battery discharge - battery charge`

Complete observations form a mean profile by local hour in Home Assistant's
timezone. The first version does not distinguish weekdays, predict individual
appliances, or use Helios-specific confidence bands. A fixed 20% solar margin
provides a conservative planning assumption, not a statistical confidence level.

### Fixed planning settings

These used to be editable, first per battery and later under **Battery
control**. They are now constants (`CHARGE_LIMIT_PLANNING` in
`addon/app/lib/control.ts`), set to what an install had by default:

| Setting | Value |
| --- | --- |
| Evening deadline | 18:00, Home Assistant local time |
| Solar forecast margin | 20% (`solarHaircut` 0.2 in exports) |
| Wear cost per charged kWh | 0.05 in the price currency (`model.wearPerKwh`) |
| Cost per ceiling change | 0.002 in the price currency |
| Daytime spike buffer | 0.54 kWh |
| Search passes | 4 |

Values stored by an earlier version, on the battery or in the control config,
are ignored when read and dropped on the next save. An install that had
stored different ones plans with these instead. Planner exports still write
them into `settings` and `model`, so the Planner sandbox reads them as before.

Evening target is the strategy this section describes; HiGHS plans from the
same intervals, model and reduced-solar scenario but none of the evening-target
parameters — see [strategies.md](strategies.md). The old per-battery algorithm
selector is gone and older selections are ignored. The legacy cost optimizer
remains in Benchmark and the offline gym.

Evening target starts with maximum charging and minimum controllable discharge to
establish the reachable evening target in nominal and reduced-solar scenarios.
It searches charging and output ceilings using exact energy simulation, exploring
expensive demand first, then improving the charging schedule. It uses up to 41
supported choices per direction and interval, with single-interval and block
moves and four passes. Every move preserves reachable evening energy. Scarce
solar can therefore cause energy to be held even during expensive hours.
Switching costs discourage frequent changes in either direction; equivalent
output choices prefer more headroom for unexpected demand. This is a bounded
local search, not a global optimum. Computation yields between batches.

The daytime spike buffer encourages earlier charging, without rewarding an
output restriction for preserving the buffer. Its shortfall penalty uses a
separate replay of the same charging schedule with unrestricted native output,
in each solar scenario. This keeps the buffer useful for expensive morning
demand and unexpected appliances even when SoC is below the buffer target.
The configured native minimum remains the discharge floor. Energy costs,
evening feasibility and the terminal reserve are still evaluated on the actual
planned output schedule. The reported buffer penalty uses the unrestricted
reference in nominal solar.

Charging uses available solar surplus up to the selected ceiling and native
battery room. Discharge serves deficits up to the planned AC output ceiling,
hardware limit and energy above the native SoC floor. Without discharge limiting,
it follows native limits. The
objective is purchase cost minus export revenue plus the fixed wear cost
per charged kWh. Thus charging with solar carries the opportunity cost of the
export revenue forgone. Negative prices do not create permission to charge from
the grid; an output ceiling may hold discharge back when buying is cheaper.

Plans use intervals of up to fifteen minutes, split at price boundaries, for at
most 48 hours within published prices and complete solar coverage. No future
tariffs are fabricated. Beyond that horizon, the planner values stored energy
for forecast demand before solar recovery, capped by usable battery capacity.
If recovery is not covered, a full usable reserve is valued conservatively.
Both planners value this reserve at the lowest published import price, floored
at zero and adjusted for discharge efficiency. Unknown morning prices therefore
do not justify saving the entire battery at the highest known price instead of
serving known evening demand. New published prices inform subsequent plans.
This is a soft terminal value, not a promise
of a particular morning SoC. Unexpected demand and insufficient surplus can make
that reserve unreachable.

## Home and Plans

Home shows the recommended ceilings and the commanded ones for both planned
directions, next change,
expected generation and curtailment totals, and the modeled cost difference. It
links to the **Plans** page for the complete forward-looking view.

Plans separates the forecast into Battery, PV and Prices sections. The PV
section shows forecast versus generated solar after PV limits and totals the
modeled generation and curtailment over the plan. A prominent view switch
exchanges those charts for the full schedule table and remembers the last choice
in the browser. Battery charts show the AC output ceiling and expected discharge when the battery can limit discharge.
The schedule includes both ceilings, expected discharge, household demand and separates forecast
solar, generated solar and curtailed power. Cost difference is modeled over published prices, not
measured savings; plans may end with different stored energy. Forecast source
count, coverage, history sample count and solar margin make the assumptions
visible.
**Planning inputs** lists solar, history, price and battery checks separately.

## Control lifecycle

The background loop runs even when no browser is open. Five minutes before each
price interval ends it recalculates, and at the boundary it publishes the next
interval from that plan; a settings save recalculates and publishes at once, and a failed plan is
retried after a minute. Settings mutations are serialized with publishing,
preventing an old plan from going out after the battery is disabled or removed.

The selected strategy is read on every plan, so switching between Evening
target and HiGHS takes effect at the next plan — a save invalidates the current
one — and the new strategy's command replaces the old one's rather than a
release going out in between. A HiGHS solve runs on a worker thread with a
20-second budget; a settings save **interrupts** a solve in progress rather than
waiting it out, and the next tick plans under the new settings. A solve that
returns no schedule, crashes or overruns is a planning failure like any other.

Each plan publishes its current interval as one `balance` command: the charge
ceiling as `charge_limit_w`, the AC output ceiling as `discharge_limit_w` (null
without discharge limiting), and a validity from the interval's start to its end
plus a minute's grace. An unchanged command is not repeated when the plan is
recalculated inside the same interval; the next interval's command goes out
when it starts.

The loop releases a battery a strategy holds when control is disabled, when the
battery stops being steered or planned, and when planning fails — a plan that
cannot be trusted must not leave the battery capped. A release is `action:
release`, and restoring the battery's normal limits is the automation's job.

There is no readback. A successful publish means the event reached Home
Assistant's bus, not that the inverter applied it; the plan card shows the
**commanded** ceilings, never a reported one. If Home Assistant or the add-on is
stopped, the device keeps whatever the automation last wrote until the
automation's own `valid_until` watchdog — or the inverter's command timeout —
lets go. Neither is installed automatically.

## Verification

Unit tests cover price-driven deferral, insufficient later solar, native
discharge, negative prices, reserve value, energy conservation, device steps,
exhaustive small-case comparison, DST, forecast gaps, household history,
authentication, the command lifecycle and the migration from direct writes. An
integration test runs the production add-on behind its ingress proxy against
mock Energy dashboard, Recorder, prices and event endpoints, including restoring
a limit an earlier version left behind.

Sources: [Home Assistant Energy API implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/energy/websocket_api.py),
[Helios forecast contract](https://github.com/ReikanYsora/Helios-Forecast/blob/main/CONTRACT.md).

Curtailment compatibility errors identify unmatched Energy dashboard counters,
missing inverter ratings and shared forecast providers.
Soft ceilings, nonzero grid targets, minimum limits and fixed-step inverters are
modeled; a stepped setting of 5% means a fixed 5% cap during the episode, not
5% increments. Matching energy counters and separate per-array forecasts are
required even if current PV generation is unrestricted.

A configured EV charging override no longer blocks battery charge-limit control.
Planning assumes ordinary curtailment without future EV override activations;
the live PV controller still applies its configured override. The plan card and
decisions disclose that EV charging is not forecast and the evening target may
not be reached. Historical household demand can already include EV consumption;
no additional predicted EV session is added. Replanning uses updated battery SoC,
but does not guarantee recovery of energy consumed by an unexpected EV session.
