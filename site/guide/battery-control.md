# Battery control

Battery control plans what the house battery should be doing over the next day
or two — from your solar forecasts, household history and prices. It refreshes
the plan five minutes before each price interval ends, and as the next interval
starts publishes it as a command for your battery's automation to carry out.
It only commands batteries with **Steer this battery** and **Plan charge
limits** checked, and currently supports one configured
household battery.

## Choosing a strategy

Under **Settings → Battery control**, pick one of three strategies:

| Strategy | What it aims for |
| --- | --- |
| **Evening target** | the battery full by 18:00 even with 20% less solar than forecast, then the cheapest way to get there — reserving energy during cheap hours for expensive demand |
| **HiGHS cost optimizer** | the lowest expected cost over the forecast and a 20%-less-solar scenario, solved exactly; it has no evening target, so it may leave the battery emptier |
| **Dynamic programming** | the same low expected cost, searched over the battery's levels interval by interval, while keeping enough charge at the end to cover demand until solar recovers |

Both keep the battery in its **own self-consumption mode** and only move two
limits: its maximum charging power and, if your automation can apply it, its
maximum AC output. Neither charges from the grid or exports from the battery.
Switching between them takes effect at the next plan, and the Home page's
**Battery plan** card says which one produced the plan it shows.

Not sure which? Export your planner data from **Plans** and import it into the
[Planner sandbox](/planner): it runs both on the same forecast and shows their
cost, final charge and every interval side by side. How the two work, and how a
new one is added, is in [the internals](/internals/strategies);
[charge-limit optimization](/internals/charge-limit) covers the forecast and the
planning cycle.

