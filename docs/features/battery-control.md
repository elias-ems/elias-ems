# Battery control

The first EMS feature: a loop that watches the grid meter and works out what the
house battery should be doing to keep it at zero.

**It decides, publishes, and logs.** Each strategy works out what every battery
should be doing, publishes that as a versioned **battery command** event — a
mode plus power boundaries — and records both the decision and what went out.
Neither strategy touches the hardware itself: an automation you write per
battery listens for its event and turns it into whatever that inverter wants —
see [Connecting the event to a battery](#connecting-the-event-to-a-battery).
That split is what lets several batteries, of different brands, be steered by
the same strategy.

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
and on the dashboard, and it is what the command event type is derived from.

| Field | Type | Notes |
| --- | --- | --- |
| `title` | text | e.g. "Home battery" |
| `capacityKwh` | number | must be above 0 |
| `minChargePercent` | number | 0–100, must be below the maximum |
| `maxChargePercent` | number | 0–100 |
| `energyEntityId` | entity | cumulative energy counter, kWh |
| `powerEntityId` | entity | current power, W — see the sign convention below |
| `socEntityId` | entity | state of charge, % |
| `steered` | boolean | whether the selected strategy may publish commands for this battery |
| `controlModes` | list | which modes its automation can carry out — see [What the automation can do](#what-the-automation-can-do) |
| `dischargeLimitSupported` | boolean | whether its automation can cap AC output in `balance` |
| `powerStepW` | number | resolution of planned boundaries, W; default 100 |
| `chargeLimitPlanning` | boolean | whether Optimize charge limits plans this battery |
| `maxChargePowerW` | number | **optional** — cap on charge power, W |
| `maxDischargePowerW` | number | **optional** — cap on discharge power, W, as a positive number |
| `commandContract` | number | the command schema version the record was saved against; set by the form |

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

Steered is necessary, not sufficient: each strategy also needs the battery to
be able to carry out what it asks for (`steerableBy`). Net zero energy needs the
setpoint modes; Optimize charge limits needs `chargeLimitPlanning`.

**Battery control cannot be enabled until a battery can be steered by the
selected strategy** — at least one for net zero energy, exactly one for
Optimize charge limits. The
checkbox on the Settings page is disabled until then, and the action rejects the
save even if the form is posted directly — a battery can stop being steered
after control was switched on, so the server cannot trust the form to have been
rendered in the current state. Switching control *off* is always allowed, which
is the way out of that state.

The rule is "at least one", not "all": a house can reasonably have one steerable
battery and one that only reports. What it cannot have is control enabled with
nothing to command, because a loop that decides correctly and changes nothing
looks exactly like a loop that is broken.

**Upgrades arrive unsteered.** A record without `commandContract` predates the
battery command event, and reads as unsteered whatever it said before —
including records that published `_target_power` events, and those whose
limit entities Optimize charge limits wrote directly. That is the honest
reading: nothing is listening for the new event until an automation exists, so
carrying a battery across as steered would be claiming to command hardware that
has stopped hearing us. Its *intent* is kept — a battery that had limit entities
keeps `chargeLimitPlanning`, and `dischargeLimitSupported` if it had an output
entity. Writing the automation and ticking the box is one deliberate step, in
that order. Limits an earlier version wrote directly are restored on its first
run; see [charge-limit optimization](charge-limit.md#upgrading-from-direct-limit-writes).

#### The slug, and what renaming costs

`slugifyTitle` reduces the title to something that can be part of an event type:
Unicode-normalised so accents fold away rather than becoming underscores,
lowercased, and every run of anything else collapsed to a single `_`, with the
ends trimmed. "Home battery" and "Home  Battery!" both give `home_battery`;
"Réserve" gives `reserve`. `commandEventType` wraps it as
`elias_ems_<slug>_battery_command`.

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
  anything can, and saving the rename publishes a release under the old name
  so the last command does not stand.
- **Two titles can collide.** "Home battery" and "home-battery" are different
  names and one event type, which would leave both batteries taking each other's
  commands with nothing reporting a problem. The settings action rejects the
  save; the check lives there rather than in `parseBattery` because it needs
  every other battery, and the model module is pure.

A title with no letters or digits at all — "⚡", say — has nothing to build a
name from, and the form rejects it. `batterySlug` still has a fallback of
`battery_<id>` for anything a hand-edited file gets past the form, because an
ugly event type beats publishing to `elias_ems__battery_command`.

#### Power limits

`maxChargePowerW` and `maxDischargePowerW` cap what the strategy may ask a
battery for, so the proportional split cannot request more than the inverter can
deliver. Net zero energy also sends them as the command's `charge_limit_w` and
`discharge_limit_w`; Optimize charge limits uses them as the top of the range it
plans boundaries in, and requires both. Both are **positive magnitudes** — "5000", not "-5000" for discharge —
and the sign is applied where it is used.

Settings are the **only** source of a limit. While targets and limits were
written to entities there was a second one — the `min`/`max` that `number` and
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
| `strategy` | `"net-zero-energy"` | Net zero energy or `"charge-limit"` (Optimize charge limits) |
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

## Publishing commands

In [addon/app/lib/battery-commands.server.ts](../../addon/app/lib/battery-commands.server.ts),
with the pure contract in [battery-command.ts](../../addon/app/lib/battery-command.ts).
Kept apart from the strategies (which stay pure) and from the loops (which are
about *when* to decide). **Both strategies publish through it**, and so will the
HiGHS [planning engine](planning-engine.md) once it controls anything: what
arrives is a `BatteryCommand`, what leaves is one Home Assistant event per
battery.

### Why a command event, and why one for both strategies

Net zero energy once called `number.set_value` on a target entity; Optimize
charge limits wrote a battery's charge and AC output limit entities itself until
this module replaced that. An entity write is a state change — a logbook line, a
recorder row and an activity-feed entry, thousands a day from a loop that
reconsiders every few seconds — and, worse for where this is going, it ties the
add-on to whichever entities one particular inverter happens to expose. Two
batteries of different brands would have meant two code paths.

A command says **what the battery should be doing** and leaves **how** to an
automation (or, later, an adapter) per battery. That is what lets a second
battery be a second automation rather than a second integration, and it is the
same split [PV curtailment](pv-curtailment.md) already uses for its arrays:

- **The add-on stops needing to know what kind of thing is behind the battery.**
  An automation can set a mode first, write two registers, negate the sign for
  an inverter that disagrees with ours, or call something outside Home
  Assistant entirely.
- **Nothing it publishes is stored.** An event is not a state change, so it
  leaves no logbook line and no recorder row.

### Modes and boundaries

A command is a **mode plus boundaries** — the shape the HiGHS engine plans in,
so the contract does not have to change when that engine starts controlling
batteries:

| Mode | What the battery should do | `setpoint_w` |
| --- | --- | --- |
| `balance` | its own native self-consumption, clipped by the boundaries | null |
| `hold` | direct control: no battery power, whatever the meter does | 0 |
| `charge` | direct control: charge at the setpoint | positive |
| `discharge` | direct control: discharge at the setpoint | negative |

Two distinctions are deliberate. **Zero battery power is not a balanced meter**:
`hold` keeps the battery still while the house imports, `balance` lets it chase
the meter. And **a ceiling is not a setpoint**: `charge_limit_w` bounds what
`balance` may do; it never asks for power.

What each strategy issues today:

| Strategy | Mode | Setpoint | Boundaries |
| --- | --- | --- | --- |
| Net zero energy | `charge` / `discharge`, `hold` at exactly 0 W | the target | the battery's power caps, or null |
| Optimize charge limits | `balance` | none | the plan's charge ceiling, and its AC output ceiling when the battery can limit discharge |

`grid_charging` and `battery_export` are in the contract from the first version
and both strategies send `false`: neither asks a battery to charge from the grid
or to discharge into it. They are there so an adapter can enforce them against
live power before a strategy exists that wants either.

Which modes a battery's automation can carry out is configured per battery —
see [What the automation can do](#what-the-automation-can-do).

### The event

`elias_ems_<slug>_battery_command` — `elias_ems_home_battery_battery_command`
for a battery called "Home battery" — one per steered battery, with this
payload:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | number | `1`; bumped on any change an automation could notice |
| `slug` | string | the same slug the event type carries, for an automation listening to several |
| `battery_id` | string | the stored record's id, which survives a rename |
| `title` | string | what the settings page and the log call this battery |
| `command_id` | string | unique per event |
| `owner_epoch` | string | unique per add-on process; changes on every restart |
| `issued_at` | ISO time | when it was published |
| `action` | `apply` \| `release` | a command, or the add-on letting go |
| `strategy` | string \| null | which strategy issued it |
| `released` | boolean | `action == "release"`, for a one-word condition |
| `mode` | string \| null | `balance`, `hold`, `charge`, `discharge`; null on release |
| `setpoint_w` | number \| null | signed: **positive charging, negative discharging**; null in balance |
| `charge_w` | number | `setpoint_w` when charging, else 0 — an unsigned magnitude |
| `discharge_w` | number | `-setpoint_w` when discharging, else 0 |
| `charge_limit_w` | number \| null | most it may charge at; null leaves the native limit |
| `discharge_limit_w` | number \| null | most it may discharge at, positive; null leaves native discharge |
| `grid_charging` | boolean | whether it may charge from the grid |
| `battery_export` | boolean | whether it may discharge into the grid |
| `valid_from` | ISO time | start of the period the command is meant for |
| `valid_until` | ISO time \| null | after this, treat it as stale and let go; null on release |
| `release_reason` | string \| null | `disabled`, `unsteered`, `failure`, `shutdown` |

Flat rather than nested, because every field is read from Jinja as
`trigger.event.data.<field>`, and a nested object is one more thing to get wrong
in a template that drives hardware. `charge_w` and `discharge_w` restate the
setpoint for inverters with a register per direction, which keeps that
automation free of sign arithmetic that is easy to get backwards.

**One event type per battery**, rather than one shared type with the battery
named in the payload: the trigger then names its battery in the line that is
hardest to get wrong, where a shared type plus an `event_data` filter puts the
identity somewhere easy to leave off — and an automation missing that filter
drives every battery in the house from one battery's commands. One event
carrying every battery at once was the other shape not taken: the automation
would have to dig its battery out of a list, and any battery moving would wake
every automation in the house.

**Validity.** `valid_until` is the one safeguard that still works when the
add-on is not running at all — nothing it publishes survives `kill -9`, a power
cut or a container destroyed without warning. Net zero energy's commands are
valid for three minutes (`NET_ZERO_VALIDITY_MS`), comfortably more than a
healthy loop ever goes between restatements. Optimize charge limits' are valid
for the planned interval plus a minute's grace (`COMMAND_GRACE_MS`), since the
loop ticks every 30 seconds and would otherwise leave a gap at every interval
boundary. An automation that honours it needs a time trigger of its own; see
[Honouring `valid_until`](#honouring-valid_until).

### What gets published, which is not the target

Net zero energy's decisions carry a `commandW` alongside their `targetW`, and
they are deliberately different things:

| Decision | `targetW` | `commandW` → command |
| --- | --- | --- |
| charge / discharge | the share, capped | the same → `charge`/`discharge` |
| at an SoC or power limit | 0 | **0** → `hold`, an active stop |
| inside the grid deadband | the battery's *measured* power | **null** — publish nothing |
| grid sensor unreadable | measured power | **0** → `hold` for steerable batteries |
| not steered | measured power | null |

A deadband hold reports the battery's measured power, which is the right thing
to *display* and the wrong thing to *command*: publishing a measurement back as
a setpoint would let sensor noise walk it around on a house that is already
balanced. So it says nothing and the previous command stands. The
unreadable-grid row goes the other way: a battery left forcing kilowatts
because the meter it was following broke is the one standing command that must
not persist.

### When a command goes out

A command goes out when it **differs from the last one published** for that
battery, when it is **due a restatement**, or when **another strategy** held
the battery before.

- **Differs** means another mode, another boundary, another permission, or a
  setpoint that moved by at least `PUBLISH_DEADBAND_W` (50 W) — net zero
  energy's only; the planner's boundaries are compared exactly. The loop can
  tick every second and a house is never still, and on the other end of every
  event is an automation doing real work against hardware that on some brands
  commits every change to flash.
- **Restatement** replaces the read-back an entity write used to give. An event
  has none — a 200 from Home Assistant means the event reached the bus, not that
  anything obeyed it — so the memory being compared against is an assumption,
  and each strategy sets when it is restated anyway: net zero energy every
  `REPUBLISH_MS` (30 s, half its idle tick), Optimize charge limits at the end of
  the planned interval, which is also when its next plan is due. An automation
  that was reloaded, an inverter that was power-cycled or a Home Assistant that
  restarted mid-tick all converge again on their own.

The memory is deliberately not persisted, and a failed publish is deliberately
not recorded. A restart is exactly the moment when what the hardware is doing is
least certain, so starting with nothing remembered is the right recovery; and
remembering an event that never reached the bus would let the comparison
suppress its own retry. A failed publish is logged, the other batteries still
go out, and it never ends the loop.

### Ownership, and letting go

Both strategies publish on the same event type, so the publisher remembers
which strategy last applied a command to each battery, and **a strategy only
releases what it holds**. Switching from net zero energy to Optimize charge
limits must not have the outgoing strategy's release land after the incoming
one's first command and leave the battery released until the next interval.
What nothing in this process has commanded yet *is* released on request,
because what an earlier process said is exactly what is in doubt.

A release is `action: "release"` with `mode: null`, and it is **not a hold**.
Hold is "keep the battery at 0 W, I am still in charge"; release is "I am no
longer in charge of you", and the automation is what knows how to hand this
particular inverter back to its own self-consumption — a mode entity on many
brands. Releases go out:

| When | Reason | Which batteries |
| --- | --- | --- |
| a strategy is switched off or away | `disabled` | those it holds |
| a battery is un-steered, renamed or removed | `unsteered` | that battery, under the name it had |
| a charge-limit plan fails | `failure` | that battery, if the strategy holds it |
| `SIGTERM`/`SIGINT` | `shutdown` | every steered battery |

The rename row matters as much as the others: the automation listening for the
old event type would otherwise keep the last command standing until it expired.
Settings releases the battery under its old slug before saving the new one,
because it is the only place that knows both.

## Connecting the event to a battery

The event is half the feature; the automation is the other half, and it is the
half that knows what your inverter is. Everything below assumes a battery titled
"Home battery", which the Settings page shows as
`elias_ems_home_battery_battery_command`.

**Watch it first.** Developer Tools → Events → listen to
`elias_ems_home_battery_battery_command`, then enable control. Every payload
above shows up there, which is how to check the mode, the sign and the
magnitude before anything is wired to hardware.

### What the automation can do

Per battery, the Settings page asks what its automation can carry out, because
the add-on has no way to find out:

| Field | Meaning |
| --- | --- |
| `controlModes` | `balance` always; `hold`, `charge`, `discharge` when the automation can force a setpoint. **Net zero energy needs all three** and leaves a battery without them out of its plan, counted like an unsteered one |
| `dischargeLimitSupported` | the automation can cap AC output in `balance`. Without it Optimize charge limits plans native discharge and sends `discharge_limit_w: null` |
| `powerStepW` | the resolution boundaries are planned in — what a `number` entity's `step` used to supply. Default 100 W |
| `chargeLimitPlanning` | Optimize charge limits plans (and previews) this battery |

### A setpoint over Modbus

Net zero energy's commands, written to a signed register:

```yaml
alias: Battery command → inverter
mode: queued
max: 10
triggers:
  - trigger: event
    event_type: elias_ems_home_battery_battery_command
actions:
  - choose:
      - conditions: "{{ trigger.event.data.released }}"
        sequence:
          # Elias ems is standing down: hand the battery back to its own logic.
          - action: select.select_option
            target:
              entity_id: select.inverter_working_mode
            data:
              option: Self consumption
      - conditions: "{{ trigger.event.data.mode in ['hold', 'charge', 'discharge'] }}"
        sequence:
          - action: select.select_option
            target:
              entity_id: select.inverter_working_mode
            data:
              option: Forced charge/discharge
          - action: modbus.write_register
            data:
              hub: inverter
              slave: 1
              address: 40200
              value: "{{ trigger.event.data.setpoint_w | int }}"
```

`mode: queued` matters. The default, `single`, drops an event that arrives while
the previous run is still going and writes a warning to the log — which on a
house that has just swung hard is precisely the command you wanted. A small
`max` bounds the queue so a stalled Modbus write cannot grow one without limit.
Re-selecting a mode that is already selected is a no-op on every integration
worth using, so there is no need to guard the `select` with a condition.

A register per direction takes `charge_w` and `discharge_w` instead, with no
template arithmetic to get the sign wrong in.

### Boundaries in balance

Optimize charge limits' commands, written to an integration's own limit
entities — the exact writes the add-on used to make itself:

```yaml
alias: Battery limits → inverter
mode: queued
max: 10
triggers:
  - trigger: event
    event_type: elias_ems_home_battery_battery_command
actions:
  - choose:
      - conditions: "{{ trigger.event.data.released }}"
        sequence:
          - action: number.set_value
            target:
              entity_id: number.battery_charge_limit
            data:
              value: 2000 # the battery's normal maximum
          - action: number.set_value
            target:
              entity_id: number.battery_ac_output_limit
            data:
              value: 2000
      - conditions: "{{ trigger.event.data.mode == 'balance' }}"
        sequence:
          - action: number.set_value
            target:
              entity_id: number.battery_charge_limit
            data:
              value: "{{ trigger.event.data.charge_limit_w if trigger.event.data.charge_limit_w is not none else 2000 }}"
          - action: number.set_value
            target:
              entity_id: number.battery_ac_output_limit
            data:
              value: "{{ trigger.event.data.discharge_limit_w if trigger.event.data.discharge_limit_w is not none else 2000 }}"
```

The release branch is the restoration the add-on's own lease journal used to
do. It is now the automation's job, which is also what lets it restore whatever
*your* normal is rather than whatever the entity happened to read before the
first write.

Setting an entity is a state change, so this automation puts the boundaries back
into the logbook — at most once per planned interval, which is a different
order of magnitude from a setpoint every few seconds. An inverter's own
`number` entity is a real reading of the device, and hiding it is a separate
decision.

### Honouring `valid_until`

**An inverter with a native command timeout is the best answer**: set it a
little longer than the validity, and the device lets go even when Home Assistant
is down as well.

Without one, an automation can keep its own watchdog by remembering the latest
`valid_until` in an `input_datetime` helper and checking it on a timer:

```yaml
triggers:
  - trigger: event
    event_type: elias_ems_home_battery_battery_command
    id: command
  - trigger: time_pattern
    minutes: /1
    id: watchdog
actions:
  - choose:
      - conditions:
          - condition: trigger
            id: command
        sequence:
          - action: input_datetime.set_datetime
            target:
              entity_id: input_datetime.home_battery_command_valid_until
            data:
              timestamp: >-
                {{ as_timestamp(trigger.event.data.valid_until)
                   if trigger.event.data.valid_until else 0 }}
          # …then apply or release the command, as above.
      - conditions:
          - condition: trigger
            id: watchdog
          - condition: template
            value_template: >-
              {% set until = as_timestamp(states('input_datetime.home_battery_command_valid_until'), 0) %}
              {{ until > 86400 and now().timestamp() > until }}
        sequence:
          - action: input_datetime.set_datetime
            target:
              entity_id: input_datetime.home_battery_command_valid_until
            data:
              timestamp: 0
          # …then hand the battery back, exactly as the release branch does.
```

The helper is a state change per command, which for net zero energy means one
every 30 seconds or so — the noise events exist to avoid. Exclude it from
`recorder:` and `logbook:`, or prefer the device's own timeout.

### Several batteries

An event trigger takes a list of types, and `slug` in the payload says which one
arrived — Home Assistant has no wildcard for event types, so the list is
explicit. One automation per battery is usually the better trade, precisely
because the events are separate: each then runs only when *its* battery moved.
Different brands are different automations, with nothing in the add-on to
change.

### If the automation itself is the noise

An automation that runs leaves its own trace: `last_triggered` moves and the
logbook shows it being triggered. That is far less than a state change per
command, but it is not nothing. `logbook:`/`recorder:` exclusions take an
`automation.*` entity id the same way they take any other.

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

### What curtailment does with a discharge

Nothing here changes when [PV curtailment](pv-curtailment.md) is also on, and
this is the one place worth saying why, because the two features do now look at
the same number.

Net-zero discharges to cover an import. Curtailment reads that discharge and
[adds it back to what the arrays may
make](pv-curtailment.md#the-battery-free-when-it-charges-not-when-it-discharges),
because a discharging battery hides the shortfall its feedback law is looking
for — otherwise the two would hold each other in a fixed point, with the arrays
pinned at whatever they were cut to and the battery emptying to cover them.

Curtailment never publishes a command for a battery, so the two never steer the
same hardware. The handover is the ordinary loop instead: the arrays take the
house over, the surplus reaches the meter, and net-zero reads it and stops
discharging on the next tick, exactly as it would for any other load that had
gone away. Net-zero is the fast loop with no settle time of its own, curtailment
the slow one paced by `settleSeconds`, which is the right way round for the two
to converge rather than chase each other.

## Watching it decide

Every line the loop produces goes to **diagnostics** under the
`battery-control` origin — see [diagnostics.md](diagnostics.md) for the entry
shape, the buffer and the download. Two places show it, neither of them this
feature's alone: the **decision feed** on the home page, which merges this
origin with PV curtailment's and is open and polling rather than collapsed,
and the **Tools** page, where it is merged with every other feature's. The
feed is deliberately not one box per strategy — the two correct against the
same grid meter within milliseconds of each other, and the pair of decisions
is the thing worth reading. It shows each entry's **first line only**, since a
tick's summary is what a glance wants and the per-battery detail below it
would push the other loop off the bottom; Tools keeps the whole entry, and so
does the download.

A whole tick looks like this:

```
22:50:57 Grid net +842 W (importing), batteries at 0 W → discharge 842 W total. (via live cache, oldest reading 3s)
         Home battery: discharge at 561 W (SoC 76%, 6.6 kWh to 10%)
         Garage battery: discharge at 281 W (SoC 76%, 2.8 kWh to 20%)
         Published: Home battery → discharge 561 W; Garage battery → discharge 281 W
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

## History

The **History** page reads the configured batteries' state-of-charge, power and
energy entities from Home Assistant's Recorder. It offers 24-hour, three-day
and seven-day views; the add-on does not keep a second copy of the readings.
Each measurement gets its own scale so a battery's watt-level power movement
does not flatten its percentage curve; Recorder states without a usable numeric
value are omitted. To keep range changes responsive without keeping stale data
indefinitely, 24-hour reads are cached in memory for one minute and longer
ranges for five minutes. The current charts remain visible and say which range
is loading while an uncached read is in progress.

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
| Curtailment config | `curtailment.ts` | `curtailment-config.server.ts` |
| Prices | `prices.ts` | `prices.server.ts` |

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
| `test/unit/settings-model.test.ts` | validation and normalization for grid, batteries and control config, including `resolvePowerLimits`, a battery record saved before the control fields existed, one from the version that named a target entity, one saved against the command event staying steered, and the slug rules — collapsing, folded accents, a title with nothing to build a name from, and the id fallback |
| `test/unit/charge-limit-config.test.ts` | the per-battery control fields: which modes were ticked, the charge-limit requirements, and a pre-event record keeping its intent but arriving unsteered |
| `test/unit/settings-store.test.ts` | persistence round trips, and reading a hand-edited file |
| `test/unit/battery-commands.test.ts` | the contract and the publish: a signed target becoming charge, discharge or hold, a balance command's boundaries, the full payload an automation acts on, a fresh command id each time, the deadband holding a setpoint back while a mode or boundary change always goes out — per battery, so a quiet neighbour stays quiet — a command restated when due, releases that are not holds, a strategy never releasing a battery another holds, and a failed publish not being remembered so the retry survives |
| `test/unit/charge-limit-loop.test.ts` | Optimize charge limits' commands: the current interval as a balance command with its validity, the AC output boundary only when the battery can limit discharge, no repeat on an unchanged replan, preview without publishing, releasing once when disabled, un-steered or failed — and the migration restoring an earlier version's direct writes before any command, retrying, respecting a manual edit, and each direction independently |
| `test/unit/control-loop.test.ts` | scheduling: starts only when enabled, ticks at once when switched on, ticks when a watched reading moves, ignores entities it doesn't use, holds its rate limit under a burst without losing the last change, keeps ticking when the house is quiet, picks up a changed interval, survives an outage, names the source and age of what it read, and files its lines under the right origin. Also that a configured cap reaches the strategy, and that an entity an automation moved on our behalf provokes no tick. Also the publish from the loop's side: that a tick publishes what it decided under the battery's key, that a battery unable to follow a setpoint is not commanded, that a second tick doesn't repeat it, that a deadband hold publishes nothing, that an unreadable grid holds the battery, and that switching control off releases the batteries |
| `test/unit/routes.test.ts` | the home loader's shape, entity deduplication, every settings intent, `/api/entities` offering readings only, that two batteries may not have names that make the same event while a battery keeps its own name across an edit, that a rename releases the battery under its old name while an ordinary edit publishes nothing, and that control refuses to switch on with no steerable battery but can always be switched off |
| `test/integration/ingress.test.ts` | the loop running inside the real `server.js`, reached over HTTP through the ingress proxy — including the command event leaving that process over the Supervisor proxy, and the release landing, flagged as one, when control is switched off |
| `test/integration/charge-limit.test.ts` | Optimize charge limits inside the real server: restoring an earlier version's direct limit write, planning in the background, publishing a balance command, and releasing it when the strategy is switched off |
| `test/integration/control-loop-boot.test.ts` | that a restart with control already enabled has the loop running before anything asks it to — the one thing no other suite can show, since they all start it themselves. What it reads is the diagnostics entry `syncControlLoop()` writes when it starts an interval: nothing in that process has posted the settings form, so only the boot-time call can have produced it |
| `test/e2e/app.spec.ts` | configuring it in a browser, enabling it, and watching the decision feed fill with the tick's summary line |

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
  working. Comparing the battery's measured power against the command over a
  few ticks is what would catch every one of them, and it is the biggest
  remaining gap now that the mode entity is the automation's business rather
  than a missing field. The contract already separates publishing from
  confirmation for this reason: an adapter acknowledgement would be its own
  event, never inferred from a successful publish.
- **A packaged adapter.** Today every battery needs a hand-written automation,
  including the `valid_until` watchdog. A blueprint, or an adapter that checks
  `owner_epoch` and `command_id` and enforces `grid_charging`/`battery_export`
  against live power, is what the HiGHS engine's direct modes will need before
  they can be trusted on real hardware.
- **Planning several batteries together.** Commands are per battery already;
  Optimize charge limits still plans exactly one, because independent plans
  would allocate the same solar twice.
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

## Optimize charge limits

Both strategies use **Steer this battery** as their per-battery authorization,
and both publish [battery commands](#publishing-commands): net zero energy as
setpoints, Optimize charge limits as `balance` with boundaries. Unchecked
batteries are monitored only. Charge-limit planning still supports one
configured household battery, opted in with **Plan charge limits**.

**Evening target** is the single production planner for both preview and active
control. Older stored algorithm selections are ignored and removed on save.
The previous cost optimizer remains available in the offline gym and Benchmark
page for comparison.

The planner controls the maximum charging power and, when the battery's
automation can limit discharge, its maximum AC output power. It reserves energy during cheaper
hours by limiting discharge, then allows more discharge during expensive demand,
including the morning before solar recovery. The configured native minimum SoC
(e.g. 5%) remains unchanged. Without discharge limiting, discharge stays native.

Evening target uses the battery maximum SoC and the next 18:00 in Home
Assistant's timezone. Missing coverage through that deadline
leaves planning unavailable; it does not invent prices or switch algorithms.
The fixed 20% solar margin defines a second reduced-solar scenario, applied once. The
planner preserves the maximum reachable deadline energy in both scenarios when
full is impossible, accounting for both available controls. Reaching the evening
target takes priority over savings: scarce solar can mean retaining energy even
during expensive demand. This is a bounded local search, not a guarantee of
global optimality or morning availability under unexpected consumption.

A daytime spike buffer of 0.54 kWh sits above the native minimum, capped at
usable capacity. A soft penalty values missing buffer energy
at the import price per hour during solar hours before the deadline. This is a
preference for earlier charging, evaluated with unrestricted native discharge:
withholding output cannot improve the buffer score. Energy below that buffer
target remains available for high-priced demand and appliance spikes, down to
the native minimum. On a 3.6 kWh battery with a 5% minimum, the buffer targets
20% SoC for replenishment; it is not a second discharge floor or a calibrated
spike probability. Price-based withholding and evening feasibility still apply.

None of these are settings: see
[fixed planning settings](charge-limit.md#fixed-planning-settings) for the full
list. See [charge-limit optimization](charge-limit.md) for setup, forecasting
and the migration from direct limit writes.
