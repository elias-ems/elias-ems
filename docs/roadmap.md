# Roadmap

<!-- Update as items are completed, reprioritized, or added. -->

## V1 (current)

- Battery control (net-zero energy strategy) — deciding, acting and logging
  done, see [features/battery-control.md](features/battery-control.md). Each
  target goes out as an `elias_ems_<battery>_target_power` event for an automation
  to carry out, within per-battery charge and discharge power limits. Still to
  do: noticing that nothing acted on a target — no automation, one listening
  for a battery's old name, or an inverter ignoring it all look identical from
  here.
- Diagnostics — one log every feature writes to, shown on Home as the two
  strategies' decisions merged into a single feed, in full on the Tools page,
  and downloadable as a text file. Three origins write to it now — battery
  control, PV curtailment and the price import — the first two being the pair
  that feed shows; see [features/diagnostics.md](features/diagnostics.md).
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
  automation to carry out. It shares the control loop and one snapshot per tick
  with battery control, which is what gives the battery first refusal on a
  surplus — and, since a battery **discharging** hides the shortfall the
  feedback law looks for rather than cancelling out of it the way a charging one
  does, what stops the two features holding each other with the arrays pinned
  and the battery emptying to cover them. What happens in the marginal band
  *above* the threshold is now a choice of three strategies — release everything,
  cap each inverter, or allow a price-graded share of export — see
  [Strategies](features/pv-curtailment.md#strategies). An array generating more
  than its limit plus a margin is now noticed rather than believed: the limit is
  re-asserted and logged as a warning, which is the one place the add-on can
  currently tell that nothing acted on what it sent. A charger following the
  meter — evcc in solar mode — used to be starved by all of this, since
  curtailment reaches a balanced meter first and then never moves again; naming
  a "a car wants charge" sensor and the charger's power now holds the arrays
  open for it, and brings a stepped inverter up with them when the charger
  outreaches the modulating ones. Still to do: that check only
  reaches a limit that binds. An array generating under its limit cannot be
  checked and does not need to be, but a *release* cannot be checked at all — an
  array wrongly left curtailed generates less than it might, and how much it
  might is what nothing here can know.

## Future

- Battery control (negative prices)
- Curtailment for reasons other than price — a grid operator's feed-in cap, or a
  fixed export limit. The same mechanism with a different trigger.
- Telemetry cloud / backend service to remotely follow up / offer support
