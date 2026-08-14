# Battery control

The first EMS feature: a loop that watches the grid meter and works out what the
house battery should be doing to keep it at zero.

**It decides and logs; it does not yet command the battery.** The battery
configuration now names the entity a setpoint would be written to, and the
strategy respects that entity's power limits — but nothing is written to it yet.
The decision half is worth having visibly right before anything is handed the
power to act on it. Everything below describes a loop you can watch and check.

Tracked in [issue #4](https://github.com/elias-ems/elias-ems/issues/4).

## What you configure

All of it lives on the **Settings** page, and all of it is stored as JSON under
the add-on's data directory (`/data` in Home Assistant, `addon/data/` in local
development).

### Grid — `grid.json`

One Home Assistant entity, **instantaneous power in W, signed**:

| Field | Label in the UI | Meaning |
| --- | --- | --- |
| `powerEntityId` | Power | net grid exchange: **positive importing, negative exporting** |

That signed number *is* the net exchange every strategy works from — there is no
arithmetic between the sensor and the decision.

One sensor rather than an import/export pair, because that is what the common
meters publish: P1/DSMR readers, Shelly EM and friends, and most hybrid inverters
all expose a single signed power sensor. Home Assistant's energy dashboard wants
the unsigned pair instead, so an installation set up for that has two sensors and
no signed one; subtracting export from import in a template sensor gives it one,
and that is what to point this at.

### Batteries — `batteries.json`

One or more. Capacity and the charge window are things the installer knows and
Home Assistant does not, so they are typed in; the three live values are
entities, and a fourth — the target — is the writable one.

| Field | Type | Notes |
| --- | --- | --- |
| `title` | text | e.g. "Home battery" |
| `capacityKwh` | number | must be above 0 |
| `minChargePercent` | number | 0–100, must be below the maximum |
| `maxChargePercent` | number | 0–100 |
| `energyEntityId` | entity | cumulative energy counter, kWh |
| `powerEntityId` | entity | current power, W — see the sign convention below |
| `socEntityId` | entity | state of charge, % |
| `targetPowerEntityId` | entity | **optional** — the writable entity the setpoint goes to |
| `maxChargePowerW` | number | **optional** — cap on charge power, W |
| `maxDischargePowerW` | number | **optional** — cap on discharge power, W, as a positive number |

**Sign convention: both power fields are read as positive = charging, negative =
discharging.** This is a decision, not an observation — inverters disagree, and
plenty publish the opposite. It is the convention the strategy's arithmetic and
the log lines are written against, and it will be the one the write path uses.
If your battery reports the other way round, wrap it in a Home Assistant
template sensor that negates it.

`minChargePercent` and `maxChargePercent` bound what control may use, not what
the battery is capable of. Control never discharges below the floor or charges
above the ceiling.

#### The target power entity

`targetPowerEntityId` is where the setpoint gets written, and it is what turns a
battery from something watched into something steered. Leaving it empty is a
supported state, not an unfinished one: the battery still takes part in every
decision and every log line, and nothing will be written to it. Every record
saved before this field existed reads as empty, so no existing installation
starts being steered by an upgrade.

It wants a **writable** entity, which in practice means one of two things:

- a **`number.*`** from an inverter integration — `huawei_solar`,
  `solaredge_modbus_multi`, Victron, and friends all publish one;
- an **`input_number.*`** helper that a Home Assistant automation forwards to
  the device, which is how a plain Modbus setup does it. Home Assistant's
  built-in `modbus` integration has **no `number` platform** — it offers
  `climate`, `cover`, `switch`, `light`, `fan`, `sensor` and `binary_sensor`
  only — so writing a register means calling `modbus.write_register` from an
  automation, and the `input_number` is the thing to point this field at.

