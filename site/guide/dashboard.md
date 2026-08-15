# The dashboard

The home page shows live readings for the PV arrays, the grid and each battery
you have configured, with battery control's own diagnostics underneath.

The numbers move as the house does. **Nothing on the page is polled** while
things are working: Home Assistant tells the add-on that a sensor changed, and
the add-on tells every open browser, so a change shows up in a fraction of a
second without either end asking.

Hover any reading to see when that particular value last changed.

## The health chip

Above the readings sits a chip that says one of three things. It is worth
knowing all three, because in two of them the numbers still appear and are
simply less current than they look.

| Chip | What it means |
| --- | --- |
| **Live** · last change 3s ago | The connection to Home Assistant is up and changes are arriving. If nothing has changed yet, it dates itself by how long the link has been up. |
| **Reconnecting** · showing values read on request | The connection to Home Assistant dropped. Readings still appear — fetched one at a time on request — which is exactly why this needs saying. |
| **Polling** · live updates aren't getting through | The add-on is fine; the stream to *your browser* isn't. The page refetches every 5 seconds instead, so it is at worst 5 seconds stale. |

A **Polling** chip that never goes away usually means something between Home
Assistant and your browser is buffering the stream. The page stays correct, just
slower.

## "Old" doesn't mean broken

Every reading carries the time it last changed, and the diagnostics log stamps
each decision with the age of the oldest number behind it. Those ages are
**advisory** — nothing refuses to act on an old reading.

The reason is that Home Assistant only reports a value when it *changes*. A
battery parked at exactly 0 W overnight emits nothing at all, so its age grows
while nothing whatsoever is wrong, and a rule that refused old numbers would
refuse that battery. Only Home Assistant's own `unavailable` and `unknown` stop
a decision.

That policy is only safe if you can see what is being ignored, which is what
the chip and the ages are for. A sensor that quietly stopped reporting shows up
as an age that keeps climbing on a value that ought to be moving.

## Live health facts

Open the diagnostics box on the home page and the top of it carries the detail
behind the chip: whether the connection is up, the last change it saw, which
source the current readings came from, how many times it has reconnected, and
the last error.

It sits *inside* the log rather than beside it on purpose — the decisions in that
log are only as good as the readings behind them, so whoever opens it to work out
what happened is the same person who needs to know whether the numbers were
arriving.

## Next

[Diagnostics →](/guide/diagnostics)
