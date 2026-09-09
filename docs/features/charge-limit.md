# Self-consumption charge-limit optimization

Elias can optimize a battery's **maximum charging power** while the battery
remains in its native self-consumption mode. This is independent of target-power
steering. Elias never requests charging from the grid, changes the operating
mode, or withholds automatic discharge through this feature.

## Setup

In Settings → Batteries, edit the battery:

1. Turn off **Steer this battery**. Set self-consumption on the device itself.
2. Match the capacity, minimum/maximum SoC, and charge/discharge hardware limits
   to the battery's native configuration. Elias does not change its SoC settings.
3. Search for its **Maximum charge limit (W)** entity. The integration must expose
   a `number` entity with W units and valid `min`, `max`, and `step` attributes.
   Names vary: verify which setting limits charging for the installed integration.
4. Select **Preview** to calculate without writing. Defaults are 95% efficiency
   in each direction, a 20% reduction of predicted solar, and no wear cost.
5. Check the Home plan against observed self-consumption, then select **Active**
   to allow Elias to update that number entity. Updates are at most once per
   five minutes; current settings are checked every 30 seconds.

Dynamic consumption and production price formulas must be configured. In Home
Assistant's Energy dashboard, configure the grid, battery charge/discharge
energy counters, and a forecast for every solar source. Three complete samples
of every hour of the day are required within the last fourteen days.

The initial implementation supports one configured household battery. Elias PV
curtailment must be disabled: a forecast of uncurtailed generation cannot yet be
combined with the existing curtailment strategies. Other external battery or PV
controllers must not change the behavior assumed by the model.

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

The pure TypeScript planner uses backward dynamic programming with 241 energy
states and at most 25 candidate charging limits per interval. Energy costs are
interpolated between states; the resulting policy is replayed with exact energy
accounting. This is a numerical approximation, not a guarantee of a global optimum.
Device limits are rounded down to their supported steps. Computation yields
between batches so the server can process live readings.

Charging uses available solar surplus up to the selected ceiling and native
battery room. Discharge automatically serves deficits up to native limits. The
objective is purchase cost minus export revenue plus the configured wear cost
per charged kWh. Thus charging with solar carries the opportunity cost of the
export revenue forgone. Negative prices do not create permission to charge from
the grid or to prevent native discharge.

Plans use intervals of up to fifteen minutes, split at price boundaries, for at
most 48 hours within published prices and complete solar coverage. No future
tariffs are fabricated. Beyond that horizon, the planner values stored energy
for forecast demand before solar recovery, capped by usable battery capacity.
If recovery is not covered, a full usable reserve is valued conservatively.
This is a soft terminal value based on available purchase prices, not a promise
of a particular morning SoC. Native discharge and insufficient surplus can make
that reserve unreachable.

## Home

Home shows the recommended ceiling, requested and reported limits, next change,
expected charging, planned versus unrestricted SoC, and purchase/export prices.
The expandable schedule includes solar and household demand. Cost difference is
modeled over published prices, not measured savings; plans may end with different
stored energy. Forecast source count, coverage, history sample count, and solar
margin make the assumptions visible.

## Control lifecycle

The background loop runs even when no browser is open. It recalculates every five
minutes. Settings mutations are serialized with actuation, preventing an old
plan from writing after the battery is disabled or removed.

Before the first write, Elias atomically records the original value in
`charge-limit-leases.json`. It restores that value on disable, entity replacement,
removal, or planning failure, and recovers outstanding writes after a restart.
Failed restorations remain recorded and are retried. Direct `number.set_value`
calls are used for this slow limit, unlike the existing frequent target-power
events. Readback is distinct from a successful service response.

An unexpected external value or an unacknowledged command pauses control. Save
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