::: warning Net zero energy has been removed
If you had it selected, Elias ems comes back with battery control **switched
off** and says so in the [diagnostics log](/guide/diagnostics). Its automation
was written for setpoints; both remaining strategies send `balance` with
limits, so update the automation ([Limits in balance](#limits-in-balance))
before choosing a strategy and enabling control again.
:::

**It does not touch your battery itself.** Each steered battery gets its own
command event, named after its title — `elias_ems_home_battery_battery_command`
— and an automation you write listens for it and turns it into whatever your
inverter wants — see [Connecting the
event to your battery](#connecting-the-event-to-your-battery), which is the step
that makes any of this do something.

## The event

Each steered battery has **its own event type, named after its title** —
`elias_ems_home_battery_battery_command` for a battery called "Home battery".
The Settings page shows the exact string under the Title field. Every battery
strategy publishes on it, so one automation per battery serves either.

Each event is a **command**: a mode, the power limits that go with it, and how
long it is valid for.

| Mode | What the battery should do |
| --- | --- |
| `balance` | its own self-consumption, within `charge_limit_w` and `discharge_limit_w` |
| `hold` | nothing: 0 W, whatever the meter does |
| `charge` | charge at `setpoint_w` |
| `discharge` | discharge at `-setpoint_w` |

Both strategies send `balance`. The other three are part of the contract for
strategies that will steer the battery directly; none does yet.

The fields you are most likely to use:

| Field | Meaning |
| --- | --- |
| `action` | `apply`, or `release` when Elias ems is [letting go](#switching-it-off) |
| `released` | `true` for a release — the same thing as one condition |
| `mode` | one of the four above; empty on a release |
| `setpoint_w` | the power, signed: **positive charging, negative discharging**; empty in `balance` |
| `charge_w` / `discharge_w` | the setpoint as unsigned magnitudes, 0 in the other direction |
| `charge_limit_w` / `discharge_limit_w` | the most it may charge or discharge at; empty means "your battery's own limit" |
| `valid_until` | after this, the command is stale and the battery should be handed back |
| `slug`, `battery_id`, `title` | which battery, for an automation listening to several |

The rest — `schema_version`, `command_id`, `owner_epoch`, `issued_at`,
`strategy`, `grid_charging`, `battery_export`, `valid_from`, `release_reason` —
are in [the full reference](/internals/battery-control#the-event).

::: tip See it before you wire anything to it
Developer Tools → **Events** → listen to your battery's event name, then enable
control. Every payload shows up there, which is how to check the mode, the sign
and the magnitude before an inverter is involved.
:::

::: danger Renaming the battery renames the event
An automation listening for the old name simply stops hearing that battery —
Home Assistant has no idea the two were related. Saving the rename sends a
release under the old name, and the edit form names both while you type;
update the trigger to match.
:::

### Tell Elias ems what your automation can do

Under **Settings → Batteries**, each battery says which modes its automation
can carry out. Both strategies only need `balance`; the others are recorded for
strategies that will use them. Tick **Can limit discharge (AC output) in
balance** only if your automation applies `discharge_limit_w` — without it the
strategies leave the battery's output alone.

## Connecting the event to your battery

This is the part Elias ems cannot do for you, because it is the part that knows
what your inverter is. All of the examples use a battery titled "Home battery",
whose event the Settings page shows as
`elias_ems_home_battery_battery_command`.

::: warning mode: queued, not the default
Home Assistant's default automation mode is `single`, which **drops** an event
that arrives while the previous run is still going. On a house that has just
swung hard, the dropped one is the command you most wanted. Use `mode: queued`
with a small `max`, as below.
:::

### Setpoints: an inverter with a forced mode

No strategy sends setpoints yet — skip to [Limits in balance](#limits-in-balance)
for what they send today. This is the shape for when one does. Most inverters ignore a power setpoint until a `select` entity is put into a
forced or manual mode, and want it back on self-consumption when Elias ems
stands down:

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
          - action: number.set_value
            target:
              entity_id: number.battery_target_power
            data:
              value: "{{ trigger.event.data.setpoint_w }}"
```

For a plain Modbus register, swap the `number.set_value` for a register write:

```yaml
          - action: modbus.write_register
            data:
              hub: inverter
              slave: 1
              address: 40200
              value: "{{ trigger.event.data.setpoint_w | int }}"
```

If your inverter has a register per direction, write `charge_w` and
`discharge_w` instead — the sign arithmetic is already done. Re-selecting the
mode that is already selected is harmless, so it needs no guard.

Setting an entity is a state change, so a `number.set_value` puts a row in your
logbook and recorder every time the setpoint moves. Write the register directly
if you would rather not have that, or exclude the entity under
`recorder:`/`logbook:`.

### Limits in balance

What both strategies send: the battery stays in self-consumption and only its
limits move.

```yaml
alias: Battery limits → inverter
mode: queued
max: 10
triggers:
  - trigger: event
    event_type: elias_ems_home_battery_battery_command
actions:
  - variables:
      # Your battery's normal limits, used when Elias ems sends none or lets go.
      normal_w: 2000
      charge: "{{ trigger.event.data.charge_limit_w if trigger.event.data.charge_limit_w is not none else normal_w }}"
      output: "{{ trigger.event.data.discharge_limit_w if trigger.event.data.discharge_limit_w is not none else normal_w }}"
  - action: number.set_value
    target:
      entity_id: number.battery_charge_limit
    data:
      value: "{{ normal_w if trigger.event.data.released else charge }}"
  - action: number.set_value
    target:
      entity_id: number.battery_ac_output_limit
    data:
      value: "{{ normal_w if trigger.event.data.released else output }}"
```

The release branch is what puts your normal limits back. Earlier versions of
Elias ems wrote these entities themselves; on upgrade it restores any limit it
had left in place once, and from then on only publishes.

### Several batteries

**One automation per battery is usually the right answer** — that is the point
of each battery having its own event, and it is what lets batteries of different
brands live side by side: each automation knows its own inverter. Each one then
runs only when *its* battery moved.

If you would rather have one, an event trigger takes a list of types and `slug`
says which arrived (Home Assistant has no wildcard for event types, so the list
is explicit).

### Your sign convention is not ours

Elias ems always publishes **positive charging, negative discharging**. If your
inverter is the other way round, negate it in the automation — a template of
`-trigger.event.data.setpoint_w` — rather than anywhere else. Doing it in the
one place that talks to the hardware keeps the log, the dashboard and the
strategy all agreeing with each other.

## Switching it off

Switching control off, changing strategy, un-steering a battery, and shutting
the add-on down cleanly all publish a **release** — `action: release`,
`released: true` — for the batteries that strategy was commanding. A battery
left forcing kilowatts because the thing that told it to is gone is the worst
failure this feature has.

A release is **not** a hold. Hold means "stay at 0 W, I'm still in charge";
release means "I'm no longer in charge of you", and your automation is what
knows how to hand this inverter back to its own logic — see the release branch
in [Limits in balance](#limits-in-balance). A plan that fails — no forecast, or
a HiGHS solve that finds no schedule in time — releases the battery too, rather
than leaving it capped by an old plan.

Nothing runs at all on a hard kill, a power cut, or a container the Supervisor
destroys without asking. That is what `valid_until` is for. The best protection
is an inverter whose forced mode expires on its own — set its timeout a little
longer than the commands' validity. Without one, an automation can watch
`valid_until` itself; [the internals](/internals/battery-control#honouring-valid_until)
show how.

## What it cannot do yet

::: danger It does not know whether anything is listening
An event goes on the bus and nothing comes back. No automation, one still
listening for a battery's old name, an automation dropping events because it is
still `mode: single`,
or an inverter that quietly ignores a command all look **exactly the same**
from Elias ems' side: a log full of correct-looking decisions and a battery that
does nothing.

Until it learns to compare the battery's measured power against what it asked
for, the check is yours to make — the diagnostics log, the event listener in
Developer Tools, and the automation's own trace, in that order.
:::

Neither strategy charges from the grid when prices are low or negative, or
discharges into it when they are high: that needs the direct modes, which wait
for a way to enforce those permissions against live power.

The full list with the reasoning behind each item is in
[the internals](/internals/battery-control#not-done-yet).

## Reading a decision

A plan in the diagnostics log looks like this:

```
Home battery: HiGHS cost optimizer active, maximum charge 1200 W, maximum AC output 2000 W. HiGHS: Optimal for modeled objective.
Published: Home battery → balance (charge ≤ 1200 W, discharge ≤ 2000 W)
```

The first line is the plan for the current interval and the strategy that made
it; "preview" instead of "active" means control is off or something is
blocking it, and the rest of the line says what. The `Published:` line is what
actually left the add-on, and a plan can honestly end without one: if the
command did not change there was nothing new to say. What that line does
**not** prove is that anything acted on it.

## Next

[Dynamic prices →](/guide/prices)
