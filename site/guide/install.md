# Installing

Elias ems is distributed as a Home Assistant **add-on repository**. You add the
repository once, then install the add-on from the store like any other.

::: warning Requires a Supervisor-based install
Home Assistant OS or Home Assistant Supervised only. If **Settings → Add-ons**
does not exist in your sidebar, you are on Home Assistant Core or a plain Docker
install, and there is no Add-on Store to install this from.

Builds are published for `aarch64` and `amd64`. 32-bit ARM (`armv7`) is not
supported.
:::

## Add the repository

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Click the **⋮** menu in the top right, then **Repositories**.
3. Paste `https://github.com/elias-ems/elias-ems` and click **Add**, then close
   the dialog.
4. Refresh the store page. A section called **Elias EMS Add-ons** appears, with
   **Elias ems** in it.

## Install and start

5. Open it and click **Install**. The first build compiles the app inside
   Docker, so give it a few minutes — watching the build log is the way to tell
   it apart from a hung install.
6. When it finishes, click **Start**.
7. Turn on **Show in sidebar** so you can reach it in one click, then open the
   panel.

You should land on the home page with nothing configured yet — no PV, no grid
sensor, no batteries.

::: tip Watchdog and auto-start
The add-on is set to start on boot. If you want Home Assistant to restart it
when it crashes, turn on **Watchdog** on the add-on's info page as well.
:::

## Configure it

Nothing happens until you point it at your entities. Head to
[Configuring](/guide/configure) — start with the grid sensor, then add your
batteries, and only then enable the control loop.

## Updating

The add-on declares a version, and Home Assistant's Supervisor decides there is
an update purely by comparing that string to what you have installed. When a new
version is published, **Update** appears on the add-on page the same way it does
for any other add-on — there is nothing to pull by hand.

Versions are `1.0.0-alpha.N` while this is pre-1.0. Expect settings to grow new
fields between them; existing configuration is normalised forward rather than
discarded, so an upgrade does not lose what you have entered.

::: warning An upgrade never starts steering a battery on its own
Fields added later default to "not set", so a battery saved before a control
field existed reads as unsteered after the upgrade and stays that way until you
fill it in.

That includes the move to setpoint **events**: batteries that used to name a
"Target power" entity come across as watched, not steered. Give them a [control
key](/guide/configure#the-control-key-watched-vs-steered) and an
[automation](/guide/battery-control#connecting-the-event-to-your-battery), then
switch control back on.
:::

## Uninstalling

Stop the add-on and click **Uninstall**. Two things worth knowing:

- **Stopping the add-on tells every steered battery to stop.** Switching control
  off, and shutting the add-on down cleanly, both publish 0 W for each battery
  that has a control key, flagged `released: true` so your automation can put an
  inverter back on self-consumption rather than leaving it forced at 0 W. That
  last step only happens if your automation does it. And nothing is published at
  all if the container is killed outright or the power goes, so a battery can be
  left holding the last setpoint it was given.
- **Your settings live in the add-on's data directory** and go with it when you
  uninstall. Nothing is written into Home Assistant's own configuration.

## Next

[Configuring →](/guide/configure)
