# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project description

See [docs/project.md](docs/project.md) for what we're building and architecture decisions, [docs/architecture.md](docs/architecture.md) for repo/code structure, [docs/roadmap.md](docs/roadmap.md) for current and future goals, and [docs/routines.md](docs/routines.md) for scheduled Claude routines. Keep these up to date as the project evolves.

Per-feature docs live beside them: [docs/feature-battery-control.md](docs/feature-battery-control.md), [docs/feature-live-readings.md](docs/feature-live-readings.md).

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

Each stack owns a distinct block of ports, so all three can be up at once:

| Stack | Ports |
| --- | --- |
| `npm run dev:mock` | 5173 Vite, 4003 HA mock |
| `npm run start:ingress` | 4000 ingress proxy, 4001 app, 4002 HA mock |
| `npm run test:e2e` | 4100 ingress proxy, 4101 app, 4102 HA mock |

Keeping the test block separate is not tidiness. Playwright's `reuseExistingServer` cannot tell a manually started stack from one of its own, so when these overlapped, running the suite while `start:ingress` was up made it adopt that stack, ignore the `env` in [playwright.config.ts](addon/playwright.config.ts) — which only applies to a server Playwright launches itself — and run the tests against the real `addon/data` rather than a throwaway directory. Override any of them with `INGRESS_PORT`, `APP_PORT` or `HA_MOCK_PORT`.

## Framework and toolchain

