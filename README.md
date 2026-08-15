# Elias ems

A (H)EMS (Home Energy Management System) that complements and extends Home Assistant — see [docs/project.md](docs/project.md). Structured as a Home Assistant add-on repository so it installs as an app.

📖 **[Documentation](https://elias-ems.github.io/elias-ems/)** — install, configure, and how battery control decides.

## Installing in Home Assistant

Requires a Supervisor-based install (Home Assistant OS or Supervised) — Core-only/plain Docker installs don't have an Add-on Store. Builds are published for `aarch64` and `amd64` only; 32-bit ARM (`armv7`) is not supported, matching Home Assistant's own dropping of it.

1. In the Home Assistant UI, go to **Settings → Add-ons → Add-on Store**.
2. Click the **⋮** menu (top right) → **Repositories**.
3. Add `https://github.com/elias-ems/elias-ems` and close the dialog.
4. Refresh the store page — the "Elias EMS Add-ons" repository shows up with "Elias ems" listed.
5. Open it, click **Install**, and watch the build log (first build compiles the React Router app inside Docker, so it takes a few minutes).
6. Once installed, click **Start**, then open the app from the sidebar panel.

Then point it at your entities — the [configuration guide](https://elias-ems.github.io/elias-ems/guide/configure) covers the grid sensor's sign convention and what makes a battery steerable, which are the two things worth getting right first.

## Development

### Tooling

The tools that don't come from npm are pinned in [mise.toml](mise.toml), so [mise](https://mise.jdx.dev/) installs the lot at the right versions:

```bash
mise install
```

| Tool | Version | Needed for |
| --- | --- | --- |
| **Node** | 24.19.0 | Everything. The add-on requires Node >= 24 and its images pin `node:24-alpine` (which is also why it ships for `aarch64` and `amd64` only — Node 24 has no 32-bit ARM builds). |
| **GitHub CLI (`gh`)** | 2.97.0 | Opening pull requests and reading CI from the terminal. |

Everything else — Vite, Biome, Playwright, lefthook — is an npm devDependency and arrives with `npm install`. Playwright also needs its browser downloaded once: `npx playwright install chromium`.

### Getting started

```bash
cd addon && npm install && npm run dev:mock
```

`npm install` is also what installs the git hooks. See [CLAUDE.md](CLAUDE.md) for the full command list, the ingress quirks worth knowing before touching `server.js`, and why this repo uses Biome rather than ESLint.

### The documentation site

[site/](site) is the VitePress source for <https://elias-ems.github.io/elias-ems/>, deployed by [.github/workflows/docs.yml](.github/workflows/docs.yml) on every push to `main`. Its own npm project:

```bash
cd site && npm install && npm run docs:dev
```

The user guide is written by hand under `site/guide/`. The "Under the hood" section is *generated* at build time from `docs/` by `site/scripts/sync-docs.mjs`, which rewrites each doc's links — source files become GitHub URLs, sibling docs become pages — so `docs/` stays the single source of truth and `site/internals/` is gitignored output. `npm run docs:build` fails on a dead link, which is what catches a doc that moved.
