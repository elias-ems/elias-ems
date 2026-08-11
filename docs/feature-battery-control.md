# Battery control

The first EMS feature: a loop that watches the grid meter and works out what the
house battery should be doing to keep it at zero.

**It decides and logs; it does not yet command the battery.** Writing a setpoint
is inverter-specific — Modbus for some, a `number.*` entity or a brand
integration for others — and the decision half is worth having visibly right
before anything is handed the power to act on it. Everything below describes a
loop you can watch and check.

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
entities.

| Field | Type | Notes |
| --- | --- | --- |
| `title` | text | e.g. "Home battery" |
| `capacityKwh` | number | must be above 0 |
| `minChargePercent` | number | 0–100, must be below the maximum |
| `maxChargePercent` | number | 0–100 |
| `energyEntityId` | entity | cumulative energy counter, kWh |
| `powerEntityId` | entity | current power, W — see the sign convention below |
| `socEntityId` | entity | state of charge, % |

**Sign convention: `powerEntityId` is read as positive = charging, negative =
discharging.** This is a decision, not an observation — inverters disagree, and
plenty publish the opposite. It is the convention the strategy's arithmetic and
the log lines are written against, and it will be the one the write path uses.
If your battery reports the other way round, wrap it in a Home Assistant
template sensor that negates it.

`minChargePercent` and `maxChargePercent` bound what control may use, not what
the battery is capable of. Control never discharges below the floor or charges
above the ceiling.

### Battery control — `control.json`

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | |
| `strategy` | `"net-zero-energy"` | the only strategy so far |
| `intervalSeconds` | `5` | 1–3600 |

The strategy is stored as an id rather than a boolean so that the price-aware
strategies on the [roadmap](roadmap.md) are additive: one more entry in
`STRATEGIES` and one more branch in the loop, with nothing already on disk
needing to change.

## The net-zero-energy strategy

In [addon/app/lib/net-zero.ts](../addon/app/lib/net-zero.ts) — a pure function,
no Home Assistant, no clock, no disk, which is what makes the decisions directly
testable in [test/unit/net-zero.test.ts](../addon/test/unit/net-zero.test.ts).

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
   - its state of charge is unreadable — guessing there would mean guessing
     about the one limit that protects the hardware.
5. The remaining batteries share the target **in proportion to their
   `capacityKwh`**. Splitting it evenly would ask a 5 kWh battery for as much as
   the 20 kWh one standing next to it.

Each decision reports the energy headroom next to the setpoint —
`capacityKwh × (max - soc) / 100` charging, `× (soc - min) / 100` discharging —
because "charge at 3 kW" is much easier to sanity-check beside "0.4 kWh of room
left".

