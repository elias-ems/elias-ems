# Battery control

The goal is one sentence: **keep the grid meter at zero.** If the house is
importing, the battery should be covering it; if it is exporting, the battery
should be soaking it up.

Every few seconds the add-on reads the grid meter and each battery, decides what
each one should be doing, writes that to the battery's target power entity, and
records both halves in the [diagnostics log](/guide/diagnostics).

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
3. Otherwise the target is calculated as above, over the **steerable** batteries
   only — the ones with a target power entity.
4. A battery **drops out of this tick** when it cannot help in that direction:
   - it has no target power entity, so there is nothing to write to. It holds at
     whatever it is currently doing, rather than being told to stop;
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

### Batteries you haven't given a target to

A battery with no target power entity is left out of the plan *and* out of the
arithmetic. That second part is less obvious and matters: it is already covering
some of the load, so counting it in would ask the steerable batteries to cover
the same watts a second time, and the meter would overshoot by exactly that
amount. A house importing 200 W with an unsteered battery already discharging
800 W would end up exporting 800 W.

## What actually gets written

A decision and a command are not the same thing, and the log shows both:

| Situation | What the log reports | What gets written |
| --- | --- | --- |
| Charge or discharge | the share, after capping | the same |
| At a charge or power limit | 0 | **0** — an active stop |
| Meter inside the 25 W deadband | the battery's measured power | **nothing** |
| Grid sensor unreadable | measured power | **0** for steerable batteries |
| No target entity | measured power | nothing |

The deadband row is the interesting one. A hold reports what the battery is
measured to be doing, which is the right thing to *show* and the wrong thing to
*command* — writing a measurement back as a setpoint would let sensor noise walk
the commanded value around on a house that is already balanced. So a hold writes
nothing and the previous setpoint stands.

The unreadable-grid row goes the other way, deliberately. A battery left forcing
kilowatts because the meter it was following broke is the one hold that must not
persist, so that case stops the battery rather than holding it.

**Writes are deduplicated.** A setpoint is only sent when the target entity's
current value differs from what is wanted by at least 50 W — otherwise a loop
ticking every second would produce thousands of service calls an hour, against
hardware that on some brands commits setpoints to flash. The comparison is
against what the entity *reads now*, not against what was last sent, so if
something else moves the entity it gets corrected on the next tick.

## Switching it off

Switching control off, and shutting the add-on down cleanly, both command **0 W**
to every steerable battery. A battery left forcing kilowatts because the thing
that told it to is gone is the worst failure this feature has — from the
battery's side there is no difference between a setpoint that is still wanted
and one whose author died ten minutes ago.

Two honest limits:

- Zero is the **safe** value, not necessarily the *correct* one. It stops the
  battery being driven either way, which is safe on every inverter, but handing
  it back to its own self-consumption logic means restoring a mode on many
  brands, which Elias ems does not do yet.
- Nothing runs at all on a hard kill, a power cut, or a container the Supervisor
  destroys without asking. The only real protection against those is an inverter
  whose forced mode expires on its own — some brands have that, others do not.

## What it cannot do yet

::: danger The mode entity
Many inverters ignore a setpoint until a `select` entity is put into a forced or
manual mode. Elias ems does not touch that entity. **This is the most likely
reason a correct-looking setup does nothing**: the write lands, the entity reads
back exactly what was asked for, the log looks perfect, and the hardware carries
on running its own self-consumption logic.

If that is your inverter, an automation that puts it into the right mode is the
workaround for now.
:::

It also does not notice that the hardware disagreed — it confirms the *entity*
took the value, which is not the same as the battery obeying it. And there is no
price awareness of any kind: dynamic prices, negative-price strategies and PV
curtailment are on the roadmap and not started.

The full list with the reasoning behind each item is in
[the internals](/internals/battery-control#not-done-yet).

## Reading a decision

A tick in the diagnostics log looks like this:

```
22:50:57 Grid net +842 W (importing), batteries at 0 W → discharge 842 W total. (via live cache, oldest reading 3s)
         Home battery: discharge at 561 W (SoC 76%, 6.6 kWh to 10%)
         Garage battery: discharge at 281 W (SoC 76%, 2.8 kWh to 20%)
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

## Next

[Diagnostics →](/guide/diagnostics)
