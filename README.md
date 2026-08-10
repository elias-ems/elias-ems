# Elias ems

A (H)EMS (Home Energy Management System) that complements and extends Home Assistant — see [docs/project.md](docs/project.md). Structured as a Home Assistant add-on repository so it installs as an app.

## Installing in Home Assistant

Requires a Supervisor-based install (Home Assistant OS or Supervised) — Core-only/plain Docker installs don't have an Add-on Store.

1. In the Home Assistant UI, go to **Settings → Add-ons → Add-on Store**.
2. Click the **⋮** menu (top right) → **Repositories**.
3. Add `https://github.com/elias-ems/elias-ems` and close the dialog.
4. Refresh the store page — the "Elias EMS Add-ons" repository shows up with "Elias ems" listed.
5. Open it, click **Install**, and watch the build log (first build compiles the React Router app inside Docker, so it takes a few minutes).
6. Once installed, click **Start**, then open the app from the sidebar panel — it should show "Hello World".

## Development

### Tooling

The tools that don't come from npm are pinned in [mise.toml](mise.toml), so [mise](https://mise.jdx.dev/) installs the lot at the right versions:

```bash
mise install
```

| Tool | Version | Needed for |
| --- | --- | --- |
| **Node** | 22.23.2 | Everything. React Router 8 needs >= 22.22, and the add-on images pin `node:22-alpine`. |
| **GitHub CLI (`gh`)** | 2.97.0 | Opening pull requests and reading CI from the terminal. |

Everything else — Vite, Biome, Playwright, lefthook — is an npm devDependency and arrives with `npm install`. Playwright also needs its browser downloaded once: `npx playwright install chromium`.

### Getting started

```bash
cd addon && npm install && npm run dev:mock
```

`npm install` is also what installs the git hooks. See [CLAUDE.md](CLAUDE.md) for the full command list, the ingress quirks worth knowing before touching `server.js`, and why this repo uses Biome rather than ESLint.
