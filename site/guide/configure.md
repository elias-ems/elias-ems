# Configuring

Everything is on the **Settings** page, in four sections: Grid, Batteries, PV
entities, and Battery control. Each is edited and saved on its own, so a
half-finished battery cannot stop you fixing the grid sensor.

Entity fields autocomplete against your Home Assistant entities as you type, and
also accept an id typed in full.

Configure in this order: **grid → batteries → control**. The control loop cannot
be enabled until there is something to steer, and enabling it before the sensors
are right means acting on numbers you have not checked.

## The grid sensor

One field:

| Field | What it wants |
| --- | --- |
| **Power — net grid exchange (W)** | Instantaneous power in watts, **signed**: positive means importing, negative means exporting. |

That signed number *is* what every strategy works from — nothing is added or
subtracted between the sensor and the decision, so if the sign is backwards, so
is everything the add-on does.

One sensor rather than an import/export pair, because that is what the common
meters publish: P1/DSMR readers, Shelly EM and friends, and most hybrid
inverters all expose a single signed power sensor.

::: tip If you only have separate import and export sensors
Home Assistant's energy dashboard wants the unsigned pair, so an installation
set up for that often has no signed sensor. Make one with a template sensor that
subtracts export from import, and point this field at that.
:::

**Check the sign before going further.** Switch on a kettle and watch the value
on the home page: it should go *up*. If it goes down, negate it in a template
sensor rather than compensating elsewhere.

## Batteries

Add one entry per battery. Capacity and the charge window are things you know
and Home Assistant does not, so they are typed in; the rest are entities.

| Field | What it wants |
| --- | --- |
| **Title** | A name, e.g. "Home battery". It is what the diagnostics log calls it. |
| **Capacity (kWh)** | Usable capacity. Must be above 0. |
| **Minimum charge (%)** | Control will not discharge below this. |
| **Maximum charge (%)** | Control will not charge above this. |
| **Energy (kWh)** | Cumulative energy counter. |
| **Power (W)** | Current power — **positive charging, negative discharging**. |
| **Charge — state of charge (%)** | The battery's SoC. |
| **Target power (W)** — optional | The writable entity the setpoint is written to. |
| **Maximum charge power (W)** — optional | Cap on charge power. |
| **Maximum discharge power (W)** — optional | Cap on discharge power, as a **positive** number. |

::: danger Both power fields use one sign convention: positive is charging
This is a decision the add-on makes, not something it detects. Inverters
disagree and plenty publish the opposite. If yours reports discharging as
positive, wrap it in a template sensor that negates it — otherwise the strategy
will read a discharging battery as a charging one and drive the meter the wrong
way.
:::

The minimum and maximum bound what *control* may use, not what the battery is
capable of. Setting 20 and 90 does not stop the battery's own logic charging to
100 — it stops Elias ems asking it to.

### Target power: watched vs. steered

**Target power** is what turns a battery from something watched into something
steered. Leave it empty and the battery still appears on the dashboard, still
counts as part of the house, and simply never gets told what to do — a supported
state, not an unfinished one.

It wants a **writable** entity, which in practice is one of two things:

- a **`number.*`** from an inverter integration — `huawei_solar`,
  `solaredge_modbus_multi`, Victron and friends all publish one;
- an **`input_number.*`** helper that one of your automations forwards to the
  device. This is how a plain Modbus setup does it: Home Assistant's built-in
  `modbus` integration has **no `number` platform**, so writing a register means
  calling `modbus.write_register` from an automation, and the `input_number` is
  what you point this field at.

The autocomplete suggests those two domains. It still accepts anything you type,
which is the escape hatch for a control surface in some other domain.

**Battery control cannot be switched on until at least one battery has a target
power entity.** The checkbox stays disabled until then. The rule is "at least
one", not "all" — a house can reasonably have one steerable battery and one that
only reports.

### Power limits

The two optional caps stop the strategy asking a battery for more than its
inverter can deliver. Both are **positive magnitudes** — `5000`, not `-5000` for
discharge.

Leave them empty and the target entity's own range is used instead: `number` and
`input_number` entities both publish a `min` and `max`, so `max` becomes the
charge limit and `-min` the discharge limit.

::: warning An input_number helper defaults to a 0–100 range
Created through the Home Assistant UI, an `input_number` is 0–100 unless you say
otherwise — which as a power limit would cap a 5 kW battery at 100 W. Either fix
the helper's range, or fill in these fields, which **override** the entity's
range rather than narrowing it.

A range that cannot express a direction caps that direction at **0**, and a
battery limited to 0 W drops out of the plan with `discharge power limited to
0 W` in the log. If a battery is visibly sitting out for that reason, this is
why.
:::

## PV entities

One entry per array, purely for display — nothing decides anything from these
yet.

| Field | What it wants |
| --- | --- |
| **Title** | e.g. "Roof south". |
| **Total energy generated (kWh)** | Cumulative production counter. |
| **Current power (W)** | Instantaneous production. |

## Battery control

| Field | Default | Notes |
| --- | --- | --- |
| **Enabled** | off | Disabled until a battery has a target power entity. |
| **Strategy** | Net-zero energy | The only one so far. |
| **Loop interval (seconds)** | 5 | 1–3600. |

The interval is a **rate limit, not a schedule**: at most one decision per
interval. The loop does not wait for a timer to notice the meter moved — Home
Assistant tells it, and it acts as soon as the event arrives, subject to that
limit. A change arriving inside the window schedules a tick for when the window
closes, so the last change before a lull is never swallowed. A slow idle tick
runs regardless, so a quiet house still produces evidence the loop is alive.

Saving this section takes effect immediately, including switching control off.

## Verify before you trust it

Once control is on, open the **Diagnostics** box under Battery control on the
home page and read a few ticks. You are looking for three things: the grid
number and its direction match reality, each battery's decision makes sense for
its state of charge, and the setpoint you see in the log is the value the target
entity actually reads back in Home Assistant.

If the log looks right but nothing physically happens, read
[Battery control](/guide/battery-control#what-it-cannot-do-yet) — an inverter
that needs its mode set is the usual answer.

## Next

[The dashboard →](/guide/dashboard)