There is deliberately no mode/`select` entity here yet, and no split
charge/discharge pair. Plenty of inverters need the mode set to something like
"forced" before a setpoint is honoured; that is real, and it is the next shape
this configuration will have to grow. See [Not done yet](#not-done-yet).

#### Power limits

`maxChargePowerW` and `maxDischargePowerW` cap what the strategy may ask a
battery for, so the proportional split cannot request more than the inverter can
deliver. Both are **positive magnitudes** — "5000", not "-5000" for discharge —
and the sign is applied where it is used.

Both are optional, because the target entity usually already knows. `number`
entities are required by their platform to publish `min` and `max`, and
`input_number` helpers publish them too, so when the fields are left empty the
entity's own range is read instead: `max` becomes the charge limit and `-min`
the discharge limit.

**A configured value overrides the entity's range rather than narrowing it.**
That direction matters. An `input_number` created through the Home Assistant UI
defaults to a 0–100 range, which as a power limit would cap a 5 kW battery at
100 W — so the override has to be able to say "no, it's 5000" and be believed.
Taking the tighter of the two would make that unfixable without editing the
helper.

A range that cannot express a direction caps it at **0**, and a battery with a
limit of 0 drops out of the plan the same way one at its SoC ceiling does, with
`discharge power limited to 0 W` as the reason. `min: 0` on a signed setpoint
entity genuinely means negative values are not writable — but it is also exactly
what that mis-created helper looks like, and a battery visibly sitting out with
that reason is a far better symptom than a setpoint being silently written out
of range.

### Battery control — `control.json`

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | |
| `strategy` | `"net-zero-energy"` | the only strategy so far |
| `intervalSeconds` | `5` | 1–3600. A floor between ticks, not a schedule — see [The loop](#the-loop). |

The strategy is stored as an id rather than a boolean so that the price-aware
strategies on the [roadmap](../roadmap.md) are additive: one more entry in
`STRATEGIES` and one more branch in the loop, with nothing already on disk
needing to change.

## The net-zero-energy strategy

In [addon/app/lib/net-zero.ts](../../addon/app/lib/net-zero.ts) — a pure function,
no Home Assistant, no clock, no disk, which is what makes the decisions directly
testable in [test/unit/net-zero.test.ts](../../addon/test/unit/net-zero.test.ts).

### Why the batteries' own power is an input

The obvious rule — "importing 800 W, so discharge 800 W" — is wrong as soon as
the battery is already doing something, because the grid reading *already
includes* the battery:

```
net = load - pv + batteryPower
```

so the setpoint that drives `net` to zero is:

```
targetBatteryPower = currentBatteryPower - net
```

A battery discharging at 800 W while the meter reads zero is *already* doing
exactly the right thing. The naive rule would tell it to stop and create an
800 W import in the process. This form tells it to carry on — a different answer
to the same reading, and the correct one.

### The rules

1. `net` is the grid power sensor, read as-is.
2. If `|net| < 25 W` the meter counts as balanced: hold everything where it is.
   Chasing meter noise would only cycle the battery.
3. Otherwise `target = currentBatteryPower - net`; positive means charge,
   negative means discharge.
4. A battery drops out of the plan when it cannot help in that direction:
   - at or above `maxChargePercent` and the target is to charge;
   - at or below `minChargePercent` and the target is to discharge;
   - its power limit in that direction is 0 — see
     [Power limits](#power-limits);
   - its state of charge is unreadable — guessing there would mean guessing
     about the one limit that protects the hardware.
5. The remaining batteries share the target **in proportion to their
   `capacityKwh`**. Splitting it evenly would ask a 5 kWh battery for as much as
   the 20 kWh one standing next to it.
6. Each share is then capped at that battery's charge or discharge power limit.
   The cap comes last, after the split: it is a fact about the inverter, not
   about how the target should be divided.

Each decision reports the energy headroom next to the setpoint —
`capacityKwh × (max - soc) / 100` charging, `× (soc - min) / 100` discharging —
because "charge at 3 kW" is much easier to sanity-check beside "0.4 kWh of room
left". A capped decision also says what it was capped from, since a plan quietly
delivering less than the meter needs otherwise reads exactly like one that is on
target.

**What a cap holds back is not redistributed to the other batteries in the same
tick.** It doesn't need to be: whatever goes undelivered keeps the meter off
zero, so the next tick's `currentBatteryPower - net` asks for it again, and the
batteries with headroom take it up over a few ticks. The feedback term is what
makes the simpler per-battery cap correct rather than merely cheaper.

## The loop

In [addon/app/lib/control-loop.server.ts](../../addon/app/lib/control-loop.server.ts).

- Module-level state, for the same reason as the subscription it reads from: the
  server build is loaded once per process, so "one loop per add-on" and "one
  module instance" are the same statement.
- **Home Assistant decides when there is something to decide about.** The loop
  subscribes to the live cache
  ([live-readings.md](live-readings.md)) and ticks when one of
  *its* entities changes — the grid sensor, or a battery's SoC or power. A meter
  that swings is acted on in the time it takes the event to arrive, rather than
  up to a full interval later.
- `intervalSeconds` is now a **rate limit**, not a schedule: at most one tick per
  interval, leading edge. Changes arriving inside that window schedule one tick
  for when it closes, so the last change before a lull is never the one that gets
  swallowed — a decision standing on a reading nobody looked at again is exactly
  the failure worth avoiding.
- A **60s idle tick** runs regardless. A quiet house produces no events and would
  otherwise produce no ticks, which from outside is indistinguishable from a loop
  that has died. It reads memory and costs nothing.
- **Started at boot** from
  [addon/app/entry.server.tsx](../../addon/app/entry.server.tsx), which is the only
  module the framework loads exactly once when the server starts. Deliberately
  *not* started from a loader: an EMS that only runs while somebody has the Home
  Assistant panel open is not managing anything.
- Saving the control form calls `syncControlLoop()` again, so ticking the box
  takes effect immediately rather than at the next restart — waiting for one
  would be indistinguishable from the feature not working.
- Each tick reads its entities through
  [states.server.ts](../../addon/app/lib/states.server.ts) — from the live cache,
  with no round trip at all, or over REST when the subscription isn't up — runs
  the strategy, and appends **one** entry to the log.
- **Ages are advisory.** The log line names its source and the age of the oldest
  reading it used, and then decides anyway. Nothing refuses to act on an old
  number, because a sensor holding a steady value emits no events and would look
  identical to a broken one; `unavailable` and `unknown` remain the only states
  that stop a decision. That makes the log, and the health chip on the home page,
  the things a stuck sensor actually shows up in.
- A Home Assistant that cannot be reached at all is different, and still raises:
  one `Tick failed` line rather than a stream of ticks that read like an idle
  house when the truth is that nobody asked it anything.
- A tick that is still waiting on Home Assistant blocks the next one from
  starting rather than letting them pile up. The interval can be as short as a
  second and an unreachable HA takes far longer than that to give up.
- A tick that throws logs an `error` entry and the loop keeps its schedule. A
  loop that dies on the first outage is worse than no loop, because from the
  outside it still looks like it is working.

## Watching it decide

Every line the loop produces goes to **diagnostics** under the
`battery-control` origin — see [diagnostics.md](diagnostics.md) for the entry
shape, the buffer and the download. Two places show it: the collapsed
**Diagnostics** box under Battery control on the home page, filtered to this
origin, and the **Tools** page, where it is merged with every other feature's.

A tick looks like this:

```
22:50:57 Grid net +842 W (importing), batteries at 0 W → discharge 842 W total. (via live cache, oldest reading 3s)
         Home battery: discharge at 561 W (SoC 76%, 6.6 kWh to 10%)
         Garage battery: discharge at 281 W (SoC 76%, 2.8 kWh to 20%)
```

The clause in brackets is the provenance: which source the numbers came from and
how old the oldest of them was. Since nothing refuses to act on an old reading,
this line is where a sensor that quietly stopped reporting becomes visible.

The whole tick is **one** entry rather than one per line. Identical consecutive
entries collapse into a `×N` repeat count, and a house that isn't doing anything
produces the same lines every few seconds — logged separately they interleave, so
the collapsing would never see two identical entries in a row and the buffer
would fill with near-duplicates instead of holding useful history.

The buffer holds the last 300 of this feature's entries and is **deliberately
not persisted**: at a five-second interval the loop produces thousands of lines
an hour, and an empty log after a restart is intended. Download it from Tools if
a particular stretch is worth keeping.

## How it's stored

[store.server.ts](../../addon/app/lib/store.server.ts) holds the shared JSON
persistence: `readJson`/`writeJson`, plus `createJsonCollection` for the
id-addressed lists (PV entities and batteries). Each concern is split into a pure
model module and a `.server` module that reads and writes it:

| Concern | Model (pure, shared with the browser) | Persistence |
| --- | --- | --- |
| Grid | `grid.ts` | `grid.server.ts` |
| Batteries | `batteries.ts` | `batteries.server.ts` |
| Control config and loop status | `control.ts` | `control-config.server.ts` |
| PV entities | `pv-entities.ts` | `pv-entities.server.ts` |

The split is what lets the settings UI share the types, the validation, and
constants like `STRATEGIES` without pulling a server-only module into the client
bundle. The `normalize*` functions in the model modules are where a field added
later is given something sensible to be for records already on disk, and where
numbers that a hand-edited file left as strings get coerced back — a string where
a number belongs would turn the strategy's arithmetic into silent string
concatenation.

## Tests

| Suite | What it covers |
| --- | --- |
| `test/unit/net-zero.test.ts` | the strategy: both directions, the deadband on both sides of zero, the feedback term, SoC limits, an unreadable sensor, the proportional split, and the power caps — each direction independently, and a battery limited to 0 W leaving the split to the others |
| `test/unit/settings-model.test.ts` | validation and normalization for grid, batteries and control config, including `resolvePowerLimits` and a battery record saved before the control fields existed |
| `test/unit/settings-store.test.ts` | persistence round trips, and reading a hand-edited file |
| `test/unit/control-loop.test.ts` | scheduling: starts only when enabled, ticks at once when switched on, ticks when a watched reading moves, ignores entities it doesn't use, holds its rate limit under a burst without losing the last change, keeps ticking when the house is quiet, picks up a changed interval, survives an outage, names the source and age of what it read, and files its lines under the right origin. Also that a target entity's own range reaches the strategy, and that a configured cap overrides it rather than narrowing it |
| `test/unit/routes.test.ts` | the home loader's shape, entity deduplication, every settings intent |
| `test/integration/ingress.test.ts` | the loop running inside the real `server.js`, reached over HTTP through the ingress proxy |
| `test/integration/control-loop-boot.test.ts` | that a restart with control already enabled has the loop running before anything asks it to — the one thing no other suite can show, since they all start it themselves. What it reads is the diagnostics entry `syncControlLoop()` writes when it starts an interval: nothing in that process has posted the settings form, so only the boot-time call can have produced it |
| `test/e2e/app.spec.ts` | configuring it in a browser, enabling it, and watching the diagnostics box fill |

The loop tests run on two clocks on purpose. The event-driven cases use the real
one, because they turn on a WebSocket message arriving and no fake timer can
hurry real I/O along; the cases about elapsed time use fake timers with the
subscription pointed somewhere unreachable, so the loop is on its REST path and
nothing is waiting on a socket. Either way `pendingControlTick()` exposes the
tick currently in flight, since advancing a clock only *starts* one.

## Not done yet

- **Writing the setpoint to the battery.** The one thing that makes this control
  rather than observation. The target entity is now configured and the setpoint
  is bounded by what the inverter can take, so what is left is the write itself:
  a `number.set_value` service call through the Supervisor proxy, a deadband so
  a five-second loop is not writing thousands of times an hour, and reading the
  entity back to notice when a write did not land.
- **A mode entity.** Many inverters ignore a setpoint until a `select.*` is put
  into a forced or manual mode, and want it returned to self-consumption
  afterwards. That is a second field and a lifecycle, not just another write.
- **Reverting on stop.** Nothing yet guarantees a battery is handed back to its
  own logic when control is disabled, the add-on is stopped, or the container
  dies. A battery left forcing 5 kW because the process that told it to is gone
  is the worst failure this feature has, and it has to be solved before the
  write path ships.
- **Redistributing what a power cap holds back** within a single tick, rather
  than letting the feedback term converge on it over several. Worth doing if the
  convergence turns out to be visible in practice.
- **Price awareness** — dynamic prices, negative-price strategies and PV
  curtailment are separate [roadmap](../roadmap.md) items.
- **Persisting decisions** for after-the-fact analysis. That wants its own store
  and a retention policy, not the [diagnostics](diagnostics.md) buffer made
  durable.
