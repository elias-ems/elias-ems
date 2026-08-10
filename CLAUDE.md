# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project description

See [docs/project.md](docs/project.md) for what we're building and architecture decisions, [docs/architecture.md](docs/architecture.md) for repo/code structure, [docs/roadmap.md](docs/roadmap.md) for current and future goals, and [docs/routines.md](docs/routines.md) for scheduled Claude routines. Keep these up to date as the project evolves.

## Commands

Run from `addon/`:

- `npm install` — install dependencies
- `npm run dev` — start the React Router dev server (`react-router dev`)
- `npm run build` — production build (`react-router build`)
- `npm run typecheck` — regenerate route types and run `tsc` (`react-router typegen && tsc`)
- `npm run start` — run the built server (`node server.js`, a small custom Express server — see [Home Assistant ingress](#home-assistant-ingress) below. `react-router-serve` can't replace it: it has no hook for per-request `basename`.)

Linting and formatting, also from `addon/`:

- `npm run lint` — check formatting, lint rules and import order (`biome check .`)
- `npm run lint:fix` — apply the safe fixes and format (`biome check --write .`)
- `npm run format` — format only, no lint rules (`biome format --write .`)

Tests, all run from `addon/`:

- `npm test` — unit tests (Vitest). Fast; no build needed.
- `npm run test:integration` — builds, then drives the real `server.js` behind a mock ingress proxy over HTTP.
- `npm run test:e2e` — builds, then runs the same stack in Chromium via Playwright. Needs browsers: `npx playwright install chromium`.
- `npm run test:all` — all three in order.

Two commands exist for clicking around by hand: `npm run dev:mock` (Vite dev server plus a mock Home Assistant, no ingress) and `npm run start:ingress` (the full production stack behind an ingress proxy — the only one where the ingress bugs below can show up).

## Framework and toolchain

The app is **React Router 8 in framework mode** (the successor to Remix — Remix v2's packages were collapsed into `react-router` in v7), written in **TypeScript**.

- React Router 8 requires **Node >= 22.22**, React >= 19.2.7, and Vite 7+. The Docker images pin `node:22-alpine`; do not move to `node:24-alpine` without dropping `armv7` from `config.yaml`, since Node 24 publishes no 32-bit ARM images.
- Routes still use Remix-style file naming under `addon/app/routes/`, wired up by `flatRoutes()` from `@react-router/fs-routes` in [addon/app/routes.ts](addon/app/routes.ts).
- Route modules get generated per-route types in `.react-router/types` (gitignored). Import them as `import type { Route } from "./+types/<route-file-name>"` and prefer `Route.ComponentProps` over `useLoaderData`/`useActionData`. Run `npm run typecheck` after adding or renaming a route so the types exist.
- `json()` and `defer()` were removed in v7 — return plain objects from loaders/actions, and use `data(value, { status })` when you need to set a status code.
- `server.js` stays plain JavaScript on purpose: it is the Node entry point, it imports the generated `build/server/index.js`, and typechecking it would mean either compiling it separately or depending on Node's experimental type stripping. Everything under `addon/app/` is TypeScript.

## Linting and formatting

**Biome** ([addon/biome.json](addon/biome.json)) is both the linter and the formatter. There is no ESLint and no Prettier, and adding them is not a small decision:

- **ESLint is currently blocked.** `typescript-eslint` imports the TypeScript compiler API and throws at import time on TypeScript >= 7 (its peer range is `>=4.8.4 <6.1.0`). This repo is on TypeScript 7, so ESLint would need a TypeScript 6 installed side by side purely to feed the linter. Biome has its own parser and never loads `typescript`, which sidesteps the problem entirely.
- The tradeoff is that Biome has **no type-aware rules** — nothing like `no-floating-promises`. `npm run typecheck` (`tsc --strict`) is what covers that ground, so keep running it; lint is not a substitute.
- Config matches the code that already existed rather than Biome's defaults: 2-space indent (Biome defaults to tabs), double quotes, semicolons, 80-column width.
- Suppress a rule with `// biome-ignore lint/<group>/<rule>: <reason>`. It only binds to the **immediately following line**, so put any longer explanation in normal comments *above* it, and note that a diagnostic on a JSX attribute needs the comment inside the opening tag, next to the attribute.

Two suppressions exist on purpose and should not be "fixed": the `role="listbox"` on the suggestions `ul` in [EntityAutocomplete.tsx](addon/app/components/EntityAutocomplete.tsx) is the correct ARIA combobox pattern, and the debounce effect there deliberately omits `fetcher.load` because `useFetcher` returns a new object every render.

## Git hooks

**lefthook** ([lefthook.yml](lefthook.yml)) runs `biome check --write` over staged files on pre-commit and re-stages what it fixed; unfixable lint errors fail the commit. It installs itself via the npm `postinstall` in `addon/`, so hooks appear after `npm install`. Skip it for one command with `LEFTHOOK=0 git commit ...`.

Note that lefthook globs are matched from the **repo root** and ignore the `root:` setting, so they carry the `addon/` prefix that `root: "addon/"` then strips back off.

[.gitattributes](.gitattributes) pins the working tree to LF. Without it, `core.autocrlf=true` on Windows checks files out as CRLF while Biome writes LF, so the formatter and the hook rewrite each other's line endings on every run.

## Home Assistant ingress

HA serves the add-on through a proxy at `/api/hassio_ingress/<session-token>/`, a prefix that is only known at request time and is stripped before the request reaches us. [addon/server.js](addon/server.js) reads it from the `X-Ingress-Path` header and does three things with it. All three are needed; each was a separate observed failure.

1. **`basename`** — so React Router's server-side matching and the basename it embeds for client hydration agree with the browser's real URL.
2. **Rewrites the asset manifest** — `basename` does *not* affect asset URLs. Vite bakes them in at build time from `publicPath`, which is a fixed `/`, so they render as `/assets/x.js`; the browser resolves that against the HA origin, where nothing is served, and every script 404s. The page still server-renders, so the symptom is a page that looks right but is completely inert. `server.js` prefixes `assets.url`, `assets.entry`, and every route's `module`/`imports`/`css`. Do *not* prefix `routeDiscovery.manifestPath` — React Router already resolves that against `basename`.
3. **Gives `basename` a trailing slash** — React Router derives the `to="/"` href from `basename` verbatim, and HA 404s a bare `/api/hassio_ingress/<token>` with no trailing slash. Without it the Home link points at a URL that dies on reload.

Two related notes:

- Express `trust proxy` must stay **off**. HA sets no `X-Forwarded-Host`/`X-Forwarded-Proto` and forwards the browser's original `Host` header untouched, which is exactly what React Router's action-origin CSRF check needs. Turning `trust proxy` on would make Express prefer a client-suppliable header instead.
- To reproduce ingress locally, run [addon/test/ingress-proxy.js](addon/test/ingress-proxy.js) in front of `npm run start`. Loading the app directly on port 3000 will not surface any of the bugs above, because there is no prefix to get wrong.

## Talking to Home Assistant

[addon/app/lib/ha.server.ts](addon/app/lib/ha.server.ts) calls the Supervisor's proxy to the HA REST API, authenticated with the `SUPERVISOR_TOKEN` env var that Supervisor injects. Neither the token nor the `supervisor` hostname exists outside HA, so both `/states` (entity autocomplete) and `/states/<entity_id>` (live readings on the home page) fail locally by design; the UI degrades to a message rather than erroring.

To develop against real-looking data, start [addon/test/ha-mock.js](addon/test/ha-mock.js), then set `SUPERVISOR_API` to its `apiUrl` and `SUPERVISOR_TOKEN` to its token. Unset, `SUPERVISOR_API` defaults to the real `http://supervisor/core/api`.

`addon/test/` holds the harness (`ha-mock.js`, `ingress-proxy.js`, `stack.js`, `dev.js`) alongside the suites in `unit/`, `integration/`, and `e2e/`. The harness files are plain JavaScript for the same reason `server.js` is: node runs them directly, with no build step in front.

To exercise the app inside Home Assistant itself, add this repo as a custom repository in the Add-on Store and install/rebuild "Elias ems" (see README.md for the exact steps).

## Naming

- Display name (sidebar, Add-on Store, `name` in [addon/config.yaml](addon/config.yaml)): **Elias ems**.
- Slug/identifier (folder-safe, used in `slug` in config.yaml, npm package name, git remotes): **elias-ems**.
- Changing `slug` in config.yaml is a breaking change for any already-installed add-on — Supervisor treats it as a different add-on, so existing installs need manual removal/reinstall rather than an in-place update.

## Versioning

The add-on version lives in the `version` field of [addon/config.yaml](addon/config.yaml). Home Assistant Supervisor detects updates purely by comparing this string to the installed version — it does not look at commits or file diffs, so a version bump is what actually surfaces "Update available" in HA.

- Use semver with an incrementing pre-release counter while pre-1.0: `1.0.0-alpha.1`, `1.0.0-alpha.2`, ... → `1.0.0-beta.1`, `1.0.0-beta.2`, ... → `1.0.0` for the first stable release.
- Bump once per meaningful release (batch related changes), not on every commit.
- No automated version-bump pipeline yet — bump manually as part of the release commit.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`.

- Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`.
- Scope is optional; use it for the affected area (e.g. `addon`).
- Description is imperative mood, lowercase, no trailing period.
- Keep the subject line under ~72 characters; add a body for context when needed.
