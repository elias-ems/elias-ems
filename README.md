# Elias ems

A (H)EMS (Home Energy Management System) that complements and extends Home Assistant — see [docs/project.md](docs/project.md). Structured as a Home Assistant add-on repository so it installs as an app.

## Installing in Home Assistant

Requires a Supervisor-based install (Home Assistant OS or Supervised) — Core-only/plain Docker installs don't have an Add-on Store.

1. In the Home Assistant UI, go to **Settings → Add-ons → Add-on Store**.
2. Click the **⋮** menu (top right) → **Repositories**.
3. Add `https://github.com/elias-ems/elias-ems` and close the dialog.
4. Refresh the store page — the "Elias EMS Add-ons" repository shows up with "Elias ems" listed.
5. Open it, click **Install**, and watch the build log (first build compiles the Remix app inside Docker, so it takes a few minutes).
6. Once installed, click **Start**, then open the app from the sidebar panel — it should show "Hello World".
