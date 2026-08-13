# Roadmap

<!-- Update as items are completed, reprioritized, or added. -->

## V1 (current)

- Battery control (net-zero energy strategy) — deciding and logging done, see
  [features/battery-control.md](features/battery-control.md). Still to do:
  writing the setpoint to the battery, and a per-battery maximum
  charge/discharge power so the strategy can't ask for more than the inverter
  can deliver.
- Diagnostics — one log every feature writes to, shown per feature on Home and
  in full on the Tools page, downloadable as a text file. Done for the one
  feature that logs so far; see [features/diagnostics.md](features/diagnostics.md).

## Future

- Dynamic prices (epex)
- PV curtailment when negative prices
- Battery control (negative prices)
- Telemetry cloud / backend service to remotely follow up / offer support
