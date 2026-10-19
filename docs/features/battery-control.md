# Battery control

The first EMS feature: a planning loop that works out, from solar forecasts,
household history and prices, what the house battery should be doing over the
next day or two — using whichever registered **strategy** is selected — and
says so for the current interval.

There are two strategies, **Evening target** and **HiGHS cost optimizer**. They
share one contract and one registry, which Settings, the planning loop, the
documentation site's Planner sandbox and the offline gym all read, so adding a
third is one module — see [Battery control strategies](strategies.md).

**It decides, publishes, and logs.** The strategy works out what the battery
should be doing, publishes that as a versioned **battery command** event — a
mode plus power boundaries — and records both the decision and what went out.
No strategy touches the hardware itself: an automation you write per
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
| `chargeLimitPlanning` | boolean | whether the selected strategy plans this battery ("Plan charge limits") |
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

Steered is necessary, not sufficient: the strategy also needs the battery to
be able to carry out what it asks for (`steerableBy`). Both registered
strategies publish `balance` with boundaries, so both need
`chargeLimitPlanning`; a strategy that issued direct modes would also need them
in `controlModes`.

**Battery control cannot be enabled until exactly one battery can be steered by
the selected strategy** — independent plans for two batteries would spend the
same solar twice. The
checkbox on the Settings page is disabled until then, and the action rejects the
save even if the form is posted directly — a battery can stop being steered
after control was switched on, so the server cannot trust the form to have been
rendered in the current state. Switching control *off* is always allowed, which
is the way out of that state.

What a house cannot have is control enabled with nothing to command, because a
loop that decides correctly and changes nothing looks exactly like a loop that
is broken.

**Upgrades arrive unsteered.** A record without `commandContract` predates the
battery command event, and reads as unsteered whatever it said before —
including records that published `_target_power` events, and those whose
limit entities the charge-limit planner wrote directly. That is the honest
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

`maxChargePowerW` and `maxDischargePowerW` cap what a strategy may ask a
battery for. Both strategies use them as the top of the range they plan
boundaries in, and require both. Both are **positive magnitudes** — "5000", not "-5000" for discharge —
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
| `strategy` | `"evening-target"` | `"evening-target"` or `"highs"`: an id from the [strategy registry](strategies.md) |

The strategy is stored as an id so a new one is additive: register it and it is
offered here, with nothing already on disk needing to change.

