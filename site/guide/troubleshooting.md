# Troubleshooting

## The add-on isn't in the store after adding the repository

Refresh the store page — Home Assistant caches it. If **Settings → Add-ons**
does not exist at all, you are on Home Assistant Core or a plain Docker install,
which has no Add-on Store; Elias ems cannot be installed there.

## The install fails, or the add-on won't start

Check the architecture first. Builds exist for `aarch64` and `amd64` only. On a
32-bit ARM machine (`armv7`) the add-on will not appear as installable — Home
Assistant dropped that architecture, and the runtime this is built on publishes
no 32-bit ARM images.

Otherwise, read the build log. The first install compiles the app inside Docker
and legitimately takes a few minutes; a build that is slow and a build that is
stuck look identical from the store page and different in the log.

## The page loads but nothing on it works

Buttons do nothing, forms don't submit, the page looks right and is completely
inert. That is the app's assets failing to load through Home Assistant's ingress
proxy. It is a bug on our side, not a misconfiguration on yours — please
[report it](https://github.com/elias-ems/elias-ems/issues) with your Home
Assistant version and how you reach it (local, Nabu Casa, reverse proxy).

## No readings at all

Every reading shows as unavailable and the health chip is unhappy.

- **Check the entity ids** on the Settings page against Home Assistant's
  developer tools. An entity that was renamed in Home Assistant does not update
  here.
- **Restart the add-on.** If it can't reach Home Assistant at all, the
  diagnostics log says so rather than logging ticks that read like an idle
  house.
- **A rejected token** and an unreachable server look identical from outside and
  are reported separately in the log — read which one you have before changing
  anything.

## The health chip says "Polling"

The add-on is fine; the live stream to your browser isn't getting through, and
the page is refetching every 5 seconds instead. Readings are at worst 5 seconds
stale, so nothing is broken — but if it never recovers, something between Home
Assistant and your browser is buffering the stream. Worth
[reporting](https://github.com/elias-ems/elias-ems/issues), with how you reach
Home Assistant.

## Battery control won't switch on

The checkbox is disabled until **at least one battery has a target power
entity**. A loop that decides correctly and can change nothing looks exactly
like a loop that is broken, so it is not allowed to start in that state. See
[Target power](/guide/configure#target-power-watched-vs-steered).

Switching control *off* is always allowed, whatever the configuration looks
like.

## The log looks right but the battery does nothing

The most likely cause by far: **your inverter needs its mode set before it will
honour a setpoint**, and Elias ems does not do that yet. The value lands on the
entity, the entity reads it back, the log looks perfect, and the hardware carries
on running its own logic. See
[what battery control cannot do yet](/guide/battery-control#what-it-cannot-do-yet).

An automation of your own that puts the inverter into its forced mode is the
workaround for now.

Other things to rule out:

- **The target entity is not actually writable.** A `sensor` cannot be written
  to. It wants a `number` or an `input_number` — anything else is refused rather
  than guessed at, and the refusal is in the log.
- **The write is being skipped as redundant.** A setpoint is only sent when it
  differs from the entity's current value by at least 50 W.

## A battery sits out with "power limited to 0 W"

Its target entity's range cannot express that direction. An `input_number`
created through the Home Assistant UI defaults to 0–100, and a `min` of 0 means
negative values — discharging — are not writable at all.

Fix the helper's range, or fill in **Maximum charge power** and **Maximum
discharge power** on the battery, which override the entity's range. See
[Power limits](/guide/configure#power-limits).

## The meter goes the wrong way

Check your signs. Two independent conventions have to be right:

- the **grid sensor** must be positive when importing;
- each battery's **power** must be positive when charging.

Both are read as-is, with no correction anywhere, so a backwards sensor makes
every decision backwards. Negate it in a Home Assistant template sensor rather
than compensating elsewhere. See [the grid sensor](/guide/configure#the-grid-sensor).

## Everything in the log vanished

Restarting the add-on empties the diagnostics buffer. It is held in memory on
purpose and is not persisted — download it from the Tools page before restarting
if a stretch of it matters. See [Diagnostics](/guide/diagnostics#the-log-is-not-kept).

## Still stuck

[Open an issue](https://github.com/elias-ems/elias-ems/issues) with a downloaded
diagnostics file and what you expected to happen — see
[reporting a problem](/guide/diagnostics#reporting-a-problem) for the details
worth including.
