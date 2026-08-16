# Roadmap

<!-- Update as items are completed, reprioritized, or added. -->

## V1 (current)

- Battery control (net-zero energy strategy) — deciding, writing and logging
  done, see [features/battery-control.md](features/battery-control.md). The
  setpoint now reaches the battery's target power entity, and a per-battery
  maximum charge/discharge power bounds it so the strategy can't ask for more
  than the inverter can deliver. Still to do: a mode entity, since many
  inverters ignore a setpoint until a `select.*` is put into a forced mode and
  returned to self-consumption afterwards — the biggest remaining gap, and the
  most likely reason a correctly written setpoint does nothing.
- Diagnostics — one log every feature writes to, shown per feature on Home and
  in full on the Tools page, downloadable as a text file. Done for the one
  feature that logs so far; see [features/diagnostics.md](features/diagnostics.md).

## Future

- Dynamic prices (epex)
- PV curtailment when negative prices
- Battery control (negative prices)
- Telemetry cloud / backend service to remotely follow up / offer support