The app is **React Router 8 in framework mode** (the successor to Remix — Remix v2's packages were collapsed into `react-router` in v7), written in **TypeScript**.

- React Router 8 requires **Node >= 22.22**, React >= 19.2.7, and Vite 7+, but the add-on itself asks for **Node >= 24** (`engines` in [addon/package.json](addon/package.json), `node:24-alpine` in the Dockerfile, `24.19.0` in [mise.toml](mise.toml) — the current LTS line). Node 24 publishes no 32-bit ARM builds, which is why [addon/config.yaml](addon/config.yaml) lists only `aarch64` and `amd64`: `armv7` was dropped when Home Assistant itself dropped armv7 support. Keep `@types/node` on `^24` — it tracks the Node major we run, not the newest release.
- Routes still use Remix-style file naming under `addon/app/routes/`, wired up by `flatRoutes()` from `@react-router/fs-routes` in [addon/app/routes.ts](addon/app/routes.ts).
- Route modules get generated per-route types in `.react-router/types` (gitignored). Import them as `import type { Route } from "./+types/<route-file-name>"` and prefer `Route.ComponentProps` over `useLoaderData`/`useActionData`. Run `npm run typecheck` after adding or renaming a route so the types exist.
- `json()` and `defer()` were removed in v7 — return plain objects from loaders/actions, and use `data(value, { status })` when you need to set a status code.
- `server.js` stays plain JavaScript on purpose: it is the Node entry point, it imports the generated `build/server/index.js`, and typechecking it would mean either compiling it separately or depending on Node's experimental type stripping. Everything under `addon/app/` is TypeScript.
- [addon/app/entry.server.tsx](addon/app/entry.server.tsx) is the **stock** entry from `react-router reveal`, owned for exactly one reason: it is the only module the framework loads once when the server process starts, which is where the battery control loop is started. Keep local changes there to that one call — everything else in the file should stay diffable against the template. `app/entry.client.tsx` is deliberately *not* revealed; an unmodified copy would only be one more file to keep in step with the framework. `server.js` cannot do this job instead: it is plain JavaScript and can only import the bundled `build/server/index.js`, which exports no route or lib module.

## Linting and formatting

**Biome** ([addon/biome.json](addon/biome.json)) is both the linter and the formatter. There is no ESLint and no Prettier, and adding them is not a small decision:

- **ESLint is currently blocked.** `typescript-eslint` imports the TypeScript compiler API and throws at import time on TypeScript >= 7 (its peer range is `>=4.8.4 <6.1.0`). This repo is on TypeScript 7, so ESLint would need a TypeScript 6 installed side by side purely to feed the linter. Biome has its own parser and never loads `typescript`, which sidesteps the problem entirely.
- The tradeoff is that Biome has **no type-aware rules** — nothing like `no-floating-promises`. `npm run typecheck` (`tsc --strict`) is what covers that ground, so keep running it; lint is not a substitute.
- Config matches the code that already existed rather than Biome's defaults: 2-space indent (Biome defaults to tabs), double quotes, semicolons, 80-column width.
- Suppress a rule with `// biome-ignore lint/<group>/<rule>: <reason>`. It only binds to the **immediately following line**, so put any longer explanation in normal comments *above* it, and note that a diagnostic on a JSX attribute needs the comment inside the opening tag, next to the attribute.

Two suppressions exist on purpose and should not be "fixed": the `role="listbox"` on the suggestions `ul` in [EntityAutocomplete.tsx](addon/app/components/EntityAutocomplete.tsx) is the correct ARIA combobox pattern, and the debounce effect there deliberately omits `fetcher.load` because `useFetcher` returns a new object every render.

## Git hooks

**lefthook** ([lefthook.yml](lefthook.yml)) runs `biome check --write` over staged files on pre-commit and re-stages what it fixed; unfixable lint errors fail the commit. Skip it for one command with `LEFTHOOK=0 git commit ...`.

Hooks install themselves on `npm install` in `addon/`, but the mechanism is worth being precise about: it is the **`lefthook` package's own `postinstall`** running `lefthook install -f`. [addon/package.json](addon/package.json) declares no `postinstall` of its own, so grepping for one and finding nothing does not mean a fresh clone goes unhooked — it doesn't. Two consequences:

- The postinstall skips itself when `CI` is set and `LEFTHOOK` is not, so CI checkouts correctly get no hooks.
- It still runs during the Docker build's first stage, which installs devDependencies. `.dockerignore` excludes `.git`, so `lefthook install` exits 128 with `fatal: not a git repository`. That is noise, not a failure — `postinstall.js` uses `spawnSync` and never checks the exit code — and the runtime stage installs with `--omit=dev`, so lefthook is absent there entirely.

That postinstall only gets to run because the project **approved it**. npm 11 (what `node:24`/mise's Node 24 ships) refuses to run a dependency's install scripts unless they are listed in the `allowScripts` block of [addon/package.json](addon/package.json), and the entry it writes is pinned to an exact version:

```json
"allowScripts": { "lefthook@2.1.10": true }
```

So **bumping lefthook re-arms the gate**. The pin no longer matches, the postinstall is skipped, and the only signal is an `npm warn allow-scripts` line at the end of `npm install` — the hooks then quietly stop installing for anyone with a fresh clone. After any lefthook bump, re-approve it from `addon/` and commit the changed pin:

```bash
npm approve-scripts lefthook
```

If the hooks ever do go missing, reinstall them **from `addon/`**:

```bash
npx lefthook install
```

Running that from the repo root instead would silently download a second copy of lefthook from the registry, because there is no `node_modules` there for npx to resolve against.

Note that lefthook globs are matched from the **repo root** and ignore the `root:` setting, so they carry the `addon/` prefix that `root: "addon/"` then strips back off.

[.gitattributes](.gitattributes) pins the working tree to LF. Without it, `core.autocrlf=true` on Windows checks files out as CRLF while Biome writes LF, so the formatter and the hook rewrite each other's line endings on every run.

## Home Assistant ingress

HA serves the add-on through a proxy at `/api/hassio_ingress/<session-token>/`, a prefix that is only known at request time and is stripped before the request reaches us. [addon/server.js](addon/server.js) reads it from the `X-Ingress-Path` header and does three things with it. All three are needed; each was a separate observed failure.

1. **`basename`** — so React Router's server-side matching and the basename it embeds for client hydration agree with the browser's real URL.
2. **Rewrites the asset manifest** — `basename` does *not* affect asset URLs. Vite bakes them in at build time from `publicPath`, which is a fixed `/`, so they render as `/assets/x.js`; the browser resolves that against the HA origin, where nothing is served, and every script 404s. The page still server-renders, so the symptom is a page that looks right but is completely inert. `server.js` prefixes `assets.url`, `assets.entry`, and every route's `module`/`imports`/`css`. Do *not* prefix `routeDiscovery.manifestPath` — React Router already resolves that against `basename`.
3. **Gives `basename` a trailing slash** — React Router derives the `to="/"` href from `basename` verbatim, and HA 404s a bare `/api/hassio_ingress/<token>` with no trailing slash. Without it the Home link points at a URL that dies on reload.

Three related notes:

- **There is no HA toolbar to hook into.** HA renders the panel as a bare cross-origin iframe with no header of its own above it on desktop, and offers the add-on no way to add anything to HA's chrome. The bar ESPHome and the Matter server appear to contribute to HA's own UI is really the first element inside their iframe. Ours is [AppHeader.tsx](addon/app/components/AppHeader.tsx), which is why it styles itself as a Material top app bar rather than as page content.
- Express `trust proxy` must stay **off**. HA sets no `X-Forwarded-Host`/`X-Forwarded-Proto` and forwards the browser's original `Host` header untouched, which is exactly what React Router's action-origin CSRF check needs. Turning `trust proxy` on would make Express prefer a client-suppliable header instead.
- To reproduce ingress locally, run [addon/test/ingress-proxy.js](addon/test/ingress-proxy.js) in front of `npm run start`. Loading the app directly on port 3000 will not surface any of the bugs above, because there is no prefix to get wrong.

## Theming

[addon/app/app.css](addon/app/app.css) is the only stylesheet, and it exists to hold the light/dark colour tokens. Components keep styling themselves with inline `style` objects, but every colour goes through a `var(--color-*)` — **never a literal hex**. A hardcoded colour is by definition broken in one of the two themes, which is exactly how the app ended up dark-grey-on-dark before the tokens existed.

Three things make the theme actually follow Home Assistant:

- **`color-scheme: light dark`** on `:root`. HA's own CSS custom properties do not cross the ingress iframe boundary, so the add-on cannot read HA's theme variables — but the browser *does* propagate the embedding document's used `color-scheme` into the iframe. That propagated value is what tells the app which theme HA is in. It also makes the browser restyle native controls (buttons, scrollbars, the page canvas) for dark, which no amount of our own CSS would do.
- **`light-dark()`** for each token, rather than a `prefers-color-scheme` media query. `light-dark()` resolves against the computed `color-scheme` property, so the declaration above is the single switch for the whole palette: forcing a theme later (an explicit user preference, say) means overriding that one property and nothing else. A media query would ignore it and keep following the OS.
- **The `<meta name="color-scheme">`** in [root.tsx](addon/app/root.tsx) duplicates the CSS declaration on purpose — it is parsed before the stylesheet loads, so the first paint of the canvas is already the right colour instead of flashing white.

Three traps worth knowing:

- The top bar is the one exception to "no rules, only tokens" in app.css: `.app-header :focus-visible` overrides the focus outline colour, because the page's focus blue only manages 1.3:1 against the bar's own blue and a pseudo-class is the one thing an inline style cannot express. Its `--color-header-bg` is *not* HA's `#03a9f4` — white on that is 2.2:1 — but a darkened blue that clears AA in both themes.
- `addon/package.json` declares `"sideEffects": ["*.css"]`. With the plain `"sideEffects": false` it had before, Rollup is entitled to tree-shake the side-effect-only `import "./app.css"` out of the client build, and the app silently ships with no styles.
- Import the stylesheet as a side effect (`import "./app.css"`), not via a `links` export. The side-effect import lands the file in `assets.routes.<id>.css`, which is one of the fields [server.js](addon/server.js) rewrites with the ingress prefix; an href returned from `links` is not rewritten and would 404 behind ingress.

Check contrast in both themes when touching colours — every piece of text should clear WCAG AA (4.5:1, or 3:1 for large text) against the surface it actually sits on.

## Talking to Home Assistant

Two modules do it, both through the Supervisor's proxy and both authenticated with the `SUPERVISOR_TOKEN` env var that Supervisor injects:

- [addon/app/lib/ha.server.ts](addon/app/lib/ha.server.ts) calls the **REST API** — `/states` for entity autocomplete, `/states/<entity_id>` for a single reading. Every request carries a 10-second deadline; `fetch` has none of its own, and a request HA accepts but never answers is a promise that never settles, which stalls whatever was waiting on it for good.
- [addon/app/lib/ha-live.server.ts](addon/app/lib/ha-live.server.ts) holds one **WebSocket** per process to `ws://supervisor/core/websocket`, subscribed to `state_changed`, and keeps the cache the dashboard actually reads. [docs/feature-live-readings.md](docs/feature-live-readings.md) covers the handshake, why every reconnect re-seeds, and how each hop degrades. `homeassistant_api: true` in config.yaml is what makes both proxies reachable.

Neither the token nor the `supervisor` hostname exists outside HA, so all of it fails locally by design; the UI degrades to a message rather than erroring.

To develop against real-looking data, start [addon/test/ha-mock.js](addon/test/ha-mock.js), which serves both halves, then set `SUPERVISOR_API` to its `apiUrl`, `SUPERVISOR_WS` to its `wsUrl` and `SUPERVISOR_TOKEN` to its token. Unset, those default to the real `http://supervisor/core/api` and `ws://supervisor/core/websocket`.

Two deadlines are overridable, both so a test can reach them in milliseconds rather than in half a minute: `HA_TIMEOUT_MS` for the REST request deadline, and `HA_HEARTBEAT_MS` for the WebSocket's liveness clock — the ping period, with the pong deadline (a third of it) and the handshake deadline (half of it) derived from that one number so they cannot drift into a combination that makes no sense.

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
