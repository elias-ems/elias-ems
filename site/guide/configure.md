# Configuring

Everything is on the **Settings** page, in four sections: Grid, Batteries, PV
entities, and Battery control. Each is edited and saved on its own, so a
half-finished battery cannot stop you fixing the grid sensor.

Entity fields autocomplete against your Home Assistant sensors as you type, and
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
| **Control key** — optional | The name this battery's setpoints go out under, for your automation to match on. |
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

### The control key: watched vs. steered

**Control key** is what turns a battery from something watched into something
steered. Leave it empty and the battery still appears on the dashboard, still
counts as part of the house, and simply never gets told what to do — a supported
state, not an unfinished one.

Elias ems does not write to your battery. Every setpoint goes out as a Home
Assistant event called `elias_ems_setpoint`, and **an automation you write turns
that into whatever your inverter wants**. The control key is the name this
battery goes out under, so that automation can say which battery it is for.

Anything you can type works — `home_battery`, `garage`, `victron` — as long as
the automation matches it exactly. Pick it before you write the automation and
leave it alone afterwards: renaming it detaches the two silently.

[Writing that automation is its own page →](/guide/battery-control#connecting-the-event-to-your-battery)

**Battery control cannot be switched on until at least one battery has a control
key.** The checkbox stays disabled until then. The rule is "at least one", not
"all" — a house can reasonably have one steerable battery and one that only
reports.

::: warning Upgrading from a version with a "Target power" field
Earlier versions wrote the setpoint straight to an entity. Batteries configured
that way come across as **watched, not steered**, and the target entity is
forgotten — nothing is listening for the new event until you write the
automation, so carrying them across as steered would be a claim that isn't true.
Fill in a control key, write the automation, then switch control back on.
:::

### Power limits

The two optional caps stop the strategy asking a battery for more than its
inverter can deliver. Both are **positive magnitudes** — `5000`, not `-5000` for
discharge.

Leave them empty and that direction is **uncapped**: there is no entity to read
a rating off any more, and guessing one from the capacity would be a guess about
your hardware. The charge window still applies either way — an uncapped battery
is not an unprotected one, it is one that may be asked for more watts than its
inverter can deliver.

Fill them in if your inverter's rating is lower than what the meter can swing
by, which for most houses it is.

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
| **Enabled** | off | Disabled until a battery has a control key. |
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
its state of charge, and each tick that decided something ends in a `Published:`
line.

Then check the other end. Developer Tools → **Events** → listen to
`elias_ems_setpoint` shows exactly what your automation is being handed, and the
automation's own trace shows what it did with it.

If the log looks right but nothing physically happens, read
[Battery control](/guide/battery-control#connecting-the-event-to-your-battery) —
a missing automation, a mistyped key or an inverter that needs its mode set are
the three usual answers, and Elias ems cannot tell them apart from where it
stands.

## Next

[The dashboard →](/guide/dashboard)
