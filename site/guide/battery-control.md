# Battery control

The goal is one sentence: **keep the grid meter at zero.** If the house is
importing, the battery should be covering it; if it is exporting, the battery
should be soaking it up.

Every few seconds the add-on reads the grid meter and each battery, decides what
each one should be doing, publishes that as a Home Assistant event, and records
both halves in the [diagnostics log](/guide/diagnostics).

**It does not touch your battery itself.** Each steered battery gets its own
event, named after its title — `elias_ems_home_battery_target_power` — and an
automation you write listens for it and turns it into whatever your inverter
wants — see [Connecting the
event to your battery](#connecting-the-event-to-your-battery), which is the step
that makes any of this do something.

## Why it isn't "importing 800 W, so discharge 800 W"

The obvious rule is wrong, and it is worth understanding why before you trust
the log.

The grid reading **already includes whatever the battery is doing**. A battery
discharging at 800 W while the meter reads exactly zero is already doing the
right thing — the naive rule would tell it to stop, and create an 800 W import in
the process.

So the target is the battery's *current* power minus the meter:

```
target = what the battery is doing now − what the meter reads
```

Same reading, different answer, and the correct one. It is also self-correcting:
whenever a decision under-delivers, the meter stays off zero and the next tick
asks for the remainder.

## The rules

1. The grid sensor is read as-is.
2. **If the meter is within 25 W of zero, everything holds where it is.** Chasing
   meter noise would only cycle the battery for nothing.
3. Otherwise the target is calculated as above, over the **steered** batteries
   only.
4. A battery **drops out of this tick** when it cannot help in that direction:
   - it is not steered, so there is nothing to say to it. It holds at whatever
     it is currently doing, rather than being told to stop;
   - it is at or above its maximum charge and the plan is to charge;
   - it is at or below its minimum charge and the plan is to discharge;
   - its power limit in that direction is 0 — see
     [Power limits](/guide/configure#power-limits);
   - its state of charge cannot be read. Guessing there would mean guessing about
     the one limit that protects the hardware.
5. The rest **share the target in proportion to their capacity**. Splitting it
   evenly would ask a 5 kWh battery for as much as the 20 kWh one beside it.
6. Each share is then **capped** at that battery's charge or discharge power
   limit. The cap comes last, after the split: it is a fact about the inverter,
   not about how the target should be divided.

What a cap holds back is not handed to the other batteries within the same tick.
It does not need to be — whatever goes undelivered keeps the meter off zero, so
the next tick asks for it again and the batteries with headroom take it up over a
few seconds.

### Batteries you haven't ticked "Steer this battery" for

A battery that is not steered is left out of the plan *and* out of the
arithmetic. That second part is less obvious and matters: it is already covering
some of the load, so counting it in would ask the steerable batteries to cover
the same watts a second time, and the meter would overshoot by exactly that
amount. A house importing 200 W with an unsteered battery already discharging
800 W would end up exporting 800 W.

## What actually gets published

A decision and a command are not the same thing, and the log shows both:

| Situation | What the log reports | What gets published |
| --- | --- | --- |
| Charge or discharge | the share, after capping | the same |
| At a charge or power limit | 0 | **0** — an active stop |
| Meter inside the 25 W deadband | the battery's measured power | **nothing** |
| Grid sensor unreadable | measured power | **0** for steerable batteries |
| Not steered | measured power | nothing |

The deadband row is the interesting one. A hold reports what the battery is
measured to be doing, which is the right thing to *show* and the wrong thing to
*command* — publishing a measurement back as a target would let sensor noise
walk the commanded value around on a house that is already balanced. So a hold
says nothing and the previous target stands.

The unreadable-grid row goes the other way, deliberately. A battery left forcing
kilowatts because the meter it was following broke is the one hold that must not
persist, so that case stops the battery rather than holding it.

**Targets are deduplicated.** One only goes out when it differs from the last
one published for that battery by at least 50 W — otherwise a loop ticking every
second would fire thousands of events an hour, and on the other end of each one
is your automation doing real work. A target older than 30 seconds is restated
anyway, so an automation you reloaded or an inverter you power-cycled picks the
current value back up within a tick or two instead of waiting for the house to
swing by 50 W.

## The event

Each steered battery has **its own event type, named after its title** —
`elias_ems_home_battery_target_power` for a battery called "Home battery". The
Settings page shows the exact string under the Title field.

Every event carries:

| Field | Meaning |
| --- | --- |
| `slug` | the same name the event type carries, for an automation listening to several |
| `battery_id` | the stored record's id, which survives renaming the battery |
| `title` | what the settings page and the log call this battery |
| `power_w` | the target, signed: **positive charging, negative discharging** |
| `charge_w` | `power_w` when charging, otherwise 0 — an unsigned magnitude |
| `discharge_w` | the same for discharging |
| `released` | `true` only when Elias ems is [letting go](#switching-it-off) |

`charge_w` and `discharge_w` are the same number restated, for the many
inverters that have a charge register and a discharge register instead of one
signed value. Use whichever pair your hardware speaks; the sign arithmetic is
already done.

::: tip See it before you wire anything to it
Developer Tools → **Events** → listen to your battery's event name, then enable
control. Every payload shows up there, which is how to check the sign and the
magnitude before an inverter is involved.
:::

::: danger Renaming the battery renames the event
An automation listening for the old name simply stops hearing that battery —
Home Assistant has no idea the two were related, so nothing anywhere reports a
problem. The edit form names both while you type; update the trigger to match.
:::

## Connecting the event to your battery

This is the part Elias ems cannot do for you, because it is the part that knows
what your inverter is. All of the examples use a battery titled "Home battery",
whose event the Settings page shows as `elias_ems_home_battery_target_power`.

::: warning mode: queued, not the default
Home Assistant's default automation mode is `single`, which **drops** an event
that arrives while the previous run is still going. On a house that has just
swung hard, the dropped one is the target you most wanted. Use `mode: queued`
with a small `max`, as below.
:::

### A Modbus register

The common case for a plain Modbus setup — and note there is no `input_number`
helper in it any more:

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

If your inverter has a separate register per direction, use the unsigned pair
instead:

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

### A `number` entity from an inverter integration

`huawei_solar`, `solaredge_modbus_multi`, Victron and friends publish a writable
`number`. One action:

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

Setting an entity is a state change, so this puts a row in your logbook and
recorder every time the target moves. That is a real cost and it is now your
choice rather than the add-on's: write the register directly if you would rather
not have it, or exclude the entity under `recorder:`/`logbook:`.

### An inverter that needs its mode set

Many inverters ignore a target until a `select` entity is put into a forced or
manual mode — and want it back on self-consumption when Elias ems stands down.
`released` is what tells the two apart:

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
          # Elias ems is standing down — hand the battery back to its own logic
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

Re-selecting the mode that is already selected is harmless, so it needs no
guard.

### Several batteries

**One automation per battery is usually the right answer** — that is the point
of each battery having its own event. Each one then runs only when *its* battery
moved, and a battery sitting at its charge limit while the other takes the whole
swing wakes nothing at all.

If you would rather have one, an event trigger takes a list of types and `slug`
says which arrived (Home Assistant has no wildcard for event types, so the list
is explicit):

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

### Your sign convention is not ours

Elias ems always publishes **positive charging, negative discharging**. If your
inverter is the other way round, negate it in the automation — a template of
`-trigger.event.data.power_w` — rather than anywhere else. Doing it in the
one place that talks to the hardware keeps the log, the dashboard and the
strategy all agreeing with each other.

## Switching it off

Switching control off, and shutting the add-on down cleanly, both publish **0 W**
for every steerable battery, with `released: true`. A battery left forcing
kilowatts because the thing that told it to is gone is the worst failure this
feature has — from the battery's side there is no difference between a target
that is still wanted and one whose author died ten minutes ago.

Two honest limits:

- Zero is the **safe** value, not necessarily the *correct* one. It stops the
  battery being driven either way, which is safe on every inverter, but handing
  it back to its own self-consumption logic means restoring a mode on many
  brands. `released` is there so your automation can do that — see [the mode
  example](#an-inverter-that-needs-its-mode-set) — but Elias ems itself only
  knows how to say "stop".
- Nothing runs at all on a hard kill, a power cut, or a container the Supervisor
  destroys without asking. The only real protection against those is an inverter
  whose forced mode expires on its own — some brands have that, others do not.

## What it cannot do yet

::: danger It does not know whether anything is listening
An event goes on the bus and nothing comes back. No automation, one still
listening for a battery's old name, an automation dropping events because it is
still `mode: single`,
or an inverter that quietly ignores a target all look **exactly the same**
from Elias ems' side: a log full of correct-looking decisions and a battery that
does nothing.

Until it learns to compare the battery's measured power against what it asked
for, the check is yours to make — the diagnostics log, the event listener in
Developer Tools, and the automation's own trace, in that order.
:::

There is also no price awareness **in this feature**: the battery runs
net-zero-energy and knows nothing about what electricity costs, so negative-price
charging is still on the roadmap. Prices are imported (see [Dynamic
prices](/guide/prices)) and [PV curtailment](/guide/pv-curtailment) does act on
them.

The full list with the reasoning behind each item is in
[the internals](/internals/battery-control#not-done-yet).

## Reading a decision

A tick in the diagnostics log looks like this:

```
22:50:57 Grid net +842 W (importing), batteries at 0 W → discharge 842 W total. (via live cache, oldest reading 3s)
         Home battery: discharge at 561 W (SoC 76%, 6.6 kWh to 10%)
         Garage battery: discharge at 281 W (SoC 76%, 2.8 kWh to 20%)
         Published: Home battery → -561 W; Garage battery → -281 W
```

The summary line is the arithmetic above, made visible. The clause in brackets
says which source the numbers came from and how old the oldest of them was —
nothing refuses to act on an old reading, so **this is where a sensor that
quietly stopped reporting becomes visible**. Each battery line carries its state
of charge and the energy headroom left in the direction it is going, because
"discharge at 561 W" is much easier to sanity-check next to "6.6 kWh to 10%".

A decision that was capped says what it was capped from — a plan quietly
delivering less than the meter needs otherwise reads exactly like one that is on
target.

The `Published:` line is what actually left the add-on, and a tick can honestly
end without one: if every battery is inside the 50 W deadband there was nothing
new to say. What that line does **not** prove is that anything acted on it.

## Next

[Dynamic prices →](/guide/prices)
