# Architecture

This is a Home Assistant add-on repository (the layout HA's Add-on Store expects: `repository.yaml` at the root plus one directory per add-on, each with its own `config.yaml`).

- `repository.yaml` — repo-level metadata shown in the HA Add-on Store.
- `addon/` — the "Elias-ems" app: a Remix (React) app that becomes its UI.
  - `addon/config.yaml` — HA add-on manifest (slug, arch, ingress). The app is reached through HA's ingress on port 3000, not exposed directly.
  - `addon/Dockerfile` — multi-stage build: `npm run build` runs in a build stage, then only `build/server`, `build/client`, and prod deps are copied into the runtime image, which runs `npm run start`.
  - `addon/app/` — Remix app source, with routes under `addon/app/routes/`.

The EMS logic itself (battery control, PV curtailment, price integration — see [roadmap.md](roadmap.md)) isn't implemented yet; the app currently only scaffolds a Remix "Hello World" page.
