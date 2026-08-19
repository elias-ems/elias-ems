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
  in full on the Tools page, downloadable as a text file. Done for the one
  feature that logs so far; see [features/diagnostics.md](features/diagnostics.md).
- Dynamic prices — importing done, see
  [features/dynamic-prices.md](features/dynamic-prices.md). Day-ahead prices are
  read off a Home Assistant entity and put through a formula per direction, so
  the add-on knows what a kWh costs and what one earns at each quarter hour.
  Nothing acts on them yet. Still to do: a built-in price client, so the feature
  doesn't depend on an integration the add-on can neither install nor verify.

## Future

- PV curtailment when negative prices
- Battery control (negative prices)
- Telemetry cloud / backend service to remotely follow up / offer support
