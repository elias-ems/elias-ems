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
- Diagnostics — one log every feature writes to, shown per feature on Home and
  in full on the Tools page, downloadable as a text file. Three origins write to
  it now — battery control, PV curtailment and the price import — the first two
  with a box of their own on Home; see
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
  automation to carry out. It shares the control loop and one snapshot per tick
  with battery control, which is what gives the battery first refusal on a
  surplus. What happens in the marginal band *above* the threshold is now a
  choice of three strategies — release everything, cap each inverter, or allow a
  price-graded share of export — see
  [Strategies](features/pv-curtailment.md#strategies). Still to do: the same gap battery control has — nothing here can tell
  whether an automation acted on a limit, and an inverter that silently ignores
  one looks exactly like one that obeyed.

## Future

- Battery control (negative prices)
- Curtailment for reasons other than price — a grid operator's feed-in cap, or a
  fixed export limit. The same mechanism with a different trigger.
- Telemetry cloud / backend service to remotely follow up / offer support
