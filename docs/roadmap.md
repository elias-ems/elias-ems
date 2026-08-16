# Roadmap

<!-- Update as items are completed, reprioritized, or added. -->

## V1 (current)

- Battery control (net-zero energy strategy) — deciding, acting and logging
  done, see [features/battery-control.md](features/battery-control.md). Each
  setpoint goes out as an `elias_ems_setpoint` event for an automation to carry
  out, within per-battery charge and discharge power limits. Still to do:
  noticing that nothing acted on a setpoint — no automation, a mistyped key or
  an inverter ignoring it all look identical from here.
- Diagnostics — one log every feature writes to, shown per feature on Home and
  in full on the Tools page, downloadable as a text file. Done for the one
  feature that logs so far; see [features/diagnostics.md](features/diagnostics.md).

## Future

- Dynamic prices (epex)
- PV curtailment when negative prices
- Battery control (negative prices)
- Telemetry cloud / backend service to remotely follow up / offer support
