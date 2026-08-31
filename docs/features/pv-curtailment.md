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

Curtailment adds four fields to a PV array. The rest of the record is what the
dashboard already used.

| Field | Label in the UI | Meaning |
| --- | --- | --- |
| `curtailable` | Allow curtailing this array | Whether a limit may ever be published for it |
| `ratedPowerW` | Inverter rated power (W) | The inverter's rated AC output |
| `controlMode` | While curtailing, this inverter | `modulating` or `stepped` — see [Inverters that cannot be written to often](#inverters-that-cannot-be-written-to-often) |
| `stepLimitPercent` | Fixed limit while curtailing (%) | `stepped` only: the one limit it is held at |

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

## Inverters that cannot be written to often

Some inverters keep their limit in RAM. An SMA Sunny Boy will take a new one
every few seconds for as long as you like, and `modulating` — the default — does
exactly that: the array follows the house continuously.

Others commit **every** write to non-volatile memory. A Huawei SUN2000 is the
common example. Following the house there would spend a real hardware budget on
a handful of negative-price afternoons a year, and there is no way to ask the
inverter for its remaining write cycles back.

So the mode is not really "may I dim this array". It is **how often may I write
to it**, and the fixed setpoint is the consequence rather than the point.

`stepped` gives such an array one command when curtailment starts and one when
it ends, and nothing at all in between:

| | modulating | stepped |
| --- | --- | --- |
| Value | recomputed every tick from the meter | `stepLimitPercent`, typed in |
| Writes per episode | as many as the house moves | **two** |
| In the feedback law | yes | no — it cancels out |
| Bands above the threshold | followed | ignored, released instead |

### Why it needs no new arithmetic

A stepped array is set to a fixed value and then left alone, which from the
modulating arrays' point of view is **exactly what an uncurtailable array already
is**: it is generating something, that something is already inside the grid
reading, and nothing is going to move it in response to the meter. So it drops
out of `C` and cancels, precisely like the `N` term:

    C_allowed = C_modulating + (G - G_target)

Worked through — a 5 kW Huawei stepped to 0%, a 4 kW SMA modulating, house
using 1.5 kW:

| | Huawei | SMA | meter |
| --- | --- | --- | --- |
| Before | 4000 W | 3000 W | −5500 W |
| After the one dim write | 0 W | 3000 W | −1500 W |
| Next tick: `3000 + (−1500)` = 1500 W → SMA to 38% | 0 W | 1500 W | ≈ 0 W |

The SMA absorbs the Huawei's disappearance automatically, because the Huawei was
never anything to it but a number inside `G`.

### Where the writes are kept down

Four things would otherwise spend them, and each is handled:

- **The value moving.** It cannot: the step is a number that was typed in, and
  it does not depend on the meter.
- **The bands.** `soft-ceiling` and `graded-export` move their target as the
  price crosses a band edge, which would be several writes a day. A stepped
  array therefore **ignores bands entirely and behaves as `threshold`**,
  whatever the house strategy is — it takes its step below the threshold and is
  released above it. A band is a gradation and a stepped inverter has none to
  offer, so holding it back for a kWh that still earns something is the worse
  trade.
- **Being off target in the wrong direction.** The step is taken against
  **export**, not against being off target either way. Importing past the target
  means the house is swallowing everything, so there is nothing being sold at a
  loss — and once stepped, that same test is what leaves the array down rather
  than handing it back the moment a load switches on. It stays down until the
  price recovers.
- **Re-assertion.** An array visibly ignoring its limit is normally restated
  every `REASSERT_MS` for as long as it keeps ignoring it. For a stepped
  inverter that is a few hundred writes across an afternoon, spent on an
  automation that is not going to start working on its own — so it is said at
  most `MAX_STEPPED_REASSERTS` times and then only *logged*. The warning
  continues on every tick. **Observe always, write rarely.**

A surplus the battery is quietly absorbing never costs a write either: the meter
stays inside the deadband, so the decision is never reached. Nor does an export
the battery's own **discharge** accounts for: the export test is on the same
`offBy` the modulating arrays use, so [the battery
term](#the-battery-free-when-it-charges-not-when-it-discharges) is in it here
too. An export a battery is causing is that battery's to stop, and spending a
write to hide it — by holding this array down so the battery can empty in its
place — would make the wrong trade twice over.

### What it costs

Two things, both accepted deliberately.

**Self-consumption during an episode.** A stepped array stays down for the whole
negative-price window even if a large load arrives that could have used it. Since
the value is one number on the settings page, somebody who knows their afternoons
can simply set it higher.

**A write per add-on restart.** Nothing about what was published is persisted —
see the note on the `published` map — so a restart republishes on the first
tick. One write per restart is nothing against an endurance budget, and the
alternative is a persisted state that a crash could quietly turn into a lie.

### Two ways it is deliberately unlike a modulating array

- **A missing power reading does not release it.** A modulating array is released
  when its own sensor goes quiet, because assuming a number would corrupt the
  feedback law. A stepped array is commanded with a number that was typed in, so
  the reading is not in the way — and releasing it over a sensor blip would spend
  a write on the very hardware the mode exists to protect.
- **`minLimitPercent` does not clamp the step.** That floor keeps the feedback
  law out of [its fixed point at zero](#the-fixed-point-at-zero), and a stepped
  array is not in that loop. The separate hardware reason — an MPPT that drops
  out at 0% — is real, so the settings page warns rather than silently raising
  what was typed.

A stepped array marked curtailable with no step configured is **held and never
commanded**. Falling back to modulating it would do the one thing the mode exists
to prevent.

### The feature — `curtailment.json`

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | |
| `strategy` | `threshold` | What happens in the band *above* the threshold — see [Strategies](#strategies) |
| `bands` | 1c/2c/3c | Three steps of that band, ascending. Ignored by `threshold` |
| `priceThresholdPerKwh` | `0` | Curtail while the **production** price is below this |
| `gridTargetW` | `0` | Where to aim the meter, signed as the grid reading is |
| `deadbandW` | `50` | How far off target before the limit is moved |
| `minLimitPercent` | `5` | The lowest an array is ever taken to |
| `settleSeconds` | `30` | How long the meter must stay off target first, and the shortest time between two moves after that |
| `carChargingEntityId` | — | A binary sensor that is on while a car wants charge — see [A car charging on solar](#a-car-charging-on-solar) |
| `chargerPowerW` | `0` | What that charger can take at full rate |

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
every other array is generating, `L` is the load and `B` is the batteries
(positive charging).

The house balances as

```
G + C + N = L + B
```

Leaving `L` and `N` exactly where they are, the curtailable generation that
would put the meter at `gridTargetW` with the batteries at `B_target` satisfies
the same equation with `G_target` and `B_target` in place of `G` and `B`.
Subtracting one from the other gives the whole strategy:

```
C_allowed = C + (G - G_target) + (B_target - B)
```

*What the arrays we can command are making now, plus however far the meter is
from where we want it, plus whatever a battery is delivering that the sun could
deliver instead.*

**The load and the uncurtailable arrays cancel out.** The add-on never measures
the load — it is already inside the grid reading. It is the same feedback form
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

### The battery: free when it charges, not when it discharges

`B_target` is `min(B, 0)`. Never discharging, and never a *demand* to charge
either — so the term is the net discharge, added back, and nothing else:

```
C_allowed = C + (G - G_target) + max(0, -B)
```

**A charging battery cancels out and gets the surplus for free.** If battery
control is on and the battery has room, it soaks up the surplus and drives `G`
towards zero — so curtailment computes `C_allowed ≈ C` and cuts nothing. Only
once the battery is full or at its power limit does the export appear on the
meter, and only then is anything thrown away. Charging at a negative price
before curtailing is the right order, and it falls out of the arithmetic rather
than needing to be coordinated between the two features.

**A discharging battery does not cancel, and treating it as though it did hid a
fixed point.** `G` is what crosses the meter *after* the battery has covered the
house, so a battery stepping in makes the meter read balanced while the house is
in fact short of exactly what the battery is delivering. The feedback term goes
to zero, the limit stops rising, and the arrays stay pinned at whatever they were
last cut to — while the battery empties into a house the sun was standing by to
supply for nothing.

The two features hold each other there indefinitely, and each is behaving
correctly on its own terms:

| What acts | What follows | The meter then |
| --- | --- | --- |
| Curtailment cuts the arrays | the house is short | swings to import |
| Net-zero covers the import | the battery discharges | comes back to zero |
| Curtailment sees a balanced meter | nothing to correct | **and the limit never moves again** |

Once something else is holding the meter, *every* level of PV is an equilibrium.
That is what makes it a fixed point rather than a slow drift, the same shape of
trap as [the one at zero](#the-fixed-point-at-zero) — and it is exactly as
invisible, because the dashboard shows a balanced house throughout.

Adding the discharge back is what makes `G - G_target` mean the same thing
whether or not a battery is in the way: it is the shortfall the meter *would*
have shown had none stepped in. Worked through, with two arrays pinned at 424 W
between them, the meter at −9 W and the battery giving out 1,959 W:

```
C_allowed = 424 + (-9 - 0) + 1959 = 2374 W  →  24% of 10 kW
```

The arrays take the house over, the battery stops being asked for anything, and
nothing about the meter changed to prompt it.

Four things about that term:

- **Every configured battery counts, steered or not**, and they are netted
  against each other rather than summed. This is physics rather than authority:
  an inverter running its own self-consumption logic needs no automation to
  start covering the load, and hides the same watts while it does. One battery
  charging at 2 kW beside one discharging at 2 kW is contributing nothing
  between them.
- **Nothing is commanded to the battery.** This only stops the arrays being held
  down, and a limit is a ceiling — raising one an array cannot reach does
  nothing at all, which is why a dark array on a winter evening is left
  undisturbed by the battery carrying the house.
- **The battery yields on its own.** As the arrays take the house over, the
  surplus reaches whatever is steering the battery — net-zero, or the inverter's
  own self-consumption — and it stops discharging. Neither feature has to be
  told about the other; they converge over a tick or two, with the battery's
  loop the fast one and `settleSeconds` pacing the slow one.
- **A battery whose power sensor is quiet counts as not discharging**, which
  under-credits rather than over-credits, and is logged as a warning. The
  arrays stay where the meter alone would put them rather than being handed an
  allowance built on an invented number.

The one case this does not fix is a battery being **forced** to discharge into a
negative price, by a schedule that is not looking at the price. It exports what
it discharges rather than yielding, and the log says so:

```
! the battery is discharging 1500 W into a house the arrays already cover —
  that is what is going out of the meter
```

Cutting the arrays back *would* stop that export — by draining the battery to
displace free generation, which is the trade the whole term exists to refuse. So
it is reported rather than acted on. Expect it for a tick or two whenever a
battery is in the middle of yielding; a standing one means something is forcing
the discharge, and that is where to go and look.

The gap is the few seconds before the battery ramps, where the surplus is on the
meter but about to be taken. That is what `settleSeconds` is for: the meter has
to stay off target for that long before the limit moves at all, in **either**
direction — handing generation back the instant a kettle switches off would be
just as twitchy, and a few seconds either way is cheap against a fifteen-minute
price slot.

**The same wait applies after each move, not only before the first one.** That
is the part it is easy to leave out, and leaving it out is worse than having no
settle time at all. `C_allowed = C + (G - G_target)` is only self-consistent
when `C` and `G` describe the same instant, and for a few seconds after a limit
goes out they do not: the inverter is still ramping to it, and the grid and PV
sensors do not update on the same clock. A loop that measures again straight
away is reading its own correction half-applied and correcting a second time for
the same watts. Left that way it dithered a percent at a time while the house
was quiet, and swung by tens of percent while it was not — the overshoot the
feedback form is otherwise not supposed to have.

### A car charging on solar

A charger steered by evcc in solar mode is a **meter-following load**.
Curtailment is a meter-following source limiter. Both drive the meter to their
own target, and whichever arrives first leaves the other with nothing to see.

That is curtailment, because `settleSeconds` is shorter than any charger's ramp
— and what it arrives at is not a transient but a stable equilibrium:

| What acts | What follows | The meter then |
| --- | --- | --- |
| Curtailment cuts the arrays | the surplus disappears | comes back to target |
| evcc sees no surplus | the car never enables | stays on target |
| Curtailment sees a balanced meter | nothing to correct | **and the limit never moves again** |

It is the same fixed point as [the discharging
battery](#the-battery-free-when-it-charges-not-when-it-discharges), with the
flexible thing on the load side of the meter. It is a one-way ratchet even when
the car *is* charging: every downward nudge is permanent, because raising the
limit again requires seeing import, and preventing import is exactly evcc's job.

**The battery case was fixable inside the arithmetic and this one is not.** A
discharging battery's contribution can be measured, so it can be added back. A
load throttled to nothing cannot: it is indistinguishable from a load that was
never there, in the same way [an array pinned at 1 kW](#percent-not-watts) is
indistinguishable from one that could make 5 kW. No term added to `C_allowed`
recovers it, so the fact that a car wants the surplus has to arrive from outside
the loop. That is what `carChargingEntityId` is.

**It has to say that a car *wants* charge, not that one is charging.** A sensor
of the second kind cannot open this at all, because curtailment is precisely
what stops the charging from starting. In evcc's terms that is a vehicle
connected and below its target, not the loadpoint's charging flag.

#### A floor, not an allowance

While the sensor is on, the combined limit gets a floor under it:

```
C_allowed >= chargerPowerW - (everything generating that we are not modulating)
```

The subtraction is what keeps it honest. An uncurtailable array, or a stepped
one holding its step, is already feeding the charger, and asking the modulating
arrays for the charger's whole appetite on top of that would export the
difference at the price this feature exists to avoid.

A floor rather than an allowance on the *target* for the same reason. The car's
current draw is already inside the grid reading, so moving the target by the
full `chargerPowerW` would ask the arrays for it a second time — and a house
whose car is drawing its full rate with the meter balanced would end up
exporting exactly what the car consumes.

It is applied as a **moved target**, the same rearrangement
[`graded-export`](#graded-export) makes, so the deadband, the settle rule, the
generation-proportional split and `minLimitPercent` all keep working with
nothing downstream needing to know. And it is only ever taken when it is *lower*
than the target already in force, which makes the direction one-way: a car can
release generation and can never be the reason any is held back.

Two properties worth being explicit about:

- **It under-allows by the house load, deliberately.** The charger's appetite is
  a number somebody typed in; the house's is not. The error is in the direction
  of exporting less than it might, which is the cheap direction here.
- **A charger bigger than the arrays means no curtailment at all**, and that
  falls out rather than being special-cased: the floor lands above anything the
  arrays could make, so every one of them is released.

#### Stepped inverters, and why the test is on the ratings

A stepped array is not in the feedback law, so the floor cannot reach it. It is
released outright while a car is charging — but only when the charger can take
more than the **combined rating of the modulating arrays**.

That test is made from the ratings alone, with no reading anywhere in it, and
that is the point rather than an approximation. A test built on generation would
flip a write-averse inverter every time a cloud crossed the boundary, which is
the budget [`stepped`](#inverters-that-cannot-be-written-to-often) exists to
protect. This one can only change when somebody edits the settings page, which
makes it **two writes per car** — one to release, one to take the step back —
and it is answerable in a sentence on that page: *your charger can take more
than the modulating arrays can make, so the stepped ones come up too.*

When it is false the stepped arrays keep their step and the modulating ones
carry the charger, which is the right trade the other way round: releasing a
5 kW inverter to feed a 3.7 kW charger exports the difference and spends two
writes doing it.

#### Under a soft ceiling

[`soft-ceiling`](#soft-ceiling) never reads the meter, so it has no target for a
charger's appetite to move and no way to hand a car *just enough*. The only
thing it can do for one is get out of the way, and it does: while the sensor is
on, its bands release rather than cap. In the marginal band that is the easy
trade — the choice is between selling a kWh for very little and putting it in a
car for nothing.

#### Worked through

Two 5 kW inverters, one modulating and one stepped to 0%, an 11 kW charger, and
the house pinned at its 500 W load with the meter balanced — the fixed point
above, exactly where nothing would ever move again:

| | modulating | stepped | meter |
| --- | --- | --- | --- |
| Pinned | 500 W | 0 W | 0 W |
| Floor: `11000 - 0` = 11000 W | | | |
| Target: `0 + 500 - 11000` | | | −10500 W |
| `C_allowed = 500 + 10500` = 11000 W → 220% → **100%** | 5000 W | released, **100%** | −9500 W |

Both inverters go to 100%, the surplus appears, and evcc has something to chase.
`11000 > 5000` is what brings the stepped one up with it.

## Strategies

The threshold splits the day in two, and everything above says *"a kWh put on
the grid earns something"*. But 0.1c and 6c are both above it, and treating them
the same is the crude part of the rule: it sells the marginal kWh as eagerly as
the valuable one.

A strategy is what happens in that marginal band. **Below the threshold every
strategy does the same thing** — the feedback law above, aimed at `gridTargetW`
— and they differ only between "exporting is costing me money" and "exporting is
clearly worth it".

| | Reads the meter | Caps | Acts through |
| --- | --- | --- | --- |
| `threshold` | — | nothing | releasing everything |
| `soft-ceiling` | no | each inverter, as % of its own rating | a fixed limit per band |
| `graded-export` | yes | what may cross the meter | the same feedback law, on a moved target |

`threshold` is what the feature shipped with and stays the default, so an
existing installation behaves exactly as it did until somebody chooses
otherwise.

### The bands

Three of them, each an offset **above** `priceThresholdPerKwh`, ascending. A
price falls in the first band whose edge it is *under*; one past the last edge is
released outright. The default shape, and the reason it runs the way it does:

| Above the threshold | `soft-ceiling` cap | `graded-export` allowance |
| --- | --- | --- |
| 0 – 1c | 70% | 33% |
| 1 – 2c | 80% | 67% |
| 2 – 3c | 90% | 100% |
| over 3c | released | released |

**Looser as the price rises**, which is the direction that pays. The band nearest
the threshold is where a kWh is worth least, so it is the one held back hardest;
by 3c above, exporting is worth enough not to interfere with.

Edges are exclusive at the top for a reason worth stating: a price sitting
exactly on 1c belongs to the 1–2c band. Were the edge inclusive, two neighbouring
bands would both claim it and the first would win by accident of iteration order,
which is a coin toss dressed up as a rule.

Both values are percentages, and that is deliberate. The same six numbers keep
their meaning when the strategy is switched, so trying the other one for an
afternoon costs nothing; and a default in watts would have been right for a 10 kW
house and wrong for everyone else.

### `soft-ceiling`

Each inverter is capped at a percentage of **its own rating**, and the grid meter
is never read. That is the whole of it — no deadband, no settle time, no split.
The limit moves when the price moves into another band and at no other time,
which makes it the quietest of the three on the event bus.

Not reading the meter buys one real thing: it is the only strategy that still
decides when the grid sensor is unreadable, because there is nothing to balance
against and so nothing that can go wrong with the balancing.

**It is a ceiling, not a cut**, with everything [percent, not
watts](#percent-not-watts) says about that. 70% of nameplate binds around noon
and does nothing at dusk, and nothing measured afterwards would tell it the
difference. If what you want is "hold the house to roughly zero export", this is
not the strategy that does it — `graded-export` is.

### `graded-export`

One number changes and nothing else does:

```
allowance = exportPercent% × (combined rating of the arrays taking part)
target    = gridTargetW − allowance
```

and the plan carries on into the same deadband, the same settle rule, the same
generation-proportional split and the same floor. It is the same control law on a
moved target rather than a second control law, which is why nothing downstream
needed to know it exists.

A share of the *rating* rather than a number of watts, so that an array dropping
out of the plan — its power sensor gone quiet — takes its share of the allowance
with it, and the arithmetic stays exact for the rest.

This is the shape of the system this add-on was written alongside: a
`sensor.solar_injection_load_balancing` whose allowed export scaled with the
injection price, fitted across three days at `2170 W + 129,000 × price` and
clamped to the array's 10 kW — zero export at about −1.7c, unrestricted from
about +6c. Three bands are that curve in steps.

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
| A car wants the surplus | See [A car charging on solar](#a-car-charging-on-solar) — the arrays are released outright once the charger outreaches them |

**One reading is deliberately *not* failed open**: a `carChargingEntityId` that
cannot be read counts as no car, and the tick warns. Releasing on it would be
the usual rule, but it is the wrong rule here — a sensor that goes quiet would
switch curtailment off for as long as it stayed quiet, which costs money in the
one direction the feature exists to prevent. Every other unknown here loses
generation; this one would spend it.

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

Three entities join the watched set when curtailment is on: every array's power
sensor, **every battery's power sensor**, and **the price entity**. The price
entity is what makes "the price just went negative" provoke a tick with nothing
anywhere polling a clock — its state changes at every slot boundary. The
batteries are there for [the discharge
term](#the-battery-free-when-it-charges-not-when-it-discharges), and only their
power: a battery's state of charge is battery control's alone, and curtailment
decides nothing on it. Reading a battery's power does not mean commanding it —
curtailment publishes for arrays and nothing else, whether or not battery control
is even switched on.

## What is deliberately not here

- **Curtailment for reasons other than price** — a grid operator's feed-in cap,
  a fixed export limit. Same mechanism, different trigger.
- **Planning ahead.** Tomorrow's negative hours are known once the day-ahead
  auction clears, but this is purely reactive. That belongs with the price-aware
  battery strategies on the [roadmap](../roadmap.md).
- **Getting paid to consume** at negative prices — dumping into the battery,
  running the heat pump. That is the "battery control (negative prices)" roadmap
  item, and conflating the two would make both harder to reason about.
- **Telling the battery to stop discharging.** Curtailment reads what the
  batteries are doing and stops holding the arrays down in their place; it never
  commands one. Stopping the discharge outright is battery control's decision to
  make, and making it from here would mean two features writing targets for the
  same hardware on the same tick. The arithmetic does not need it: the arrays
  taking the house over is what makes the discharge stop, through whatever is
  actually steering the battery.
- **A ramp-rate limit.** The settle time damps the loop — once it is applied
  after each move as well as before the first, which is what bounds how fast the
  limit can travel. A cap on the size of a single step would be a second answer
  to the same question.
- **A continuous price ramp.** [`graded-export`](#graded-export) is three steps
  where the system it was modelled on used a straight line, and steps were the
  deliberate choice: they are legible in a settings form and in a log, and a
  boundary jump every fifteen minutes is nothing next to the price jump that
  caused it. The band model does not preclude adding the line later.

## Two things to know before relying on it

- **Hybrid inverters.** Where PV and the battery share one inverter, a PV limit
  can also block battery charging — which is exactly backwards, since charging
  is what should happen first. Worth checking on your hardware before trusting
  the two features together.
- **Not every inverter exposes a limit.** Curtailment is far less universally
  available than a charge setpoint, and the add-on cannot tell whether anything
  acted on the event it published.
