# PV curtailment

The second thing the add-on acts on: while a kWh put on the grid earns *less
than it costs to make*, hold the arrays back to roughly what the house and its
battery can absorb, so nothing is exported at a price you have to pay.

**It decides, publishes, and logs**, exactly as [battery
control](battery-control.md) does. Each tick works out what percentage of its
rating every curtailable array should be limited to, publishes that as a Home
Assistant event, and records both the decision and what went out. It does not
touch the inverter itself: an automation you write listens for the event and
turns it into whatever your hardware wants — see [Connecting the event to an
inverter](#connecting-the-event-to-an-inverter).

Tracked in [issue #2](https://github.com/elias-ems/elias-ems/issues/2).

## What you configure

### The arrays — `pv-entities.json`

Curtailment adds two fields to a PV array. The rest of the record is what the
dashboard already used.

| Field | Label in the UI | Meaning |
| --- | --- | --- |
| `curtailable` | Allow curtailing this array | Whether a limit may ever be published for it |
| `ratedPowerW` | Inverter rated power (W) | The inverter's rated AC output |

**The rating has to be typed in, because there is nowhere to read it from.** A
power sensor publishes no rating, and taking the highest value ever observed
would underestimate it after a cloudy week — which would quietly change what
"1%" means from one day to the next. It is the same reasoning that puts a
battery's `maxChargePowerW` in settings rather than deriving it.

An array is only steerable when **both** are set: ticked, and with a rating
above zero. Ticked with the rating left blank is a half-finished form, and the
settings page rejects it rather than dividing by null later.

An array left uncurtailable is still part of the house — it appears on the
dashboard and its generation still counts — it is simply never held back. That
is a supported configuration, not an unfinished one: one steerable inverter and
one that only reports is an ordinary installation.

Titles now have to be unique after slugification, for the reason [battery
titles do](battery-control.md): the title is what the event type is built from,
so "South roof" and "south-roof" would be two arrays taking each other's limits
with nothing anywhere reporting a problem.

### The feature — `curtailment.json`

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | |
| `priceThresholdPerKwh` | `0` | Curtail while the **production** price is below this |
| `gridTargetW` | `0` | Where to aim the meter, signed as the grid reading is |
| `deadbandW` | `50` | How far off target before the limit is moved |
| `minLimitPercent` | `5` | The lowest an array is ever taken to |
| `settleSeconds` | `30` | How long the meter must stay off target first |

Two of those need saying out loud.

**The threshold applies to the production leg with your contract applied**, not
to the raw exchange price. A dynamic tariff is a different formula in each
direction (see [dynamic prices](dynamic-prices.md)), and an injection fee can
make a *positive* spot price into a negative earning. What decides whether
exporting a kWh is worth doing is what that kWh actually earns, which is the
number the production formula produces. The threshold is configurable rather
than a hardcoded zero so that a contract whose break-even sits above zero can
say so.

**`minLimitPercent` is not a preference.** See [the fixed point at
zero](#the-fixed-point-at-zero) — without a floor the arithmetic has a trap it
cannot climb out of.

Curtailment cannot be enabled without a curtailable array *and* a configured
price source. Both would otherwise produce a loop that decides correctly and
changes nothing, which looks identical from the outside to one that is broken.

## The arithmetic

Sign conventions as everywhere else: `G` is the grid reading (positive
importing), `C` is what the **curtailable** arrays are generating, `N` is what
every other array is generating, `L` is the load and `B` is the battery
(positive charging).

The house balances as

```
G + C + N = L + B
```

Leaving `L`, `B` and `N` exactly where they are, the curtailable generation that
would put the meter at `gridTargetW` satisfies the same equation with
`G_target` in place of `G`. Subtracting one from the other gives the whole
strategy:

```
C_allowed = C + (G - G_target)
```

*What the arrays we can command are making now, plus however far the meter is
from where we want it.*

**The load, the battery and the uncurtailable arrays all cancel out.** The
add-on never measures the load and never reasons about what the battery is
doing — both are already inside the grid reading. It is the same feedback form
as `S = C - net` in [net-zero.ts](../../addon/app/lib/net-zero.ts), with the
same property: a wrong answer this tick is corrected on the next one instead of
accumulating.

`N` cancelling is the part that is easiest to get wrong. An array nobody can
command is still generating, and its output is *already* in `G`; counting it
into `C` as well would ask the arrays we can command to give up what it is
producing on top of what the meter actually shows.

### Worked through

A 5 kW array making 4 kW, the meter exporting 2 kW, target 0:

```
C_allowed = 4000 + (-2000 - 0) = 2000 W  →  40% of 5000 W
```

The house is using 2 kW, so 2 kW is what it may make. On the next tick, if the
kettle goes on and the meter reads +500 W with the array held at 2 kW:

```
C_allowed = 2000 + (500 - 0) = 2500 W  →  50%
```

The limit rises by exactly the shortfall the meter showed.

### Why the battery gets first refusal, for free

If battery control is on and the battery has room, it soaks up the surplus and
drives `G` towards zero — so curtailment computes `C_allowed ≈ C` and cuts
nothing. Only once the battery is full or at its power limit does the export
appear on the meter, and only then is anything thrown away.

Charging at a negative price before curtailing is the right order, and it falls
out of the arithmetic rather than needing to be coordinated between the two
features.

The gap is the few seconds before the battery ramps, where the surplus is on the
meter but about to be taken. That is what `settleSeconds` is for: the meter has
to stay off target for that long before the limit moves at all, in **either**
direction — handing generation back the instant a kettle switches off would be
just as twitchy, and a few seconds either way is cheap against a fifteen-minute
price slot.

## Percent, not watts

Inverters take curtailment as a percentage of rated AC output, so that is what
goes out, quantised to whole percent. Two consequences are worth being explicit
about.

**The percentage is of the rating, not of what the array could make right now.**
70% at noon is a real cut; 70% at dusk does nothing at all. What is published is
a ceiling, not a scaling.

**Measured generation under a ceiling says nothing about potential.** An array
pinned at 1 kW might be capable of 1.1 kW or of 5 kW, and there is no way to
tell from here. This is why the limit is only ever moved by the feedback term —
which asks for exactly the shortfall the meter shows — and never computed from
what the array "should" be able to do.

Quantising to whole percent is also what makes a publish deadband unnecessary.
A battery target is a continuous number of watts, so
[targets.server.ts](../../addon/app/lib/targets.server.ts) needs
`PUBLISH_DEADBAND_W` to stop a 4 W drift firing an event every tick; here "the
value changed" already means "it moved by at least one step". One percent of a
5 kW inverter is 50 W — the same order as the battery deadband, arrived at by
rounding rather than by comparison.

### Splitting across arrays

Each array's share is proportional to **what it is generating right now**, not
to its rating. An east array at 200 W and a south array at 4 kW should not be
cut equally, and a rating-proportional split would hand the small one a limit it
cannot reach while cutting the large one past what was asked for.

When nothing is generating at all — at night, or with every array already at the
floor — that split would be 0/0, and the fallback is rating-proportional
instead.

## The fixed point at zero

`C_allowed = C + (G - G_target)` has a trap. A dark array, an idle house and a
meter reading zero give `C_allowed = 0`, so the limit goes to 0%, so the array
stays dark, so the meter stays at zero. Nothing in the arithmetic ever lifts it
out again, and at dawn the array would simply not come back.

`minLimitPercent` is what breaks the cycle, which is why its default is not
zero. It is independently a hardware requirement on inverters whose MPPT drops
out entirely at 0% and takes minutes to restart.

## Failing open

**Every way of not knowing ends with the arrays generating.** This is the
opposite of battery control, where the safe value when blind is 0 W, and the
asymmetry is deliberate:

- A battery left forcing kilowatts because the meter it was following went
  unreadable is visibly, immediately wrong.
- An array left pinned at 10% because a price entity went quiet loses most of
  every sunny day afterwards, and **nothing on the dashboard looks wrong**. It
  is the quieter failure, and the one worth being most careful about.

So the arrays are released — 100%, with `released: true` — when:

| Situation | Why |
| --- | --- |
| The production price is unknown | A price we cannot read is not a negative price |
| The price is at or above the threshold | The ordinary case: nothing to curtail |
| The grid sensor is unreadable | Nothing to balance against |
| Curtailment is switched off | |
| An array stops being curtailable, or is removed | Nothing will ever decide for it again |
| The add-on is asked to stop (`SIGTERM`/`SIGINT`) | |

One case is finer-grained: **an array whose own power reading is missing is
released, and the others carry on correctly.** Assuming zero for it would not
self-correct — it understates `C`, so `C_allowed` comes out low, so the array is
cut; the cut shows up as import, which raises `C_allowed`, but only back to the
same understated fixed point. The array would settle at the floor with the house
importing to cover it, quietly and indefinitely. Dropping it out instead makes
it one of the arrays that cancel, which leaves the arithmetic exact for
everything else.

An array removed or un-ticked is released from the record as it was *before* the
change — an array that has just been deleted is no longer on disk to look up,
and one whose rating has just been cleared no longer carries the number its limit
was a percentage of.

As with battery control, none of this survives `kill -9`, a power cut, or a
container the supervisor destroys without asking. The only real answer to those
is an inverter whose limit expires on its own.

## Connecting the event to an inverter

One event type per array, named after its title:

```
elias_ems_<array>_pv_limit
```

with

| Field | Meaning |
| --- | --- |
| `slug` | The array's slug, repeated for an automation listening to several types |
| `array_id` | The stored record's id |
| `title` | The array's name, as on the settings page |
| `limit_percent` | The limit, whole percent of the rating |
| `limit_w` | The same limit in watts |
| `rated_power_w` | What the percentage is of |
| `released` | True when the add-on is stepping out of the way, not steering |

Both `limit_percent` and `limit_w` are there for the reason the battery event
carries `charge_w` and `discharge_w` beside its signed value: some inverters
take a percentage of nameplate and others an export setpoint in watts, and
neither automation should have to do arithmetic that is easy to get wrong.

`released` matters more than it looks. The percentage is 100 either way, but an
automation that has to *clear* a limit register — rather than write 100 into it
— needs to tell "generate everything" from "I am no longer in charge of you".

```yaml
automation:
  - alias: South roof curtailment
    trigger:
      - platform: event
        event_type: elias_ems_south_roof_pv_limit
    action:
      - choose:
          - conditions: "{{ trigger.event.data.released }}"
            sequence:
              - service: number.set_value
                target: { entity_id: number.inverter_export_limit }
                data: { value: 100 }
          - conditions: "{{ not trigger.event.data.released }}"
            sequence:
              - service: number.set_value
                target: { entity_id: number.inverter_export_limit }
                data: { value: "{{ trigger.event.data.limit_percent }}" }
```

### When an event is sent, and when it isn't

A limit goes out when it is **new**, when it **changes**, and when the array
turns out **not to be obeying it** — and at no other time. A limit that stands
unchanged and is being honoured is silent, however long it stands.

That last clause used to be a 30-second timer instead, and it was a mistake:
injection prices are positive for most of the year, so an array spends almost
all of its life released at 100% with nothing to say, and the timer turned that
into some 2,880 identical events per array per day. Every one of them lands in
Home Assistant's activity log, which is where somebody is trying to read what
actually happened in their house.

But it could not simply be deleted, because of what it was quietly covering.
There is no read-back — an event on the bus is not proof anything acted on it —
and the strategy **cannot tell an obeyed limit from an ignored one**:

|  | curtailable output | meter | `C + (G - G_target)` |
| --- | --- | --- | --- |
| Limit honoured | 2000 W | 0 W | 2000 W → 40% |
| Inverter forgot it | 4000 W | −2000 W | 2000 W → 40% |

Identical. So nothing changes, nothing is republished, and the house exports at
a negative price indefinitely with every tick reporting success.

**Measured generation is the only thing that separates them**, and
`pv-limits.server.ts` compares against it: an array making more than its limit
plus a margin — the larger of 5% of the inverter's rating and 100 W — is not
under that limit, whatever we last said. It is re-asserted at most every
`REASSERT_MS` (5 minutes), and logged as a **warning** rather than as routine
traffic, because it means an automation is missing, is listening for an old
name, or an inverter is ignoring what it was sent.

Two corollaries worth stating:

- **An array generating *under* its limit cannot be checked** — and does not need
  to be. A limit that is not binding is doing nothing either way, and the moment
  it would bind is the moment this notices.
- **A release cannot be checked at all.** An array wrongly left curtailed
  generates less than it might, and how much it might is precisely what nothing
  here can know. That remains the one silent failure.

**Renaming an array renames its event.** The settings page says so while the
rename is being typed, because nothing downstream can: Home Assistant does not
know two event types were ever related, and an automation listening for the old
one simply stops hearing anything.

## Where it runs

Curtailment shares [the control
loop](../../addon/app/lib/control-loop.server.ts) with battery control rather
than having one of its own, and shares **one snapshot per tick**. Both features
correct against the same grid meter, and two independent reads would let the two
decisions describe different instants — the same argument that makes the loop
read its stored configuration once per tick rather than once per concern.

The loop runs while *either* feature is enabled, and each tick gates its own
halves on what is stored, so switching one on or off takes effect on the next
tick rather than needing a restart. Curtailment without battery control is an
ordinary configuration — a house with panels and no battery — and so is the
reverse. The tick rate is battery control's `intervalSeconds`, which is a
ceiling on how often changes can produce a tick rather than the thing producing
them; curtailment's own pacing comes from `settleSeconds`.

Two entities join the watched set when curtailment is on: every array's power
sensor, and **the price entity**. That last one is what makes "the price just
went negative" provoke a tick with nothing anywhere polling a clock — its state
changes at every slot boundary.

## What is deliberately not here

- **Curtailment for reasons other than price** — a grid operator's feed-in cap,
  a fixed export limit. Same mechanism, different trigger.
- **Planning ahead.** Tomorrow's negative hours are known once the day-ahead
  auction clears, but this is purely reactive. That belongs with the price-aware
  battery strategies on the [roadmap](../roadmap.md).
- **Getting paid to consume** at negative prices — dumping into the battery,
  running the heat pump. That is the "battery control (negative prices)" roadmap
  item, and conflating the two would make both harder to reason about.
- **A ramp-rate limit.** The settle time already damps the loop, and the
  feedback form does not overshoot upwards: asking for more than the array can
  make simply leaves the ceiling non-binding.

## Two things to know before relying on it

- **Hybrid inverters.** Where PV and the battery share one inverter, a PV limit
  can also block battery charging — which is exactly backwards, since charging
  is what should happen first. Worth checking on your hardware before trusting
  the two features together.
- **Not every inverter exposes a limit.** Curtailment is far less universally
  available than a charge setpoint, and the add-on cannot tell whether anything
  acted on the event it published.
