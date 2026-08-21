# PV curtailment

The goal is one sentence: **when exporting a kWh costs you money, stop
exporting it** — but keep making the ones the house is actually using.

Negative day-ahead prices are now normal on sunny, windy afternoons across much
of Europe. On a dynamic tariff that means every kWh your panels push onto the
grid is one you *pay* to give away. Curtailment holds the arrays back to roughly
what your house and its battery can absorb, and lets the rest go unmade.

Every few seconds the add-on reads the grid meter, your arrays and the current
price, works out what each array should be limited to, publishes that as a Home
Assistant event, and records both halves in the [diagnostics
log](/guide/diagnostics).

**It does not touch your inverter itself.** Each curtailable array gets its own
event, named after its title — `elias_ems_south_roof_pv_limit` — and an
automation you write turns it into whatever your inverter wants. See [Connecting
the event to your inverter](#connecting-the-event-to-your-inverter), which is
the step that makes any of this do something.

## What you need first

Three things, and the settings page will not let you enable curtailment without
the first two:

1. **At least one PV array marked curtailable**, with its inverter's rated AC
   power filled in. See [below](#the-rating-and-why-you-have-to-type-it-in).
2. **[Dynamic prices](/guide/prices) configured**, including a production
   formula that reflects your contract. Curtailment decides on what a kWh
   *earns*, and only you know that.
3. **The grid sensor configured.** Without it there is nothing to balance
   against, and the log will say so.

## How much is it allowed to make?

The rule is short:

```
allowed = what the arrays are making now + how far the meter is from your target
```

If you are making 4 kW and exporting 2 kW, the house is using 2 kW — so 2 kW is
what the arrays may make. If the kettle then goes on and the meter swings to
importing 500 W, the limit rises by exactly 500 W on the next tick.

**You do not have to tell it what your house is using, and it never needs to know
what your battery is doing.** Both are already inside the meter reading. That
also makes it self-correcting: any decision that under- or over-shoots leaves the
meter off target, and the next tick asks for the difference.

### Your battery gets the surplus first, automatically

If [battery control](/guide/battery-control) is also on and the battery has room,
it soaks up the surplus and drives the meter towards zero — so curtailment sees
nothing to cut and cuts nothing. Only when the battery is **full, or already at
its power limit**, does the surplus reach the meter and get curtailed.

That is the right order — charging at a negative price is better than throwing
the energy away — and it happens on its own. Nothing needs configuring to get it.

## The rules

1. **If a kWh put on the grid earns at or above your threshold, nothing is
   curtailed.** Everything generates freely.
2. If it earns less, and the meter is more than the **deadband** away from your
   grid target, and it has stayed that way for the **settle time**, the limits
   move.
3. Each array's share is proportional to **what it is generating right now** —
   an east array at 200 W and a south array at 4 kW should not be cut equally.
4. No array is ever taken below the **minimum limit**.
5. Limits are commanded in **whole percent** of the inverter's rating, so one
   step is a hundredth of that number.

## The settings

| Setting | Default | What it does |
| --- | --- | --- |
| Curtail below | `0` | Curtail while a kWh put on the grid earns less than this |
| Grid target | `0 W` | Where to aim the meter. Negative keeps a little export, positive keeps a little import |
| Deadband | `50 W` | How far off target before anything moves |
| Minimum limit | `5%` | The lowest an array is ever taken to |
| Settle time | `30 s` | How long the meter must stay off target first |

### Curtail below

This is applied to **what a kWh actually earns you**, with your production
formula already applied — not the raw exchange price.

That distinction matters more than it sounds. If your contract charges an
injection fee, a spot price of +0.09 can still mean you *lose* 0.06 per exported
kWh. The exchange price would say "all fine"; what you are paid says otherwise,
and that is the number this compares.

Leave it at `0` for "curtail only when exporting actually costs money". Raise it
if your contract has a per-kWh fee that makes the break-even sit above zero.

### Grid target

Where to aim the meter while curtailing, signed the way the dashboard shows it:
positive is importing, negative is exporting.

`0` means balanced. If you would rather err on one side, this is the dial:

- **Negative** (say `-100 W`) keeps a little export as insurance against dipping
  into import at the buying price.
- **Positive** (say `+100 W`) keeps a little import as insurance against
  exporting at a negative price.

Which is cheaper depends entirely on your contract, so there is no sensible
default other than zero.

### Minimum limit — don't set this to 0

It is tempting to set this to zero for "curtail completely". Don't.

An array held at 0% generates nothing. Generating nothing keeps the meter where
it is. And the meter staying where it is keeps the limit at 0% — so it would
never come back up on its own, including at dawn the next morning. The floor is
what breaks that cycle.

Some inverters also shut their MPPT down entirely at 0% and take minutes to
restart, which is a second reason to leave a few percent in.

### Settle time

How long the meter has to stay off target before anything moves, in either
direction. This is mostly what stops curtailment fighting your battery: the
battery takes a few seconds to ramp, and without the wait the surplus would be
curtailed just before the battery got to it, then handed back.

Thirty seconds is nothing against a fifteen-minute price slot.

## The rating, and why you have to type it in

Inverters take curtailment as a **percentage of their rated AC output**, so the
add-on needs to know that number. There is nowhere to read it from — a power
sensor doesn't publish its own rating, and guessing it from the highest reading
ever seen would be wrong after a cloudy week and would change what "1%" means
from one day to the next.

It is on the settings page beside each PV array, next to the tickbox that makes
the array curtailable at all. Leave the box unticked for an array you want on the
dashboard but never held back — it still counts towards what the house is
generating.

Note that the percentage is **of the rating, not of what the array could make
right now**. 70% at noon is a real cut; 70% at dusk does nothing.

## Connecting the event to your inverter

Nothing happens until an automation listens. Each curtailable array publishes
`elias_ems_<array>_pv_limit` carrying:

| Field | What it is |
| --- | --- |
| `limit_percent` | The limit, in whole percent of the rating |
| `limit_w` | The same limit in watts |
| `rated_power_w` | What the percentage is of |
| `released` | `true` when the add-on is letting go, not steering |
| `slug`, `array_id`, `title` | Which array it is for |

Both `limit_percent` and `limit_w` are there because inverters disagree about
which they want — use whichever suits yours.

```yaml
automation:
  - alias: South roof curtailment
    trigger:
      - platform: event
        event_type: elias_ems_south_roof_pv_limit
    action:
      - service: number.set_value
        target:
          entity_id: number.inverter_export_limit
        data:
          value: "{{ trigger.event.data.limit_percent }}"
```

::: tip `released` is worth branching on
The limit is 100 both when the price is fine and when the add-on is stepping
out of the way entirely. If your inverter needs a limit register *cleared*
rather than set to 100, use `released` to tell the two apart.
:::

::: warning Renaming an array renames its event
The event type is built from the array's title, and Home Assistant has no idea
the two names were ever related — an automation listening for the old one simply
stops hearing anything. The settings page warns you while you are typing.
:::

### How often you'll see these events

Rarely, by design. An event goes out when a limit is **new**, when it
**changes**, and when your array turns out **not to be obeying it** — and at no
other time. A limit that stands unchanged and is being honoured is silent,
however long it stands, so a quiet sunny afternoon produces one event and then
nothing. Your Home Assistant activity log stays readable.

That last case is worth knowing about, because it is the closest thing the
add-on has to a check that any of this is working. It cannot see whether your
automation ran — but it *can* see your array's power. If the array is generating
well above the limit it was given, then whatever was sent did not take, and the
add-on says so in the [diagnostics log](/guide/diagnostics) as a warning:

```
Published: South roof → 40% (restated — the array is not obeying it)
```

If you see that, the usual causes are a missing automation, one still listening
for an array's old name, or an inverter that accepts the value and ignores it.
It re-asserts at most every five minutes, so a broken setup is a slow drip in
the log rather than a flood.

::: tip What it still cannot see
The reverse case — your array left *curtailed* when it should be free — is
invisible to it. Working out that an array is producing less than it could would
mean knowing what it could produce, which nothing here can. This is why
everything the add-on is unsure about releases the arrays rather than holding
them back.
:::

## When it stops curtailing

**Anything the add-on is unsure about ends with your panels generating**, never
held back. Specifically, the arrays are released to 100% when:

- the price is at or above your threshold — the ordinary case;
- the price can't be read at all;
- the grid sensor can't be read;
- an array's own power sensor can't be read (that array only — the rest carry on
  correctly);
- you switch curtailment off, or remove the array, or untick it;
- the add-on is shut down or updated.

This is the opposite of what [battery control](/guide/battery-control) does when
it goes blind, and deliberately so. A battery left forcing power is obviously
wrong; an array left pinned at 10% just quietly loses you most of a sunny day
with nothing on the dashboard looking amiss.

::: warning What it can't protect you from
A hard crash, a power cut, or a container the Supervisor destroys without asking
leave no time to publish anything. If your inverter supports a limit that expires
on its own, that is the real safety net.
:::

## Two things to check on your hardware

- **Hybrid inverters**, where the panels and the battery share one unit: a PV
  limit may also block the battery from charging, which is exactly backwards.
  Worth testing before you run both features together.
- **Not every inverter exposes a limit at all.** Curtailment is much less
  commonly available than a battery charge setpoint, and the add-on cannot tell
  whether anything acted on the event it sent — see
  [troubleshooting](/guide/troubleshooting).
