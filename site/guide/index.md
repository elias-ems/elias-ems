# What Elias ems is

A **home energy management system** that runs as a Home Assistant add-on. It
does not replace Home Assistant or duplicate what it already does well — it
sits on top, reads the entities your integrations already publish, and makes
decisions Home Assistant has no opinion about.

The first of those decisions is **battery control**: keep the grid meter at
zero. If the house is importing, discharge the battery by that much; if it is
exporting, charge. Home Assistant can already show you both numbers. Turning
them into a target, several times a minute, within your charge limits and your
inverter's power limits, is the part this fills in.

Each battery's target leaves as its own Home Assistant **event**, and an
automation you write turns it into whatever your inverter speaks. That one step is what keeps the
add-on out of the business of knowing every brand's registers and modes.

It is installed from the Add-on Store, appears in your sidebar, and is
configured entirely from its own pages — no YAML.

## What you need

| | |
| --- | --- |
| **Home Assistant** | A **Supervisor-based** install: Home Assistant OS or Home Assistant Supervised. Core-only and plain Docker installs have no Add-on Store and cannot run this. |
| **Architecture** | `aarch64` or `amd64`. 32-bit ARM (`armv7`) is not supported — Home Assistant dropped it, and the Node 24 runtime the add-on is built on publishes no 32-bit ARM images to base one on. |
| **A grid sensor** | One entity giving **instantaneous power in watts, signed**: positive importing, negative exporting. See [the note on signed sensors](/guide/configure#the-grid-sensor) if yours is an import/export pair. |
| **A battery** | Entities for its cumulative energy (kWh), current power (W) and state of charge (%). To have it *steered* rather than merely watched, it also needs an [automation](/guide/battery-control#connecting-the-event-to-your-battery) listening for the event named after it — a few lines of YAML, and the one place your inverter's own quirks live. |

## What works today

- **Battery control** with a net-zero-energy strategy. It reads, decides,
  publishes each battery's target as its own event —
  `elias_ems_home_battery_target_power` for a battery called "Home battery" — and logs
  both halves. See [Battery control](/guide/battery-control).
- **Live readings** on the home page for your PV arrays, the grid and each
  battery, pushed rather than polled, with a health chip that tells you when the
  connection to Home Assistant is degraded. See [The dashboard](/guide/dashboard).
- **Diagnostics** — one log every feature writes to, readable on screen and
  downloadable as a text file. See [Diagnostics](/guide/diagnostics).
- **Dynamic prices** — day-ahead exchange prices read off an integration you
  already have, put through your own contract's arithmetic, so the dashboard
  shows what a kWh costs and earns for every quarter hour of today and tomorrow.
  See [Dynamic prices](/guide/prices).
- **PV curtailment** — while a kWh put on the grid earns less than it costs to
  make, your arrays are held back to roughly what the house and its battery can
  absorb, published as an event per array. See [PV
  curtailment](/guide/pv-curtailment).

## What it cannot do yet

- **Reach your battery on its own.** The target stops at the event; the
  automation that carries it the rest of the way is yours to write, including
  anything your inverter needs first — a forced mode, most often. There are
  worked examples for each shape, but no per-brand catalogue.
- **Notice that nothing acted on a target.** A missing automation, one still
  listening for a battery's old name, and an inverter quietly ignoring the value
  all look identical from the add-on's side. This is the single most likely reason a correct-looking
  setup appears to do nothing.
- **Charge your battery on price.** PV curtailment reads prices, but battery
  control does not — it still runs net-zero-energy and knows nothing about what
  electricity costs. Buying cheap to use later, and being paid to charge at a
  negative price, are the next steps.
- **Fetch prices itself.** It reads what a price integration publishes, so it
  needs one installed. There is no built-in client yet, and Home Assistant's
  *core* Nord Pool integration is not usable — see
  [what you need](/guide/prices#what-you-need).

The full list, with the reasoning, is in
[the internals](/internals/battery-control#not-done-yet).

## Where things are

Three pages, in the top bar:

- **Home** — live readings, plus battery control's own diagnostics.
- **Tools** — every feature's diagnostics merged, and the download button.
- **Settings** — the grid sensor, your batteries, your PV entities, your energy
  prices, and the control loop.

## Next

[Install it →](/guide/install)
