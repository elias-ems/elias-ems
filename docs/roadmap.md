# Roadmap

<!-- Update as items are completed, reprioritized, or added. -->

## V1 (current)

- Battery control (net-zero energy strategy) — deciding, writing and logging
  done, including the per-battery maximum charge/discharge power that stops the
  strategy asking for more than the inverter can deliver. See
  [features/battery-control.md](features/battery-control.md). Still to do: a
  mode entity, since plenty of inverters ignore a setpoint until a `select.*`
  is put into a forced mode — that and the smaller gaps behind it are listed
  under [Not done yet](features/battery-control.md#not-done-yet).
- Diagnostics — one log every feature writes to, shown per feature on Home and
  in full on the Tools page, downloadable as a text file. Done for the one
  feature that logs so far; see [features/diagnostics.md](features/diagnostics.md).

## Future

- Dynamic prices (epex)
- PV curtailment when negative prices
- Battery control (negative prices)
- Telemetry cloud / backend service to remotely follow up / offer support