There is no per-battery power limit yet, so the strategy can ask for more than
the inverter can deliver. That matters once something acts on the number; see
[Not done yet](#not-done-yet).

## The loop

In [addon/app/lib/control-loop.server.ts](../addon/app/lib/control-loop.server.ts).

- One interval in the add-on's Node process. Module-level state is the right
  shape for it: the server build is loaded once per process, so "one loop per
  add-on" and "one module instance" are the same statement.
- **Started at boot** from
  [addon/app/entry.server.tsx](../addon/app/entry.server.tsx), which is the only
  module the framework loads exactly once when the server starts. Deliberately
  *not* started from a loader: an EMS that only runs while somebody has the Home
  Assistant panel open is not managing anything.
- Saving the control form calls `syncControlLoop()` again, so ticking the box
  takes effect immediately rather than at the next restart — waiting for one
  would be indistinguishable from the feature not working.
- Each tick reads the grid and battery entities in one round of parallel
  requests, runs the strategy, and appends **one** entry to the log.
- A tick that is still waiting on Home Assistant blocks the next one from
  starting rather than letting them pile up. The interval can be as short as a
  second and an unreachable HA takes far longer than that to give up.
- A tick that throws logs an `error` entry and the loop keeps its schedule. A
  loop that dies on the first outage is worse than no loop, because from the
  outside it still looks like it is working.

## The debug box

The expandable **Debug log** on the home page. It shows whether the loop is
running, the strategy and interval, and the log newest-first.

While it is open it polls `GET /api/control-log`
([addon/app/routes/api.control-log.tsx](../addon/app/routes/api.control-log.tsx))
every two seconds. That route touches nothing but memory — separate from the
home loader on purpose, since that one reads every configured entity, which is
far too much work to repeat every couple of seconds, and its ten-second cadence
is far too slow to watch a five-second loop with. Closed, the box costs nothing.

A tick looks like this:

```
22:50:57 Grid net +842 W (importing), batteries at 0 W → discharge 842 W total.
         Home battery: discharge at 561 W (SoC 76%, 6.6 kWh to 10%)
         Garage battery: discharge at 281 W (SoC 76%, 2.8 kWh to 20%)
```

The whole tick is **one** entry rather than one per line. Identical consecutive
entries collapse into a `×N` repeat count, and a house that isn't doing anything
produces the same lines every few seconds — logged separately they interleave, so
the collapsing would never see two identical entries in a row and the buffer
would fill with near-duplicates instead of holding useful history.

The log is an in-memory ring buffer of the last 300 entries
([control-log.server.ts](../addon/app/lib/control-log.server.ts)) and is
**deliberately not persisted**. At a five-second interval it produces thousands
of lines an hour, and writing those into `/data` would buy nothing but wear on
whatever the Home Assistant box boots from. An empty log after a restart is
intended.

## How it's stored

[store.server.ts](../addon/app/lib/store.server.ts) holds the shared JSON
persistence: `readJson`/`writeJson`, plus `createJsonCollection` for the
id-addressed lists (PV entities and batteries). Each concern is split into a pure
model module and a `.server` module that reads and writes it:

| Concern | Model (pure, shared with the browser) | Persistence |
| --- | --- | --- |
| Grid | `grid.ts` | `grid.server.ts` |
| Batteries | `batteries.ts` | `batteries.server.ts` |
| Control config, log entries, loop status | `control.ts` | `control-config.server.ts`, `control-log.server.ts` |
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
| `test/unit/net-zero.test.ts` | the strategy: both directions, the deadband on both sides of zero, the feedback term, SoC limits, an unreadable sensor, the proportional split |
| `test/unit/settings-model.test.ts` | validation and normalization for grid, batteries and control config |
| `test/unit/settings-store.test.ts` | persistence round trips, and reading a hand-edited file |
| `test/unit/control-loop.test.ts` | scheduling, on a fake clock: starts only when enabled, ticks immediately then on the interval, picks up a changed interval, leaves an unchanged loop alone, survives an outage |
| `test/unit/routes.test.ts` | the home loader's shape, entity deduplication, every settings intent, `/api/control-log` |
| `test/integration/ingress.test.ts` | the loop running inside the real `server.js`, reached over HTTP through the ingress proxy |
| `test/integration/control-loop-boot.test.ts` | that a restart with control already enabled has the loop running before anything asks it to — the one thing no other suite can show, since they all start it themselves |
| `test/e2e/app.spec.ts` | configuring it in a browser, enabling it, and watching the debug box fill |

The loop tests need one non-obvious thing: a fake clock can move the interval
along, but it cannot make real I/O land. `pendingControlTick()` exposes the tick
currently in flight so a test can wait for it.

## Not done yet

- **Writing the setpoint to the battery.** The one thing that makes this control
  rather than observation. Per-brand.
- **A per-battery maximum charge and discharge power**, so the strategy cannot
  ask for more than the inverter can deliver. Needed before the write path.
- **Price awareness** — dynamic prices, negative-price strategies and PV
  curtailment are separate [roadmap](roadmap.md) items.
- **Persisting decisions** for after-the-fact analysis. That wants its own store
  and a retention policy, not this ring buffer made durable.