There is no interval setting: commands follow the price intervals (see
[The loop](#the-loop)). An `intervalSeconds` stored by an earlier version is
ignored and dropped on the next save.

**Stored ids from earlier versions.** `"charge-limit"` was Evening target under
its feature's name and is read as `"evening-target"`. `"net-zero-energy"` was a
live setpoint strategy that has been **removed**: an install that had it comes
back with control **switched off** on Evening target, and the first read writes
that back and leaves one `battery-control` warning in the log saying why. It is
not silently swapped for a planner, because its automations were written for
setpoints and a planner publishes `balance` with boundaries — a different
instruction. Choosing a strategy and enabling control again is one deliberate
step, after the automation handles `balance`
([Boundaries in balance](#boundaries-in-balance)).

## Strategies

What a strategy is, the contract every one implements, how both are scored and
how to add one: [strategies.md](strategies.md). In short:

| Strategy | Plans for | Publishes in production |
| --- | --- | --- |
| **Evening target** (`evening-target`) | the battery's maximum charge by 18:00, even with 20% less solar, then savings — see [below](#evening-target) | `balance` with a charge ceiling, and an AC output ceiling when the battery can limit discharge |
| **HiGHS cost optimizer** (`highs`) | the lowest mean cost over the forecast and reduced-solar scenarios, solved exactly; no evening target | the same |

Both run in the same planning loop
([charge-limit.md](charge-limit.md#control-lifecycle)): replan every five
minutes or at the current interval's end, publish that interval, release the
battery when a plan fails. HiGHS solves on a worker thread with a 20-second
budget, so it never blocks the server.

## Publishing commands

In [addon/app/lib/battery-commands.server.ts](../../addon/app/lib/battery-commands.server.ts),
with the pure contract in [battery-command.ts](../../addon/app/lib/battery-command.ts).
Kept apart from the strategies (which stay pure) and from the loops (which are
about *when* to decide). **Every strategy publishes through it**: what arrives
is a `BatteryCommand`, what leaves is one Home Assistant event per battery.

### Why a command event, and why one for every strategy

An earlier setpoint strategy called `number.set_value` on a target entity; the
charge-limit planner wrote a battery's charge and AC output limit entities
itself until this module replaced that. An entity write is a state change — a logbook line, a
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
so the contract does not have to change when a strategy starts issuing direct
modes:

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
| Evening target | `balance` | none | the plan's charge ceiling, and its AC output ceiling when the battery can limit discharge |
| HiGHS cost optimizer | `balance` | none | the same |

The direct modes are in the contract and in the HiGHS engine's model — the
Planner sandbox compares plans that use them — but no production strategy issues
them yet: the add-on plans with **balance-only capabilities**
(`PRODUCTION_CAPABILITIES` in
[charge-planner.server.ts](../../addon/app/lib/charge-planner.server.ts)), the one
place that would change. `grid_charging` and `battery_export` are in the
contract from the first version and every strategy sends `false`: none asks a
battery to charge from the grid or to discharge into it. They are there so an adapter can enforce them against
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
cut or a container destroyed without warning. A strategy's command is valid for
the planned interval plus a minute's grace (`COMMAND_GRACE_MS`), so a boundary
run delayed by one still holding the lock does not leave a gap between two
healthy commands. An automation that honours it needs a time trigger of its own; see
[Honouring `valid_until`](#honouring-valid_until).

### When a command goes out

A command goes out when it **differs from the last one published** for that
battery, when it is **due a restatement**, or when **another strategy** held
the battery before.

- **Differs** means another mode, another boundary or another permission;
  boundaries are compared exactly. A setpoint, when a strategy issues one, may
  pass a `PUBLISH_DEADBAND_W` (50 W) to the publisher, because on the other end
  of every event is an automation doing real work against hardware that on some
  brands commits every change to flash.
- **Restatement** replaces the read-back an entity write used to give. An event
  has none — a 200 from Home Assistant means the event reached the bus, not that
  anything obeyed it — so the memory being compared against is an assumption,
  and a planned command is restated at the end of its interval anyway, which is
  also when the next plan is due. An automation
  that was reloaded, an inverter that was power-cycled or a Home Assistant that
  restarted mid-tick all converge again on their own.

The memory is deliberately not persisted, and a failed publish is deliberately
not recorded. A restart is exactly the moment when what the hardware is doing is
least certain, so starting with nothing remembered is the right recovery; and
remembering an event that never reached the bus would let the comparison
suppress its own retry. A failed publish is logged, the other batteries still
go out, and it never ends the loop.

### Ownership, and letting go

Every strategy publishes on the same event type, so the publisher remembers
which strategy last applied a command to each battery, and a release can be
narrowed to what one strategy holds. Switching from Evening target to HiGHS is
a hand-over rather than a release: the incoming strategy's first command
replaces the outgoing one's, and the command's `strategy` field says which
issued it.
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
| a plan fails (no forecast, a HiGHS solve with no schedule or past its deadline) | `failure` | that battery, if a strategy holds it |
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
| `controlModes` | `balance` always; `hold`, `charge`, `discharge` when the automation can force a setpoint. No production strategy issues the direct modes yet; recorded so one can be enabled per battery |
| `dischargeLimitSupported` | the automation can cap AC output in `balance`. Without it the strategies plan native discharge and send `discharge_limit_w: null` |
| `powerStepW` | the resolution boundaries are planned in — what a `number` entity's `step` used to supply. Default 100 W |
| `chargeLimitPlanning` | the selected strategy plans (and previews) this battery |

### A setpoint over Modbus

Direct-mode commands, written to a signed register. No production strategy
sends these yet; this is the shape an automation takes once one does:

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

Both strategies' commands, written to an integration's own limit
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

The helper is a state change per command — at most one per planned interval,
but still the kind of noise events exist to avoid. Exclude it from
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

Battery control runs in the **planning loop**,
[charge-limit-loop.server.ts](../../addon/app/lib/charge-limit-loop.server.ts),
for every registered strategy. It wakes when the current price interval ends —
every 15 or 60 minutes, depending on the price source — and at that boundary it
first publishes the new interval from the plan in hand, then calculates a fresh
plan, republishing only if that plan disagrees. Applying first keeps the
command on time: planning reads history and forecasts and may run a solver,
which can take far longer than the moment an interval starts. A settings save
plans at once, a failed plan releases the battery and is retried after a
minute, and a one-minute housekeeping pass in between only restores limits an
earlier version wrote and lets go of batteries that may no longer be
commanded. Its lifecycle — including what happens while a
plan is being calculated and how a settings save interrupts a HiGHS solve in
progress — is in [charge-limit.md](charge-limit.md#control-lifecycle).

- **Started at boot** from
  [addon/app/entry.server.tsx](../../addon/app/entry.server.tsx), which is the
  only module the framework loads exactly once when the server starts.
  Deliberately *not* started from a loader: an EMS that only runs while somebody
  has the Home Assistant panel open is not managing anything.
- **HiGHS runs off the server thread.**
  [highs-runner.server.ts](../../addon/app/lib/highs-runner.server.ts) imports
  `engine/node.mjs` at runtime from `../engine` (or `ENGINE_DIR`), which starts
  a worker thread per solve with its own wall-clock deadline. Vite never bundles
  the engine: it would inline `node.mjs` and lose the worker file and the WASM
  solver beside it. The image keeps the repository's layout for the same reason
  — `/app/addon` beside `/app/engine`.

The other loop in the add-on,
[control-loop.server.ts](../../addon/app/lib/control-loop.server.ts), used to
carry a live battery strategy too. It is [PV curtailment's](pv-curtailment.md)
now, plus the one duty that stays process-wide: on `SIGTERM`/`SIGINT` it
releases every steered battery, whichever loop commanded it.

### What curtailment does with a discharge

[PV curtailment](pv-curtailment.md) reads the batteries' power and adds a
discharge back to what the arrays may make, because a discharging battery hides
the shortfall its feedback law is looking for. It never publishes a command for
a battery, so the two features never steer the same hardware: a battery in
balance yields on its own once the arrays' surplus reaches the meter.

## Watching it decide

Every plan goes to **diagnostics** under the `charge-limit` origin, and every
release under `battery-control` — see [diagnostics.md](diagnostics.md) for the
entry shape, the buffer and the download. The **decision feed** on the home page
merges them with PV curtailment's, and the **Tools** page with every other
feature's. A plan looks like this:

```
Home battery: HiGHS cost optimizer active, maximum charge 1200 W, maximum AC output 2000 W. HiGHS: Optimal for modeled objective.
Published: Home battery → balance (charge ≤ 1200 W, discharge ≤ 2000 W)
```

The last line is what actually left the process: a plan whose command was
unchanged has no `Published:` line at all, which is the difference between "it
decided this" and "it said this out loud". The **Battery plan** card on the
home page names the strategy that produced the plan it shows.

The buffer is **deliberately not persisted**; download it from Tools if a
particular stretch is worth keeping.

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
| Control config | `control.ts` (strategies from `strategies/`) | `control-config.server.ts` |
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
| `test/unit/strategies.test.ts` | the registry holding exactly Evening target and HiGHS, Settings offering what it holds, stored ids (`charge-limit` renamed, `net-zero-energy` switched off), Evening target as balance commands, HiGHS reporting a solve with no schedule as a failure, and a real solve on a worker thread that never costs more than Evening target under the shared replay |
| `test/unit/settings-model.test.ts` | validation and normalization for grid, batteries and control config, including `resolvePowerLimits`, a battery record saved before the control fields existed, one from the version that named a target entity, one saved against the command event staying steered, and the slug rules — collapsing, folded accents, a title with nothing to build a name from, and the id fallback |
| `test/unit/charge-limit-config.test.ts` | the per-battery control fields: which modes were ticked, the charge-limit requirements, and a pre-event record keeping its intent but arriving unsteered |
| `test/unit/settings-store.test.ts` | persistence round trips, and reading a hand-edited file |
| `test/unit/battery-commands.test.ts` | the contract and the publish: a signed target becoming charge, discharge or hold, a balance command's boundaries, the full payload an automation acts on, a fresh command id each time, the deadband holding a setpoint back while a mode or boundary change always goes out — per battery, so a quiet neighbour stays quiet — a command restated when due, releases that are not holds, a strategy never releasing a battery another holds, and a failed publish not being remembered so the retry survives |
| `test/unit/charge-limit-loop.test.ts` | the planning loop's commands: planning with the selected strategy and naming it on the command, a strategy switch as a hand-over, the current interval as a balance command with its validity, the AC output boundary only when the battery can limit discharge, no repeat on an unchanged replan, waiting for the price interval to end before planning again, applying the next interval from the plan in hand before a slow replan, preview without publishing, releasing once when disabled, un-steered or failed — and the migration restoring an earlier version's direct writes before any command, retrying, respecting a manual edit, and each direction independently |
| `test/unit/control-loop.test.ts` | the shared loop's scheduling, driven by PV curtailment: starts only when enabled, ticks at once when switched on, ticks when a watched reading moves, ignores entities it doesn't use, holds its rate limit under a burst without losing the last change, keeps ticking when the house is quiet, survives an outage, names the source and age of what it read, files its lines under the right origin — and never publishes a battery command |
| `test/unit/routes.test.ts` | the home loader's shape, entity deduplication, every settings intent, `/api/entities` offering readings only, that two batteries may not have names that make the same event while a battery keeps its own name across an edit, that a rename releases the battery under its old name while an ordinary edit publishes nothing, and that each strategy can be enabled for a steered, planned battery, that control refuses to switch on with no steerable battery or with more than one, but can always be switched off |
| `test/integration/ingress.test.ts` | through the ingress proxy: an install upgrading with net zero energy enabled coming back switched off, with the warning in the downloaded log, and a strategy saved and selected |
| `test/integration/charge-limit.test.ts` | each strategy inside the real server — Evening target under its old stored id, and HiGHS solving from `../engine` on a worker thread: restoring an earlier version's direct limit write, planning in the background, publishing a balance command named after the strategy, and releasing it when control is switched off |
| `test/integration/control-loop-boot.test.ts` | that a restart with PV curtailment already enabled has the shared loop running before anything asks it to (the planning loop's boot is covered by charge-limit.test.ts, which never posts the form before its first command) |
| `test/e2e/app.spec.ts` | configuring a battery in a browser, choosing HiGHS from the two strategies offered, enabling it, and the plan's line reaching the Tools page and the download |

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
  both strategies still plan exactly one, because independent plans would
  allocate the same solar twice.
- **Direct modes in production.** HiGHS plans hold, charge and discharge in the
  sandbox; production uses balance only until a battery's automation (or an
  adapter) is trusted to enforce grid-charging and export permissions.
- **A terminal value for HiGHS.** It values nothing left in the battery at the
  end of the horizon, so a plan can end at the minimum SoC; replanning moves
  that end along, and the [gym](strategies.md#the-gym) is where to fix it.
- **A worked example per inverter family.** The recipes above are the shapes,
  not a catalogue. The register numbers, mode names and sign conventions differ
  per brand, and that is exactly the knowledge this project does not have yet.
- **Price awareness** — dynamic prices, negative-price strategies and PV
  curtailment are separate [roadmap](../roadmap.md) items.
- **Persisting decisions** for after-the-fact analysis. That wants its own store
  and a retention policy, not the [diagnostics](diagnostics.md) buffer made
  durable.

## Evening target

Every strategy uses **Steer this battery** as its per-battery authorization and
**Plan charge limits** as the opt-in, and publishes
[battery commands](#publishing-commands) as `balance` with boundaries. Unchecked
batteries are monitored only. Planning supports one configured household
battery.

The previous cost optimizer remains in the offline gym and the Benchmark page
for comparison; it is not a registered strategy.

Evening target controls the maximum charging power and, when the battery's
automation can limit discharge, its maximum AC output power. It reserves energy during cheaper
hours by limiting discharge, then allows more discharge during expensive demand,
including the morning before solar recovery. The configured native minimum SoC
(e.g. 5%) remains unchanged. Without discharge limiting, discharge stays native.

Evening target uses the battery maximum SoC and the next 18:00 in Home
Assistant's timezone. Missing coverage through that deadline
leaves planning unavailable; it does not invent prices or switch strategies.
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

HiGHS is described in [strategies.md](strategies.md#highs-cost-optimizer) and
[planning-engine.md](planning-engine.md).

None of these are settings: see
[fixed planning settings](charge-limit.md#fixed-planning-settings) for the full
list. See [charge-limit optimization](charge-limit.md) for setup, forecasting
and the migration from direct limit writes.
