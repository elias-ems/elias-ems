# Roadmap

<!-- Update as items are completed, reprioritized, or added. -->

## V1 (current)

- Battery control (net-zero energy strategy) — deciding and logging done, see
  [feature-battery-control.md](feature-battery-control.md). Still to do: writing
  the setpoint to the battery, and a per-battery maximum charge/discharge power
  so the strategy can't ask for more than the inverter can deliver.

## Future

- Dynamic prices (epex)
- PV curtailment when negative prices
- Battery control (negative prices)
- Telemetry cloud / backend service to remotely follow up / offer support
