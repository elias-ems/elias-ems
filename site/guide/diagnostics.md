# Diagnostics

One log that every feature writes to: what it read, what it decided, and what it
wrote. It is the first thing to open when something looks wrong, and the thing to
attach when you report it.

## Where to read it

**On the home page**, in the collapsed **Diagnostics** box under Battery
control — filtered to that feature, so it is the loop's own story with nothing
else mixed in.

**On the Tools page**, open by default and unfiltered: every feature's entries
merged into one timeline, each line labelled with where it came from. Tools is
the page for the things you do *to* an installation rather than the things you
configure on it.

Newest first in both, since that is the end you want when you open a log. While
a box is open it refreshes every couple of seconds, and only while the tab is
visible; closed, it costs nothing.

## Reading an entry

An entry from the control loop is one whole decision — a summary line plus one
line per battery:

```
22:50:57 Grid net +842 W (importing), batteries at 0 W → discharge 842 W total. (via live cache, oldest reading 3s)
         Home battery: discharge at 561 W (SoC 76%, 6.6 kWh to 10%)
         Garage battery: discharge at 281 W (SoC 76%, 2.8 kWh to 20%)
```

Lines are coloured by level: informational, warning, or error.

**Identical consecutive entries collapse into a `×N` count.** A house that is not
doing anything produces the same decision every few seconds, and a log full of
near-duplicates would push everything useful off the end. A `×47` means the same
thing happened 47 times in a row, not that it happened once.

## Downloading it

The **Download** button on the Tools page gives you the whole buffer as a plain
text file, named `elias-ems-diagnostics-<timestamp>.txt`.

The file is **oldest first** — the reverse of what you see on screen. A box is
read backwards from the end to see what just happened; a file is read forwards
from the top to follow what led up to something.

```
2026-08-13T20:50:57.000Z  battery-control  info (×12)
    Grid net +842 W (importing), batteries at 0 W → discharge 842 W total.
    Home battery: discharge at 842 W (SoC 76%, 6.6 kWh to 10%)
```

Each entry gets a full ISO timestamp, the feature it came from, its level and
its repeat count, with the message indented underneath.

## The log is not kept

The buffer holds the **last 300 entries per feature, in memory**. It is
deliberately not written to disk: at a five-second interval the control loop
alone produces thousands of lines an hour, and persisting them would buy nothing
but wear on whatever your Home Assistant box boots from.

::: warning Restarting the add-on empties the log
That is intended, not a bug. If a particular stretch matters — you saw something
odd and want to report it — **download it before restarting anything.**
:::

## Reporting a problem

[Open an issue](https://github.com/elias-ems/elias-ems/issues) with:

- the downloaded diagnostics file, covering the stretch where the problem
  happened;
- what you expected the battery to do and what it did instead;
- the entity ids you configured, and what their domains are — especially the
  target power entity;
- your inverter or battery make and model, since whether a setpoint is honoured
  at all is brand-specific.

If the log shows a correct-looking setpoint and the battery ignores it, read
[what battery control cannot do yet](/guide/battery-control#what-it-cannot-do-yet)
first — an inverter waiting for its mode to be set is the usual explanation.

## Next

[Troubleshooting →](/guide/troubleshooting)
