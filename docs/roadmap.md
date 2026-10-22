# Roadmap

<!-- Update as items are completed, reprioritized, or added. -->

## V1 (current)

- Battery control strategies — one registry of strategies that Settings, the
  planning loop, the Planner sandbox and the gym all read
  ([features/strategies.md](features/strategies.md)). Two are registered:
  **Evening target** and **HiGHS cost optimizer**, both selectable in Battery
  control and compared side by side in the sandbox. Net zero energy has been
  removed; installs that had it come back with control switched off. HiGHS plans
  with the modes ticked for the battery (`batteryCapabilities`), so direct
  hold/charge/discharge commands now reach production. Next: a terminal value
  for HiGHS, an adapter that enforces grid permissions against live power,
  folding the older benchmark gym onto the registry, and learned
  strategies trained against `gym/strategies.mjs`.

- Documentation planner sandbox — import a planner export locally in the browser
  and compare every registered strategy on it with adjustable settings and
  capability assumptions, then inspect and download each forecast schedule.
  Historical replay and algorithm changes remain distinct from measured savings.

- Charge-limit optimization — both strategies plan the maximum charging power
  and optional maximum AC output, which reserves battery energy during cheaper
  hours for higher-priced demand. Both limits go out as a `balance` battery
  command for an automation to apply; limits earlier versions wrote directly are
  restored on upgrade. See [charge-limit optimization](features/charge-limit.md).

- Battery control — deciding, acting and logging done, see
  [features/battery-control.md](features/battery-control.md). Every strategy
  publishes one versioned `elias_ems_<battery>_battery_command` event
  per battery — a mode (`balance`, `hold`, `charge`, `discharge`) plus
  boundaries, an optional setpoint, permissions and a validity — for an
  automation to carry out. The four modes are the HiGHS engine's, so enabling
  its direct modes needs no contract change. Still to do: noticing that nothing
  acted on a command — no automation, one listening for a battery's old name,
  or an inverter ignoring it all look identical from here — and a packaged
  adapter that enforces validity and permissions.
- Diagnostics — one log every feature writes to, shown on Home as the acting
  strategies' decisions merged into a single feed, in full on the Tools page,
  and downloadable as a text file. Four origins write to it now — battery
  control, PV curtailment, dynamic prices, and charge limiting — and the feed
  shows the three that decide something, leaving out `prices`, whose entries
  are parse failures rather than anything the house did; see
  [features/diagnostics.md](features/diagnostics.md).
- Dynamic prices — importing done, see
  [features/dynamic-prices.md](features/dynamic-prices.md). Day-ahead prices are
  read off a Home Assistant entity and put through a formula per direction, so
  the add-on knows what a kWh costs and what one earns at each quarter hour.
  PV curtailment is the first thing that acts on them. Still to do: a built-in
  price client, so the feature doesn't depend on an integration the add-on can
  neither install nor verify.
- PV curtailment — deciding, acting and logging done, see
  [features/pv-curtailment.md](features/pv-curtailment.md). While a kWh put on
  the grid earns less than the configured threshold, each curtailable array's
  generation limit goes out as an `elias_ems_<array>_pv_limit` event for an
  automation to carry out. It is what the shared control loop runs now that
  battery control plans in its own, and each tick reads the meter, the arrays,
  the batteries and the price in one snapshot. A battery that is *charging*
  cancels out of the feedback law, which is what gives the battery first
  refusal on a surplus — and, since a **discharging** one hides the shortfall
  that law looks for rather than cancelling out of it, counting it back in is
  what stops the two features holding each other with the arrays pinned and the
  battery emptying to cover them. What happens in the marginal band
  *above* the threshold is now a choice of three strategies — release everything,
  cap each inverter, or allow a price-graded share of export — see
  [Strategies](features/pv-curtailment.md#strategies). How hard an array is
  pressed is a per-inverter choice as well: a `modulating` one follows the house
  every tick, while a `stepped` one — an inverter that commits every write to
  non-volatile memory, a Huawei SUN2000 being the common case — takes one
  command when curtailment starts and one when it ends, held at a limit that was
  typed in rather than computed, see
  [Inverters that cannot be written to often](features/pv-curtailment.md#inverters-that-cannot-be-written-to-often).
  An array generating more than its limit plus a margin is now noticed rather
  than believed: the limit is re-asserted and logged as a warning, which is the
  one place the add-on can currently tell that nothing acted on what it sent. A
  charger following the meter — evcc in solar mode — used to be starved by all
  of this, since curtailment reaches a balanced meter first and then never moves
  again; naming a "a car wants charge" sensor and the charger's power now holds
  the arrays open for it, and brings a stepped inverter up with them when the
  charger outreaches the modulating ones. Still to do: that check only reaches a
  limit that binds — and on a stepped array the re-assertions are capped, past
  which the fault is only logged. An array generating under its limit cannot be
  checked and does not need to be, but a *release* cannot be checked at all — an
  array wrongly left curtailed generates less than it might, and how much it
  might is what nothing here can know.

## Future

- Battery control (negative prices)
- Curtailment for reasons other than price — a grid operator's feed-in cap, or a
  fixed export limit. The same mechanism with a different trigger.
- Telemetry cloud / backend service to remotely follow up / offer support

## Experimental planning engine

HiGHS/WASM, explicit modes and boundaries, permissions, shared physical
comparison, and worker isolation. Selectable in production as the HiGHS cost
optimizer strategy with the battery's own control modes, packaged into the
add-on image beside the add-on. See [Planning engine](features/planning-engine.md).
Adapter acknowledgement, permission enforcement against live power and device
watchdogs remain future work.
