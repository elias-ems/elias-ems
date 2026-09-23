# Self-consumption charge-limit optimization

Elias optimizes a battery's **maximum charging power** and optional **maximum AC
output power** while it remains in native self-consumption mode. Reducing output
during cheaper hours preserves energy for higher-priced demand, including the
morning before solar recovery. This is independent of target-power steering.
Elias does not request grid charging or change the operating mode or native SoC
limits. The minimum charge setting (for example 5%) remains the protective floor.

## Setup

In Settings → Batteries, edit the battery:

1. Turn off **Steer this battery**. Set self-consumption on the device itself.
2. Match the capacity, minimum/maximum SoC, and charge/discharge hardware limits
   to the battery's native configuration. Elias does not change its SoC settings.
3. Search for its **Maximum charge limit (W)** entity. The integration must expose
   a `number` entity with W units and valid `min`, `max`, and `step` attributes.
   Names vary: verify which setting limits charging for the installed integration.
4. Optionally select **Maximum AC output power (W)**, a distinct writable
   `number` entity with W units and valid non-negative range and step. It must
   limit battery discharge, not combined PV/inverter output or grid export.
   Leave it empty to retain native discharge. Existing configurations stay empty.
5. Save the battery. Home automatically calculates a preview, even while Battery
   control is disabled or another strategy is selected. Defaults are 95%
   efficiency in each direction, a 20% solar margin, and no wear cost.
6. Under **Battery control**, set the solar margin and wear cost if needed.
   Check the Home plan, then select **Optimize charge limits** and enable Battery
   control to allow writes. Keep native self-consumption enabled on the device.
   Limits update at most once per five minutes; readback runs every 30 seconds.

Existing per-battery Off/Preview/Active selections no longer authorize writes.
Upgrades retain the entity and automatically show a passive preview. Activation
requires the new strategy to be explicitly selected and enabled. Previously
applied limits are recovered through the restoration journal. Battery-specific
margin and wear values remain the fallback until global values are supplied.

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
shows an explicitly **hypothetical preview assuming uncurtailed solar**. Writes
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
appliances, or use Helios-specific confidence bands. A configurable solar margin
provides a conservative planning assumption, not a statistical confidence level.

The pure TypeScript Evening target planner is used for all live previews and
control; the algorithm selector has been removed. Older selections are ignored.
The legacy cost optimizer remains in Benchmark and the offline gym.

The planner starts with maximum charging and minimum controllable discharge to
establish the reachable evening target in nominal and reduced-solar scenarios.
It searches charging and output ceilings using exact energy simulation, exploring
expensive demand first, then improving the charging schedule. It uses up to 41
supported choices per direction and interval, with single-interval and block
moves and four passes. Every move preserves reachable evening energy. Scarce
solar can therefore cause energy to be held even during expensive hours.
Switching costs discourage frequent changes in either direction; equivalent
output choices prefer more headroom for unexpected demand. This is a bounded
local search, not a global optimum. Computation yields between batches.

Charging uses available solar surplus up to the selected ceiling and native
battery room. Discharge serves deficits up to the planned AC output ceiling,
hardware limit and energy above the native SoC floor. Without an output entity,
it follows native limits. The
objective is purchase cost minus export revenue plus the configured wear cost
per charged kWh. Thus charging with solar carries the opportunity cost of the
export revenue forgone. Negative prices do not create permission to charge from
the grid; an output ceiling may hold discharge back when buying is cheaper.

Plans use intervals of up to fifteen minutes, split at price boundaries, for at
most 48 hours within published prices and complete solar coverage. No future
tariffs are fabricated. Beyond that horizon, the planner values stored energy
for forecast demand before solar recovery, capped by usable battery capacity.
If recovery is not covered, a full usable reserve is valued conservatively.
This is a soft terminal value based on available purchase prices, not a promise
of a particular morning SoC. Unexpected demand and insufficient surplus can make
that reserve unreachable.

## Home and Plans

Home shows recommended, requested and reported ceilings for both configured
directions, next change,
expected generation and curtailment totals, and the modeled cost difference. It
links to the **Plans** page for the complete forward-looking view.

Plans separates the forecast into Battery, PV and Prices sections. The PV
section shows forecast versus generated solar after PV limits and totals the
modeled generation and curtailment over the plan. A prominent view switch
exchanges those charts for the full schedule table and remembers the last choice
in the browser. Battery charts show the AC output ceiling and expected discharge when configured.
The schedule includes both ceilings, expected discharge, household demand and separates forecast
solar, generated solar and curtailed power. Cost difference is modeled over published prices, not
measured savings; plans may end with different stored energy. Forecast source
count, coverage, history sample count and solar margin make the assumptions
visible.
The live limit is fetched before planning, so a forecast or source-selection
failure does not falsely mark an available entity unavailable. **Planning inputs**
lists solar, history, price and battery checks separately.

## Control lifecycle

The background loop runs even when no browser is open. It recalculates every five
minutes. Settings mutations are serialized with actuation, preventing an old
plan from writing after the battery is disabled or removed.

Before the first write to each entity, Elias atomically records its original value in
`charge-limit-leases.json`. Each direction has its own recovery record. It restores both values on disable, entity replacement,
removal, or planning failure, and recovers outstanding writes after a restart.
Failed restorations remain recorded and are retried. Direct `number.set_value`
calls are used for these slow limits, unlike the existing frequent target-power
events. Readback is distinct from a successful service response.

An unexpected external value or an unacknowledged command pauses both directions
and releases the other owned limit. A partial write failure restores the owned
limits independently, retaining any failed restoration for retry. Save
the battery settings to resume; Elias preserves a manual value it no longer owns.
If Home Assistant or the add-on is stopped, the device retains its last limit
until restoration is possible. For installations requiring a deadline independent
of Elias, configure a Home Assistant watchdog to restore a chosen normal limit.
No watchdog or device automation is installed automatically.

## Verification

Unit tests cover price-driven deferral, insufficient later solar, native
discharge, negative prices, reserve value, energy conservation, device steps,
exhaustive small-case comparison, DST, forecast gaps, household history,
authentication, and the actuation/restoration lifecycle. An integration test runs
the production add-on behind its ingress proxy against mock Energy dashboard,
Recorder, prices, and writable number endpoints.

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
