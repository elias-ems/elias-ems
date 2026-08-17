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

The checkbox is disabled until **at least one battery is steered** — the
per-battery **Steer this battery** box. A loop that decides correctly and can
command nothing looks exactly like a loop that is broken, so it is not allowed
to start in that state. See [Watched vs.
steered](/guide/configure#watched-vs-steered-and-the-event-named-after-the-title).

Switching control *off* is always allowed, whatever the configuration looks
like.

## The log looks right but the battery does nothing

The log only proves Elias ems decided and published. Everything after that is
your automation, so work outwards in this order:

1. **Is the event being fired?** Developer Tools → **Events** → listen to the
   battery's event name, which the Settings page shows under its Title. Nothing
   arriving means control is off, the battery is not steered, or every target
   is inside the 50 W deadband — wait 30 seconds and one will be restated
   anyway.
2. **Is the automation listening for the right name?** The event is named after
   the battery's title, so **renaming a battery renames its event** and any
   automation still on the old name hears nothing, with no error anywhere.
   Compare the trigger against the name on the Settings page.
3. **Did the automation run?** Its trace shows each run and what it called. An
   automation still on Home Assistant's default `mode: single` **drops** events
   that arrive while it is busy — use `mode: queued`.
4. **Did the inverter honour it?** Many ignore a target until a `select`
   entity is in a forced or manual mode. That is [an automation
   step](/guide/battery-control#an-inverter-that-needs-its-mode-set), and on
   those brands it is the difference between a target that lands and one that
   changes nothing.

Elias ems cannot tell these apart from where it stands — see [what it cannot do
yet](/guide/battery-control#what-it-cannot-do-yet).

## A battery sits out with "power limited to 0 W"

Its **Maximum charge power** or **Maximum discharge power** is set to something
that leaves it nothing to do in the direction the meter needs. Clear the field
to leave that direction uncapped, or set it to what the inverter can really
deliver. See [Power limits](/guide/configure#power-limits).

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
