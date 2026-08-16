---
layout: home

hero:
  name: Elias ems
  text: Energy management, inside Home Assistant
  tagline: >-
    An open-source home energy management system that installs as a Home
    Assistant add-on. It watches your grid meter and steers your battery to
    keep the meter at zero.
  actions:
    - theme: brand
      text: Install it
      link: /guide/install
    - theme: alt
      text: What it does
      link: /guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/elias-ems/elias-ems

features:
  - title: Battery control
    details: >-
      A net-zero-energy strategy reads the grid meter, works out what every
      battery should be doing, and publishes the setpoint as a Home Assistant
      event for your automation to act on. It respects your charge limits,
      splits the target across batteries by capacity, and caps each share at
      what the inverter can deliver.
    link: /guide/battery-control
    linkText: How it decides
  - title: Readings that move
    details: >-
      Nothing on the dashboard is polled. Home Assistant pushes a change to the
      add-on over a WebSocket, the add-on pushes it to your browser, and the
      number updates in a fraction of a second — with a health chip that says so
      when it can't.
    link: /guide/dashboard
    linkText: Reading the dashboard
  - title: One log to send
    details: >-
      Every feature writes to the same diagnostics log: what it read, what it
      decided, and what it published. Read it on screen, or download the whole
      thing as a text file to attach to an issue.
    link: /guide/diagnostics
    linkText: Getting a log
---

## Where this is

Elias ems is **pre-1.0 and under active development** — the add-on ships as
`1.0.0-alpha.N` and is being tested in the field rather than in production
homes. Battery control decides, publishes and logs today; the last step to your
hardware is an automation you write, which is also where an inverter's own
quirks — a forced mode, a pair of registers, an opposite sign — belong. What it
cannot yet do is notice that nothing acted on a setpoint. That limitation is
spelled out in full on the
[battery control page](/guide/battery-control#what-it-cannot-do-yet), and the
rest of the plan is on the [roadmap](https://github.com/elias-ems/elias-ems/blob/main/docs/roadmap.md).

Install it if you are comfortable reading a diagnostics log and
[reporting what you find](https://github.com/elias-ems/elias-ems/issues).

## What you need

- Home Assistant on a **Supervisor-based install** — Home Assistant OS or
  Supervised. Core-only and plain Docker installs have no Add-on Store.
- An `aarch64` or `amd64` machine. 32-bit ARM is not supported.
- A **signed** grid power sensor, and a battery that exposes its energy, power
  and state of charge — plus a writable entity if you want it steered.

[Full requirements and install steps →](/guide/install)
