# Battery control

The first EMS feature: a loop that watches the grid meter and works out what the
house battery should be doing to keep it at zero.

**It decides, publishes, and logs.** Each tick works out what every battery
should be doing, publishes that as a Home Assistant event, and records both the
decision and what went out. It does not touch the hardware itself: an
automation you write listens for the event and turns it into whatever your
inverter wants — see [Connecting the event to a
battery](#connecting-the-event-to-a-battery).

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
entities, and the **title** does double duty — it names the battery in the log
and on the dashboard, and it is what the target event type is derived from.

| Field | Type | Notes |
| --- | --- | --- |
| `title` | text | e.g. "Home battery" |
| `capacityKwh` | number | must be above 0 |
| `minChargePercent` | number | 0–100, must be below the maximum |
| `maxChargePercent` | number | 0–100 |
| `energyEntityId` | entity | cumulative energy counter, kWh |
| `powerEntityId` | entity | current power, W — see the sign convention below |
| `socEntityId` | entity | state of charge, % |
| `steered` | boolean | whether targets are published for this battery at all |
| `maxChargePowerW` | number | **optional** — cap on charge power, W |
| `maxDischargePowerW` | number | **optional** — cap on discharge power, W, as a positive number |

**Sign convention: both power fields are read as positive = charging, negative =
discharging.** This is a decision, not an observation — inverters disagree, and
plenty publish the opposite. It is the convention the strategy's arithmetic, the
log lines and the event payload are all written against. If your battery reports
the other way round, wrap it in a Home Assistant template sensor that negates
it.

`minChargePercent` and `maxChargePercent` bound what control may use, not what
the battery is capable of. Control never discharges below the floor or charges
above the ceiling.

#### Steered, and the event named after the title

`steered` is what turns a battery from something watched into something
commanded. False is a supported state, not an unfinished one — see [Batteries
that cannot be steered](#batteries-that-cannot-be-steered) below.

A checkbox rather than the presence of some other field, so that "watched, not
steered" is chosen rather than arrived at by leaving something empty. It used to
be implied by whether a target entity had been filled in; with the event name
now derived from the title there is no such field left to overload, and
overloading one was never the clearer half of that design anyway.

**Battery control cannot be enabled until at least one battery is steered.** The
checkbox on the Settings page is disabled until then, and the action rejects the
save even if the form is posted directly — a battery can stop being steered
after control was switched on, so the server cannot trust the form to have been
rendered in the current state. Switching control *off* is always allowed, which
is the way out of that state.

The rule is "at least one", not "all": a house can reasonably have one steerable
battery and one that only reports. What it cannot have is control enabled with
nothing to command, because a loop that decides correctly and changes nothing
looks exactly like a loop that is broken.

**Upgrades arrive unsteered.** A record written before this field existed has no
`steered`, which reads as false — including the records from the version that
wrote to a target entity. That is the honest reading: nothing is
listening for the event until an automation exists, so carrying a battery across
as steered would be claiming to command hardware that has stopped hearing us.
Ticking the box and writing the automation is one deliberate step, in that
order.

#### The slug, and what renaming costs

`slugifyTitle` reduces the title to something that can be part of an event type:
Unicode-normalised so accents fold away rather than becoming underscores,
lowercased, and every run of anything else collapsed to a single `_`, with the
ends trimmed. "Home battery" and "Home  Battery!" both give `home_battery`;
"Réserve" gives `reserve`. `targetEventType` wraps it as
`elias_ems_<slug>_target_power`.

Derived rather than typed, because the two names are the same name. A separate
field would mean a battery could be called one thing on the settings page and
another in YAML, and keeping them in step is work nobody signed up for. It is
shown, read-only, under the title as it is typed, so the name an automation has
to be written against never requires saving the form to discover.

Two consequences, and both are handled where they happen rather than where they
would be convenient:

- **Renaming a battery renames its event.** Home Assistant has no idea the two
  types were ever related, so an automation listening for the old one silently
  stops hearing this battery. The edit form says so — while the new title is
  being typed, naming both event types — because that is the only moment
  anything can.
- **Two titles can collide.** "Home battery" and "home-battery" are different
  names and one event type, which would leave both batteries taking each other's
  targets with nothing reporting a problem. The settings action rejects the
  save; the check lives there rather than in `parseBattery` because it needs
  every other battery, and the model module is pure.

A title with no letters or digits at all — "⚡", say — has nothing to build a
name from, and the form rejects it. `batterySlug` still has a fallback of
`battery_<id>` for anything a hand-edited file gets past the form, because an
ugly event type beats publishing to `elias_ems__target_power`.

#### Power limits

`maxChargePowerW` and `maxDischargePowerW` cap what the strategy may ask a
battery for, so the proportional split cannot request more than the inverter can
deliver. Both are **positive magnitudes** — "5000", not "-5000" for discharge —
and the sign is applied where it is used.

Settings are the **only** source of a limit. While the target was written to
an entity there was a second one — the `min`/`max` that `number` and
`input_number` entities publish about themselves — and an empty field fell back
to it. An event has no such range, and deriving one from `capacityKwh` would be
a guess about hardware, so an empty field now means exactly what it says: that
direction is uncapped, and the SoC window is what keeps the battery inside its
own limits.

That is a little less automatic and considerably less surprising. The old
fallback's worst case was an `input_number` created through the Home Assistant
UI, which defaults to a 0–100 range: as a power limit that capped a 5 kW battery
at 100 W, and the only symptom was a battery quietly delivering a fortieth of
what the meter asked for.

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

so the target that drives `net` to zero is:

```
targetBatteryPower = currentBatteryPower - net
```

A battery discharging at 800 W while the meter reads zero is *already* doing
exactly the right thing. The naive rule would tell it to stop and create an
800 W import in the process. This form tells it to carry on — a different answer
to the same reading, and the correct one.

### Batteries that cannot be steered

A battery that is not steered is left out of the plan: it keeps doing
whatever it was doing, and gets a decision line saying so rather than a
target. The less obvious half is that it must also be left out of
`currentBatteryPower`. Writing `C` for the steerable batteries' combined power
and `U` for the unsteerable ones':

```
net = load - pv + C + U
```

The unsteerable ones stay at `U`, so the target that zeroes the meter comes
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
   - it is not steered, so nothing can be said to it. Unlike the cases
     below it holds at its *current* power rather than at 0 — those are a
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

Each decision reports the energy headroom next to the target —
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

## Publishing the target

In [addon/app/lib/targets.server.ts](../../addon/app/lib/targets.server.ts),
kept apart from the strategy (which stays pure) and from the loop (which is
about *when* to decide). What arrives is a number in watts with the sign
convention already applied; what leaves is one Home Assistant event per battery.

### Why an event and not a write

This used to call `number.set_value` or `input_number.set_value` on an entity
configured per battery. It worked, and it left a trail. Every target was a
state change, and a state change in Home Assistant is a logbook line, a recorder
row and an entry in that entity's activity feed. A loop that reconsiders every
few seconds turns that into thousands of rows a day whose entire content is the
add-on talking to itself — and it buries the state changes somebody actually
wants to look at.

An event carries the same instruction and leaves none of that: nothing stores
it, nothing renders it in a history. Two things come with that, and both are
improvements rather than consolations:

- **The add-on stops needing to know what kind of thing is behind the battery.**
  A `number` entity can only be set to a value. An automation can set a mode
  first, write two registers instead of one, negate the sign for an inverter
  that disagrees with ours, or call something that isn't in Home Assistant at
  all. Everything under [Not done yet](#not-done-yet) that used to need another
  configuration field is now expressible without one.
- **The `input_number` middleman becomes optional.** A plain Modbus setup used
  to need a helper purely because Home Assistant's `modbus` integration has no
  `number` platform, so the add-on wrote the helper and an automation forwarded
  it to `modbus.write_register`. That automation can now listen for the event
  directly, and the helper — the thing whose activity feed started this — can go.

### The event

`elias_ems_<slug>_target_power` — `elias_ems_home_battery_target_power` for a battery called
"Home battery" — one event per steered battery per publish, with this payload:

| Field | Type | Meaning |
| --- | --- | --- |
| `slug` | string | the same slug the event type carries, for an automation listening to several |
| `battery_id` | string | the stored record's id, which survives a rename |
| `title` | string | what the settings page and the log call this battery |
| `power_w` | number | the target, signed: **positive charging, negative discharging** |
| `charge_w` | number | `power_w` when charging, else 0 — an unsigned magnitude |
| `discharge_w` | number | `-power_w` when discharging, else 0 |
| `released` | boolean | true only when the add-on is [letting go](#letting-go) |

`charge_w` and `discharge_w` are the same number restated, and they are there
because plenty of inverters have a charge register and a discharge register
rather than one signed value. Doing the split here keeps that automation free
of Jinja arithmetic whose sign is easy to get wrong in exactly the way that
drives a battery backwards.

**One event type per battery, rather than one shared type with the battery named
in the payload.** The trigger then says which battery it is for in the line that
is hardest to get wrong: `event_type: elias_ems_home_battery_target_power` reads as
what it is, where a shared type plus an `event_data` filter puts the identity
somewhere easy to leave off — and an automation missing that filter drives every
battery in the house from one battery's target.

The shape not taken was one event carrying every battery at once. It reads
tidier and behaves worse: an automation would have to dig its battery out of a
list, which is exactly the template that silently yields nothing when a name
drifts, and — since the [deadband](#the-publish-deadband-and-why-it-needs-a-refresh)
is per battery — any one battery moving would have to republish the whole set,
waking every automation in the house each time. Separate events keep that
filtering where it costs nothing.

### What gets published, which is not the target

Each decision carries a `commandW` alongside its `targetW`, and they are
deliberately different things:

| Decision | `targetW` | `commandW` |
| --- | --- | --- |
| charge / discharge | the share, capped | the same |
| at an SoC or power limit | 0 | **0** — an active stop |
| inside the grid deadband | the battery's *measured* power | **null** — publish nothing |
| grid sensor unreadable | measured power | **0** for steerable batteries |
| not steered | measured power | null |

The deadband row is the one worth explaining. A hold reports the battery's
measured power, which is the right thing to *display* and the wrong thing to
*command*: publishing a measurement back as a target would let sensor noise
walk the commanded value around tick after tick, on a house that is already
balanced. So a deadband hold says nothing and the previous target stands.

The unreadable-grid row goes the other way. That is the blind case, and a
battery left forcing kilowatts because the meter it was following broke is the
one hold that must not persist. An unreachable Home Assistant never gets this
far — the tick fails first — so a null reading here means a genuinely broken
sensor.

### The publish deadband, and why it needs a refresh

A target goes out when it differs from **the last one we published** for that
battery by at least 50 W. The loop can tick every second and a house is never
still, so a strategy recalculating a few watts lower each time would otherwise
fire an event every tick — and on the other end of each one is an automation
doing real work against hardware that on some brands commits every change to flash.

The comparison used to be against what the target entity read *now*, which made
it self-correcting and stateless: something else moving the entity showed up as
a difference on the next tick and was written back, with nothing remembered in
between. An event has no read-back — a 200 from Home Assistant means the event
reached the bus, not that any automation was listening, let alone that the
hardware obeyed — so the comparison is now against a value this process
remembers, which is an assumption rather than an observation.

**`REPUBLISH_MS` is what stops that assumption becoming an indefinite one.** A
target older than 30 seconds is restated even when nothing has moved, so an
automation that was reloaded, an inverter that was power-cycled, or a Home
Assistant that restarted mid-tick all converge again within a tick or two
instead of waiting for the house to swing by 50 W. It is half the idle tick, so
a quiet house restates on the next idle tick rather than every other one.

The memory is deliberately not persisted, and a failed publish is deliberately
not recorded. A restart is exactly the moment when what the hardware is doing is
least certain, so starting with nothing remembered and publishing on the first
tick is the right recovery; and remembering an event that never made it onto the
bus would let the deadband suppress its own retry.

A failed publish is one battery not hearing what it was told: it is logged, the
other batteries still go out, and the next tick tries again. It is never allowed
to end the loop.

### Letting go

`releaseBatteries()` publishes 0 for every steerable battery with `released:
true`, and runs when control is switched off and on `SIGTERM`/`SIGINT`. A
battery left forcing kilowatts because the thing that told it to is gone is the
worst failure this feature has — from the battery's side there is no difference
between a target that is still wanted and one whose author died ten minutes
ago.

Zero is the **safe** value, not necessarily the *correct* one: it stops the
battery being driven either way, which is safe on every inverter, but handing it
back to its own self-consumption logic means restoring a mode on many brands.
`released` is how that becomes somebody's to fix — the watts are 0 either way,
and the flag is what lets an automation tell "stop" from "stop, and I am no
longer in charge of you". The add-on still only knows how to say the first.

What no flag can help with: nothing here survives `kill -9`, a power cut, or a
container the supervisor destroys without asking. The only real answer to those
is an inverter whose forced mode expires on its own — a command timeout, which
some brands have and others do not.

The release deliberately ignores the deadband, and clears the memory behind it.
Letting go is worth one event even when we think the battery is already at 0,
because what we think is the very thing in doubt when something has gone wrong
enough to be stopping.

## Connecting the event to a battery

The event is half the feature; the automation is the other half, and it is the
half that knows what your inverter is. Everything below assumes a battery titled
"Home battery", which the Settings page shows as
`elias_ems_home_battery_target_power`.

**Watch it first.** Developer Tools → Events → listen to
`elias_ems_home_battery_target_power`, then enable control. Every payload above shows
up there, which is how to check the sign and the magnitude before anything is
wired to hardware.

### Writing a Modbus register

The case the `input_number` helper existed to serve, now with nothing in the
middle:

```yaml
alias: Battery target → inverter
mode: queued
max: 10
triggers:
  - trigger: event
    event_type: elias_ems_home_battery_target_power
actions:
  - action: modbus.write_register
    data:
      hub: inverter
      slave: 1
      address: 40200
      value: "{{ trigger.event.data.power_w | int }}"
```

`mode: queued` matters. The default, `single`, drops an event that arrives while
the previous run is still going and writes a warning to the log — which on a
house that has just swung hard is precisely the target you wanted. A small
`max` bounds the queue so a stalled Modbus write cannot grow one without limit.

A register that wants an unsigned magnitude per direction takes `charge_w` and
`discharge_w` instead, and needs no template arithmetic to get there:

```yaml
actions:
  - action: modbus.write_register
    data:
      hub: inverter
      slave: 1
      address: 40200
      value: "{{ trigger.event.data.charge_w | int }}"
  - action: modbus.write_register
    data:
      hub: inverter
      slave: 1
      address: 40201
      value: "{{ trigger.event.data.discharge_w | int }}"
```

### Setting a `number` entity

An inverter integration that publishes a writable `number` needs one action, and
this is the shape that reproduces exactly what the add-on used to do by itself:

```yaml
alias: Battery target → inverter
mode: queued
max: 10
triggers:
  - trigger: event
    event_type: elias_ems_home_battery_target_power
actions:
  - action: number.set_value
    target:
      entity_id: number.battery_target_power
    data:
      value: "{{ trigger.event.data.power_w }}"
```

Worth knowing what you are choosing here: setting an entity is a state change,
so this automation puts the target back into the logbook and the recorder. If
that is the noise you were trying to get rid of, write the register directly
instead, or exclude the entity in `recorder:`/`logbook:` — but an inverter's own
`number` entity is a real reading of the device, and hiding it is a different
decision from not writing to it several times a minute.

### The mode entity, and putting it back

The one that used to be listed as missing. An inverter that ignores a target
until it is in a forced mode wants two actions on the way in and a different one
on the way out, and `released` is what separates them:

```yaml
alias: Battery target → inverter
mode: queued
max: 10
triggers:
  - trigger: event
    event_type: elias_ems_home_battery_target_power
actions:
  - choose:
      - conditions:
          - condition: template
            value_template: "{{ trigger.event.data.released }}"
        sequence:
          # Elias ems is standing down: hand the battery back to its own logic
          # rather than leaving it forced at 0 W.
          - action: select.select_option
            target:
              entity_id: select.inverter_working_mode
            data:
              option: Self consumption
    default:
      - action: select.select_option
        target:
          entity_id: select.inverter_working_mode
        data:
          option: Forced charge/discharge
      - action: number.set_value
        target:
          entity_id: number.battery_target_power
        data:
          value: "{{ trigger.event.data.power_w }}"
```

Re-selecting a mode that is already selected is a no-op on every integration
worth using, so there is no need to guard the `select` with a condition.

### Several batteries, one automation

An event trigger takes a list of types, and `slug` in the payload says which one
arrived — Home Assistant has no wildcard for event types, so the list is
explicit:

```yaml
alias: Battery targets → inverters
mode: queued
max: 10
triggers:
  - trigger: event
    event_type:
      - elias_ems_home_battery_target_power
      - elias_ems_garage_battery_target_power
actions:
  - action: number.set_value
    target:
      entity_id: >-
        {{ {'home_battery': 'number.home_battery_target_power',
            'garage_battery': 'number.garage_battery_target_power'}[trigger.event.data.slug] }}
    data:
      value: "{{ trigger.event.data.power_w }}"
```

Worth knowing that one automation per battery is usually the better trade here,
precisely because the events are separate: each one then runs only when *its*
battery moved, where the combined version above runs on every event and does
nothing for the batteries that did not.

### If the automation itself is the noise

An automation that runs leaves its own trace: `last_triggered` moves and the
logbook shows it being triggered. That is far less than a state change per
target, and it is per automation rather than per battery entity, but it is not
nothing. `logbook:`/`recorder:` exclusions take an `automation.*` entity id the
same way they take any other, which is the place to say so.

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
         Published: Home battery → -561 W; Garage battery → -281 W
```

The last line is what actually left the process, and it is deliberately not a
repeat of the ones above it: a tick whose deadband held everything back has the
decisions and no `Published:` line at all, which is the difference between "it
decided this" and "it said this out loud".

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
| `test/unit/settings-model.test.ts` | validation and normalization for grid, batteries and control config, including `resolvePowerLimits`, a battery record saved before the control fields existed, one from the version that named a target entity, and the slug rules — collapsing, folded accents, a title with nothing to build a name from, and the id fallback |
| `test/unit/settings-store.test.ts` | persistence round trips, and reading a hand-edited file |
| `test/unit/targets.test.ts` | the publish itself: the event type named after the battery and the payload an automation acts on, one type per battery, both directions of the charge/discharge split, rounding, the deadband holding a target back and a move clearing it — per battery, so a quiet neighbour stays quiet — a stale target being restated, a release going out past the deadband and saying so, and a failed publish not being remembered so the retry survives |
| `test/unit/control-loop.test.ts` | scheduling: starts only when enabled, ticks at once when switched on, ticks when a watched reading moves, ignores entities it doesn't use, holds its rate limit under a burst without losing the last change, keeps ticking when the house is quiet, picks up a changed interval, survives an outage, names the source and age of what it read, and files its lines under the right origin. Also that a configured cap reaches the strategy, and that an entity an automation moved on our behalf provokes no tick. Also the publish from the loop's side: that a tick publishes what it decided under the battery's key, that a second tick doesn't repeat it, that a deadband hold publishes nothing, that an unreadable grid cancels a standing command, and that switching control off releases the batteries |
| `test/unit/routes.test.ts` | the home loader's shape, entity deduplication, every settings intent, `/api/entities` offering readings only, that two batteries may not have names that make the same event while a battery keeps its own name across an edit, and that control refuses to switch on with no steerable battery but can always be switched off |
| `test/integration/ingress.test.ts` | the loop running inside the real `server.js`, reached over HTTP through the ingress proxy — including the target event leaving that process over the Supervisor proxy, and the release landing, flagged as one, when control is switched off |
| `test/integration/control-loop-boot.test.ts` | that a restart with control already enabled has the loop running before anything asks it to — the one thing no other suite can show, since they all start it themselves. What it reads is the diagnostics entry `syncControlLoop()` writes when it starts an interval: nothing in that process has posted the settings form, so only the boot-time call can have produced it |
| `test/e2e/app.spec.ts` | configuring it in a browser, enabling it, and watching the diagnostics box fill |

The loop tests run on two clocks on purpose. The event-driven cases use the real
one, because they turn on a WebSocket message arriving and no fake timer can
hurry real I/O along; the cases about elapsed time use fake timers with the
subscription pointed somewhere unreachable, so the loop is on its REST path and
nothing is waiting on a socket. Either way `pendingControlTick()` exposes the
tick currently in flight, since advancing a clock only *starts* one.

## Not done yet

- **Knowing whether anything is listening.** The event goes on the bus and the
  add-on hears nothing back. No automation, an automation still listening for a
  battery's old name, a `mode: single` automation dropping events under load:
  all three look identical from here, and all three look like a loop that is
  working. Comparing the battery's measured
  power against the target over a few ticks is what would catch every one of
  them, and it is the biggest remaining gap now that the mode entity is the
  automation's business rather than a missing field.
- **A worked example per inverter family.** The recipes above are the shapes,
  not a catalogue. The register numbers, mode names and sign conventions differ
  per brand, and that is exactly the knowledge this project does not have yet.
- **Redistributing what a power cap holds back** within a single tick, rather
  than letting the feedback term converge on it over several. Worth doing if the
  convergence turns out to be visible in practice.
- **Price awareness** — dynamic prices, negative-price strategies and PV
  curtailment are separate [roadmap](../roadmap.md) items.
- **Persisting decisions** for after-the-fact analysis. That wants its own store
  and a retention policy, not the [diagnostics](diagnostics.md) buffer made
  durable.
