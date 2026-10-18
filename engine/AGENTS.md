# Planning engine

`engine/` will contain Elias ems's new battery planning algorithm, using HiGHS
through [highs-js](https://github.com/lovasoa/highs-js) (the `highs` npm package).
Its job is to calculate a plan from battery configuration, current state of
charge, solar and household demand forecasts, and import/export prices. Elias
continues to own data collection, presentation and publishing control events.
Device-specific automations or adapters translate those events into inverter
commands; the engine does not manipulate Home Assistant entities.

The existing production planner is **Evening target**, implemented in
[`charge-evening.ts`](../addon/app/lib/charge-evening.ts). It plans maximum
charging and optional maximum discharge power while the inverter remains in
native self-consumption mode. See [charge-limit optimization](../docs/features/charge-limit.md)
for the current model and [the Planner sandbox](../site/planner.md) for the
browser-based replay of exported planning inputs.

## Goals

- **Calculate a plan without acting on devices.** Keep the engine independent
  of Home Assistant, persistence and UI code. Accept explicit inputs and return
  a schedule and its evaluation, so the same calculation can run in the add-on,
  the browser sandbox and the offline gym.
- **Use HiGHS to optimize price and solar use.** Replace the bespoke search
  with a mathematical optimization model that accounts for import costs,
  export revenue forgone when storing solar, battery losses and configured
  wear cost. We still own and validate the energy model and its assumptions.
- **Plan a mode plus boundaries from the start.** Support all four modes:
  `balance` uses the battery's native balance/self-consumption mode with charge
  and discharge boundaries; `hold`, `charge` and `discharge` use the battery's
  direct-control mode with boundaries. Balance follows live demand and solar;
  hold requests zero battery power; charge and discharge request explicit
  power setpoints within the boundaries. Use positive watts for charging and
  negative watts for discharging. A power ceiling alone is not a direct-control
  setpoint, and zero battery power is not the same as a balanced grid meter.
- **Decouple execution through events.** Following the existing battery target
  and PV curtailment event patterns, have the execution layer publish the active
  interval's mode, boundaries and applicable power setpoint as one coherent
  command. Device automations/adapters own mode selection and entity writes.
  Define a versioned event contract with battery identity, command identity and
  validity period, plus release, restart and expired-plan behavior. Distinguish
  publishing successfully from confirmation that a device applied the command.
  Coordinate ownership so old limit writes and new events cannot control the
  same battery simultaneously; preserve restoration during migration.
- **Produce an inspectable interval schedule.** Respect price boundaries,
  including 15-minute and hourly tariffs. Show the selected mode, power
  boundaries, applicable setpoint, expected charge/discharge and resulting state
  of charge. Keep predicted power distinct from requested control; splitting
  an hourly forecast into smaller intervals does not improve its precision.
- **Compare old and new algorithms side by side in the Planner sandbox.** Run
  the existing Evening target planner and the new engine against the same
  imported snapshot and forecast assumptions. Provide an equivalent-capabilities
  comparison with the new engine restricted to balance plus boundaries, and a
  comparison with its additional modes enabled. Label the available controls
  explicitly so gains from extra capabilities are not attributed solely to a
  better algorithm. Replay each plan using its actual control semantics through
  a shared physical evaluation model. Compare schedules, modeled cost,
  final state of charge and runtime. Explain any
  differences in objectives; a plan ending with less stored energy is not
  automatically better. Keep the existing planner available during evaluation.
- **Optimize cost only.** Minimize mean import charges minus export revenue plus
  configured battery wear over nominal and reduced-solar forecasts. The new
  engine has no evening deadline, SoC target, shortfall penalty or terminal
  reserve value. At equal cost, prefer more time in balance mode without
  relaxing the selected boundaries. Keep physical SoC bounds. The existing Evening target planner
  retains its own deadline and reserve preferences for comparison; do not pass
  those settings to the new engine or change the legacy snapshot format.
- **Respect the physical system and supported controls.** Account for SoC
  bounds, efficiencies, hardware limits, writable power steps and modeled PV
  curtailment. Model supported device modes explicitly; grid charging and battery
  export require explicit permissions. Existing power-limit entities or old
  snapshots do not establish direct-control capability. Validate energy
  conservation and that mode, setpoint and boundaries reproduce the forecast
  behavior, without simultaneous battery charging and discharging. Report
  unsupported inputs, infeasibility and solver limits explicitly; only claim optimality
  when the solver establishes it for the modeled problem.
- **Keep deployment lightweight and calculation responsive.** Use the
  WebAssembly solver without adding a database, queue or Python service. Run
  expensive solving off the UI/server thread and verify browser, Node, amd64
  and aarch64 compatibility before production integration.
