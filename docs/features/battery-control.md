# Battery control

The first EMS feature: a loop that watches the grid meter and works out what the
house battery should be doing to keep it at zero.

**It decides, writes, and logs.** Each tick works out what every battery should
be doing, writes that to the battery's target power entity, and records both the
decision and what was written. What it cannot yet do is put an inverter into the
mode that makes it *listen* — see [Not done yet](#not-done-yet).

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
supported state, not an unfinished one — but it has consequences, described
under [Batteries that cannot be steered](#batteries-that-cannot-be-steered)
below. Every record saved before this field existed reads as empty, so no
existing installation starts being steered by an upgrade.

**Battery control cannot be enabled until at least one battery has one.** The
checkbox on the Settings page is disabled until then, and the action rejects the
save even if the form is posted directly — a target can be cleared after control
was switched on, so the server cannot trust the form to have been rendered in
the current state. Switching control *off* is always allowed, which is the way
out of that state.

The rule is "at least one", not "all": a house can reasonably have one steerable
battery and one that only reports. What it cannot have is control enabled with
nothing to write to, because a loop that decides correctly and changes nothing
looks exactly like a loop that is broken.

It wants a **writable** entity, which in practice means one of two things:

- a **`number.*`** from an inverter integration — `huawei_solar`,
  `solaredge_modbus_multi`, Victron, and friends all publish one;
- an **`input_number.*`** helper that a Home Assistant automation forwards to
  the device, which is how a plain Modbus setup does it. Home Assistant's
  built-in `modbus` integration has **no `number` platform** — it offers
  `climate`, `cover`, `switch`, `light`, `fan`, `sensor` and `binary_sensor`
  only — so writing a register means calling `modbus.write_register` from an
  automation, and the `input_number` is the thing to point this field at.

The loop reads it every tick for its `min`/`max`, but it is **not** one of the
entities whose changes provoke a tick, and it is left out of the "oldest
reading" the log stamps each decision with. A target is an output: once the
write path exists, watching it would mean every setpoint we write comes back as
a change, provokes another tick, and is written again, with nothing damping the
loop. And being a setpoint rather than a sensor, it can sit untouched for hours
without anything being wrong — which would make it permanently the oldest thing
the loop had read, and that clause is there to expose a stuck *sensor*.

Those two are what the field's autocomplete suggests, via the `domains`
parameter on [`/api/entities`](../../addon/app/routes/api.entities.tsx); every
other field asks that route for `sensor` and gets the old behaviour. The field
still accepts anything typed into it by hand, which is the escape hatch for a
setup whose control surface is some other domain entirely.

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

### Batteries that cannot be steered

A battery with no target power entity is left out of the plan: it keeps doing
whatever it was doing, and gets a decision line saying so rather than a
setpoint. The less obvious half is that it must also be left out of
`currentBatteryPower`. Writing `C` for the steerable batteries' combined power
and `U` for the unsteerable ones':

```
net = load - pv + C + U
```

The unsteerable ones stay at `U`, so the setpoint that zeroes the meter comes
from `load - pv + S + U = 0`, which reduces to:

```
S = C - net
```

`U` cancels out entirely. Counting it into `currentBatteryPower` would ask the
steerable batteries to cover what the unsteerable ones are *already* covering,
and the meter would overshoot by exactly `U` — a house importing 200 W with an
unsteered battery already discharging 800 W would end up exporting 800 W.

A corollary: an unreadable power sensor on an unsteered battery costs the answer
nothing, so unlike a steerable battery's missing reading it produces no warning.

### The rules

1. `net` is the grid power sensor, read as-is.
2. If `|net| < 25 W` the meter counts as balanced: hold everything where it is.
   Chasing meter noise would only cycle the battery.
3. Otherwise `target = currentBatteryPower - net`, over the **steerable**
   batteries only; positive means charge, negative means discharge.
4. A battery drops out of the plan when it cannot help in that direction:
   - it has no target power entity, so nothing can be written to it. Unlike the
     cases below it holds at its *current* power rather than at 0 — those are a
     decision to stop, this is the absence of any decision at all;
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

## Writing the setpoint

In [addon/app/lib/setpoints.server.ts](../../addon/app/lib/setpoints.server.ts),
kept apart from the strategy (which stays pure) and from the loop (which is
about *when* to decide). What arrives is a number in watts with the sign
convention already applied; what leaves is a Home Assistant service call.

### What gets written, which is not the setpoint

Each decision carries a `commandW` alongside its `setpointW`, and they are
deliberately different things:

| Decision | `setpointW` | `commandW` |
| --- | --- | --- |
| charge / discharge | the share, capped | the same |
| at an SoC or power limit | 0 | **0** — an active stop |
| inside the grid deadband | the battery's *measured* power | **null** — write nothing |
| grid sensor unreadable | measured power | **0** for steerable batteries |
| no target entity | measured power | null |

The deadband row is the one worth explaining. A hold reports the battery's
measured power, which is the right thing to *display* and the wrong thing to
*command*: writing a measurement back as a setpoint would let sensor noise walk
the commanded value around tick after tick, on a house that is already balanced.
So a deadband hold writes nothing and the previous setpoint stands.

The unreadable-grid row goes the other way. That is the blind case, and a
battery left forcing kilowatts because the meter it was following broke is the
one hold that must not persist. An unreachable Home Assistant never gets this
far — the tick fails first — so a null reading here means a genuinely broken
sensor.

### Which service

From the target entity's own domain: `number.set_value` for a `number`,
`input_number.set_value` for an `input_number`, both taking
`{ entity_id, value }`. Any other domain is refused rather than guessed at —
this writes to hardware, and a service name invented from an entity id is
exactly the guess that should fail loudly and change nothing.

### The write deadband

A write only happens when the entity's current value differs from what we want
by at least **50 W**. The loop can tick every second and a house is never still,
so a strategy recalculating a few watts lower each time would otherwise produce a
service call every tick — thousands an hour, against hardware that on some brands
commits setpoints to flash.

Comparing against **what the entity reads now**, rather than against what we last
sent, is what makes this self-correcting and stateless: something else moving the
entity shows up as a difference on the next tick and gets written back, with
nothing remembered in between. Values are rounded to the entity's own `step`
first, so a device that quantises 582 W to 600 W and reports that back doesn't
leave a permanent gap between what we asked for and what we read.

A failed write is one battery not doing as it was told: it is logged, the other
batteries are still written, and the next tick tries again. It is never allowed
to end the loop.

### Letting go

`releaseBatteries()` commands 0 to every steerable battery, and runs when control
is switched off and on `SIGTERM`/`SIGINT`. A battery left forcing kilowatts
because the thing that told it to is gone is the worst failure this feature has —
from the battery's side there is no difference between a setpoint that is still
wanted and one whose author died ten minutes ago.

Two honest limits. Zero is the **safe** value, not necessarily the *correct*
one: it stops the battery being driven either way, which is safe on every
inverter, but handing it back to its own self-consumption logic means restoring a
mode on many brands. And nothing here survives `kill -9`, a power cut, or a
container the supervisor destroys without asking. The only real answer to those
is an inverter whose forced mode expires on its own — a command timeout, which
some brands have and others do not.

The release deliberately ignores the write deadband: letting go is worth one
unconditional write even when the entity looks like it already reads 0, because
the entity's last known value is the very thing in doubt when something has gone
wrong enough to be switching control off.

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
| `test/unit/net-zero.test.ts` | the strategy: both directions, the deadband on both sides of zero, the feedback term, SoC limits, an unreadable sensor, the proportional split, and the power caps — each direction independently, and a battery limited to 0 W leaving the split to the others. Also the unsteerable cases: dropping out of the plan, and not being counted into the feedback term |
| `test/unit/settings-model.test.ts` | validation and normalization for grid, batteries and control config, including `resolvePowerLimits` and a battery record saved before the control fields existed |
| `test/unit/settings-store.test.ts` | persistence round trips, and reading a hand-edited file |
| `test/unit/setpoints.test.ts` | the write itself: the service picked from the entity's domain, a refused domain, rounding to `step`, the deadband skipping a redundant write and clearing it not doing, correcting an entity something else moved, and a failure on one battery leaving its neighbour written |
| `test/unit/control-loop.test.ts` | scheduling: starts only when enabled, ticks at once when switched on, ticks when a watched reading moves, ignores entities it doesn't use, holds its rate limit under a burst without losing the last change, keeps ticking when the house is quiet, picks up a changed interval, survives an outage, names the source and age of what it read, and files its lines under the right origin. Also that a target entity's own range reaches the strategy, that a configured cap overrides it rather than narrowing it, and that a change to a target provokes no tick. Also the write from the loop's side: that a tick writes what it decided, that a second tick doesn't repeat it, that a deadband hold writes nothing, that an unreadable grid cancels a standing command, and that switching control off releases the batteries |
| `test/unit/routes.test.ts` | the home loader's shape, entity deduplication, every settings intent, the writable-domain filter on `/api/entities`, and that control refuses to switch on with no steerable battery but can always be switched off |
| `test/integration/ingress.test.ts` | the loop running inside the real `server.js`, reached over HTTP through the ingress proxy — including the setpoint leaving that process over the Supervisor proxy, and the release landing when control is switched off |
| `test/integration/control-loop-boot.test.ts` | that a restart with control already enabled has the loop running before anything asks it to — the one thing no other suite can show, since they all start it themselves. What it reads is the diagnostics entry `syncControlLoop()` writes when it starts an interval: nothing in that process has posted the settings form, so only the boot-time call can have produced it |
| `test/e2e/app.spec.ts` | configuring it in a browser, enabling it, and watching the diagnostics box fill |

The loop tests run on two clocks on purpose. The event-driven cases use the real
one, because they turn on a WebSocket message arriving and no fake timer can
hurry real I/O along; the cases about elapsed time use fake timers with the
subscription pointed somewhere unreachable, so the loop is on its REST path and
nothing is waiting on a socket. Either way `pendingControlTick()` exposes the
tick currently in flight, since advancing a clock only *starts* one.

## Not done yet

- **A mode entity.** Many inverters ignore a setpoint until a `select.*` is put
  into a forced or manual mode, and want it returned to self-consumption
  afterwards. This is the biggest remaining gap and the most likely reason a
  correctly written setpoint does nothing: the write lands on the entity, the
  entity reads back what we asked for, and the hardware carries on doing
  whatever its own logic says. It is a second field and a lifecycle, not just
  another write, and it is also what would make [letting go](#letting-go) mean
  "resume self-consumption" rather than merely "stop".
- **Noticing that the hardware disagreed.** The read-back confirms the *entity*
  took the value, which is not the same as the inverter obeying it. Comparing
  the battery's measured power against its setpoint over a few ticks would
  catch a setpoint being ignored — the failure the mode entity above causes.
- **Redistributing what a power cap holds back** within a single tick, rather
  than letting the feedback term converge on it over several. Worth doing if the
  convergence turns out to be visible in practice.
- **Price awareness** — dynamic prices, negative-price strategies and PV
  curtailment are separate [roadmap](../roadmap.md) items.
- **Persisting decisions** for after-the-fact analysis. That wants its own store
  and a retention policy, not the [diagnostics](diagnostics.md) buffer made
  durable.
