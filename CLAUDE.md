# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project description

See [docs/project.md](docs/project.md) for what we're building and architecture decisions, [docs/architecture.md](docs/architecture.md) for repo/code structure, [docs/roadmap.md](docs/roadmap.md) for current and future goals, and [docs/routines.md](docs/routines.md) for scheduled Claude routines. Keep these up to date as the project evolves.

Per-feature docs live in [docs/features/](docs/features), one file per feature: [battery-control.md](docs/features/battery-control.md), [live-readings.md](docs/features/live-readings.md), [diagnostics.md](docs/features/diagnostics.md), [dynamic-prices.md](docs/features/dynamic-prices.md), [pv-curtailment.md](docs/features/pv-curtailment.md).

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

### The documentation site

`site/` is the second npm project — a VitePress site published to GitHub Pages, with its own `package.json`, lockfile and `node_modules`, and one dependency. Run from `site/`:

- `npm run docs:dev` — the site locally.
- `npm run docs:build` — what [.github/workflows/docs.yml](.github/workflows/docs.yml) runs, and the build fails on a dead link. Both commands regenerate the gitignored `site/internals/` from `docs/` first.
- `npm run lint` / `npm run lint:fix` — Biome, same as the add-on's.
- `npm run typecheck` — `tsc` over [.vitepress/config.ts](site/.vitepress/config.ts) and nothing else.
- `npm test` — node's built-in runner over `site/test/`, covering the link rewriting in [sync-docs.mjs](site/scripts/sync-docs.mjs).

The last three exist because there is **no Biome or TypeScript in `site/node_modules`**, and there should not be: two copies of Biome formatting one repo would fight over the same files, and a second TypeScript is a second thing to keep in step. Each script shells out to the add-on's copy with `npm --prefix ../addon exec --no -- <tool>`. Two details in that line matter — `--prefix` puts `addon/node_modules/.bin` on `PATH` while the working directory stays `site/`, and `--no` makes a missing `addon/node_modules` an error rather than a registry download, which matters because an unrelated package on npm is called `biome`. Biome needs `--config-path ../addon` for the same reason; `tsc` finds [site/tsconfig.json](site/tsconfig.json) on its own.

So `npm install` in `addon/` is a prerequisite for linting or typechecking the site. Only `docs:build` and `npm test` stand alone, which is why CI — which installs `site/` alone — runs the build and nothing else.

`config.ts` is the one file that needs typechecking rather than just linting: VitePress loads it through esbuild, which strips the types without checking them, so before this a config option with the wrong type built green and was only wrong at runtime.

Two things about its dependency are settled decisions, so that neither a dependency bump nor an `npm audit` reading re-opens them:

- **`npm audit` in `site/` is expected to be non-empty**, currently three findings including one `high`. All of them are `esbuild`/`vite` advisories reached through `vitepress`, and all of them are **dev-server only** — cross-origin requests to `vitepress dev` and its file serving. What ships is static HTML, and CI never starts a dev server. A *new* finding that reaches the built output or the build itself is not covered by that and needs raising.
- **Stay on VitePress 1.x.** npm reports no fix for the above because 1.6.4 is the latest stable and pins vite 5; the fix is VitePress 2, which is still alpha. Never `npm audit fix --force` here — it installs the pre-release. The [update-dependencies skill](.claude/skills/update-dependencies/SKILL.md) covers this project too and checks each run whether the hold can end.

## Framework and toolchain

The app is **React Router 8 in framework mode** (the successor to Remix — Remix v2's packages were collapsed into `react-router` in v7), written in **TypeScript**.

- React Router 8 requires **Node >= 22.22**, React >= 19.2.7, and Vite 7+, but the add-on itself asks for **Node >= 24** (`engines` in [addon/package.json](addon/package.json), `node:24-alpine` in the Dockerfile, `24.19.0` in [.node-version](.node-version) — the current LTS line). Node 24 publishes no 32-bit ARM builds, which is why [addon/config.yaml](addon/config.yaml) lists only `aarch64` and `amd64`: `armv7` was dropped when Home Assistant itself dropped armv7 support. Keep `@types/node` on `^24` — it tracks the Node major we run, not the newest release.
- Routes still use Remix-style file naming under `addon/app/routes/`, wired up by `flatRoutes()` from `@react-router/fs-routes` in [addon/app/routes.ts](addon/app/routes.ts).
- Route modules get generated per-route types in `.react-router/types` (gitignored). Import them as `import type { Route } from "./+types/<route-file-name>"` and prefer `Route.ComponentProps` over `useLoaderData`/`useActionData`. Run `npm run typecheck` after adding or renaming a route so the types exist.
- `json()` and `defer()` were removed in v7 — return plain objects from loaders/actions, and use `data(value, { status })` when you need to set a status code.
- `server.js` stays plain JavaScript on purpose: it is the Node entry point, it imports the generated `build/server/index.js`, and typechecking it would mean either compiling it separately or depending on Node's experimental type stripping. Everything under `addon/app/` is TypeScript.
- [addon/app/entry.server.tsx](addon/app/entry.server.tsx) is the **stock** entry from `react-router reveal`, owned for exactly one reason: it is the only module the framework loads once when the server process starts, which is where the battery control loop is started. Keep local changes there to that one call — everything else in the file should stay diffable against the template. `app/entry.client.tsx` is deliberately *not* revealed; an unmodified copy would only be one more file to keep in step with the framework. `server.js` cannot do this job instead: it is plain JavaScript and can only import the bundled `build/server/index.js`, which exports no route or lib module.

## Linting and formatting

**Biome** ([addon/biome.json](addon/biome.json)) is both the linter and the formatter, for `site/` as well as `addon/` — one copy and one config for the whole repo. It lives in `addon/` only because that is the project with a `node_modules`; the two `!**/.vitepress/*` excludes in the config are there to keep it out of the site's build output. There is no ESLint and no Prettier, and adding them is not a small decision:

- **ESLint is currently blocked.** `typescript-eslint` imports the TypeScript compiler API and throws at import time on TypeScript >= 7 (its peer range is `>=4.8.4 <6.1.0`). This repo is on TypeScript 7, so ESLint would need a TypeScript 6 installed side by side purely to feed the linter. Biome has its own parser and never loads `typescript`, which sidesteps the problem entirely.
- The tradeoff is that Biome has **no type-aware rules** — nothing like `no-floating-promises`. `npm run typecheck` (`tsc --strict`) is what covers that ground, so keep running it; lint is not a substitute.
- Config matches the code that already existed rather than Biome's defaults: 2-space indent (Biome defaults to tabs), double quotes, semicolons, 80-column width.
- Suppress a rule with `// biome-ignore lint/<group>/<rule>: <reason>`. It only binds to the **immediately following line**, so put any longer explanation in normal comments *above* it, and note that a diagnostic on a JSX attribute needs the comment inside the opening tag, next to the attribute.

Two suppressions exist on purpose and should not be "fixed": the `role="listbox"` on the suggestions `ul` in [EntityAutocomplete.tsx](addon/app/components/EntityAutocomplete.tsx) is the correct ARIA combobox pattern, and the debounce effect there deliberately omits `fetcher.load` because `useFetcher` returns a new object every render.

## Git hooks

**lefthook** ([lefthook.yml](lefthook.yml)) runs `biome check --write` over staged files on pre-commit and re-stages what it fixed; unfixable lint errors fail the commit. Skip it for one command with `LEFTHOOK=0 git commit ...`.

There are two jobs, one per project, because the invocation differs: the `addon/` job sets `root: "addon/"` and calls `npx biome`, while the `site/` job takes no `root` — so `{staged_files}` stays repo-root-relative — and reaches across with `npm --prefix addon exec --no --`, exactly as the site's own npm scripts do. Neither job typechecks or tests; that is the same split as in `addon/`, where lint is a pre-commit concern and the rest is not.

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

## Continuous integration

Two workflows, both on `ubuntu-24.04` and both installing Node with `actions/setup-node`:

- [.github/workflows/docs.yml](.github/workflows/docs.yml) — builds the site on pull requests touching `site/`, `docs/` or itself, and deploys from `main`.
- [.github/workflows/ci.yml](.github/workflows/ci.yml) — three jobs covering everything else: `addon` (lint, typecheck, unit tests), `addon-integration` (build, then the integration suite), and `site` (lint, typecheck, the link-rewriting tests).

**The end-to-end suite does not run in CI yet.** Its first run hung for four hours on `npx playwright install --with-deps chromium` — not failing, just never returning, so nothing would have ended it but the 6-hour default job timeout. The browser half is off until that is diagnosed; the integration suite needs no browser and so cannot hit the same wall, and `npm run test:e2e` locally still covers the ground. The steps to restore — a `~/.cache/ms-playwright` cache keyed on the installed Playwright version, the two install steps, the report upload — are in ci.yml's history at commit 9d68687. Every job now sets `timeout-minutes`, so a repeat costs minutes rather than hours.

Points worth not re-deriving:

- **`ci.yml` carries no `paths:` filter, on purpose.** A path-filtered workflow reports *nothing* on a pull request that misses the filter, so a check that is both required and filtered blocks the PR forever waiting for a run that will never come. docs.yml can afford filters precisely because it is not a required check.
- **The runners are pinned rather than `ubuntu-latest`.** GitHub migrates that label on its own schedule, and the migration lands mid-pull-request with no commit to blame.
- **Node's version lives in [.node-version](.node-version), not in [mise.toml](mise.toml).** `setup-node`'s `node-version-file` reads `package.json`, `.nvmrc`, `.node-version` and `.tool-versions` — never a `mise.toml` — so leaving the number there would have meant maintaining it twice. mise reads `.node-version` too, but only because of the `idiomatic_version_file_enable_tools = ["node"]` setting in mise.toml: idiomatic version files are **off by default** in mise, and dropping that setting silently leaves local shells with no pinned Node at all. mise.toml still owns `gh`, which has no such file.
- **`addon-integration` calls `vitest` directly** after its own `npm run build`, rather than going through `test:integration` — that script runs `npm run build` first, so using it would build twice.
- **When e2e does come back, `mcr.microsoft.com/playwright:<version>-noble` is the obvious thing to try**, since it ships the browsers and their system libraries and so skips the install step that hung. The cost is that the image tag has to be bumped in lockstep with `@playwright/test`, and a mismatch fails obscurely.
- **A container image is the wrong runner for this repo.** Matching the Dockerfile with `node:24-alpine` sounds appealing and cannot work: Playwright publishes no musl browser builds, and `install --with-deps` shells out to `apt-get`. What `node:24-alpine` would actually validate is the *image build*, and the way to check that is to build the Dockerfile — a job that does not exist yet.
- **The lint/typecheck/test steps within a job run even after an earlier one fails** (`if: ${{ !cancelled() && steps.install.outcome == 'success' }}`), so one lint error doesn't hide a type error. The install guard is the part that matters: plain `!cancelled()` would keep running the checks after `npm ci` itself had failed.
- **The `site` job installs *both* projects.** `site`'s `lint` and `typecheck` shell out to the add-on's Biome and tsc with `--no`, which makes a missing `addon/node_modules` an error rather than a download.
- lefthook's postinstall skips itself when `CI` is set, so CI checkouts correctly get no git hooks.

Nothing enforces these on merge by itself — the job names have to be added as **required status checks** on `main` in the repository settings for a red run to block anything.

## Home Assistant ingress

HA serves the add-on through a proxy at `/api/hassio_ingress/<session-token>/`, a prefix that is only known at request time and is stripped before the request reaches us. [addon/server.js](addon/server.js) reads it from the `X-Ingress-Path` header and does three things with it. All three are needed; each was a separate observed failure.

1. **`basename`** — so React Router's server-side matching and the basename it embeds for client hydration agree with the browser's real URL.
2. **Rewrites the asset manifest** — `basename` does *not* affect asset URLs. Vite bakes them in at build time from `publicPath`, which is a fixed `/`, so they render as `/assets/x.js`; the browser resolves that against the HA origin, where nothing is served, and every script 404s. The page still server-renders, so the symptom is a page that looks right but is completely inert. `server.js` prefixes `assets.url`, `assets.entry`, and every route's `module`/`imports`/`css`. Do *not* prefix `routeDiscovery.manifestPath` — React Router already resolves that against `basename`.
3. **Gives `basename` a trailing slash** — React Router derives the `to="/"` href from `basename` verbatim, and HA 404s a bare `/api/hassio_ingress/<token>` with no trailing slash. Without it the Home link points at a URL that dies on reload.

Three related notes:

- **There is no HA toolbar to hook into.** HA renders the panel as a bare cross-origin iframe with no header of its own above it on desktop, and offers the add-on no way to add anything to HA's chrome. The bar ESPHome and the Matter server appear to contribute to HA's own UI is really the first element inside their iframe. Ours is [AppHeader.tsx](addon/app/components/AppHeader.tsx), which is why it styles itself as a Material top app bar rather than as page content.
- Express `trust proxy` must stay **off**. HA normally forwards the browser's original `Host` untouched, which is exactly what React Router's action-origin CSRF check needs. Turning `trust proxy` on would make Express build `req.url` from `X-Forwarded-Host` instead, so the check would compare that header against the `Origin` header and pass by construction rather than by the two agreeing.
- **The origin check runs on actions only, which is what makes it so hard to recognise.** Where `Origin` and `Host` disagree, every page renders perfectly and every save fails; the browser gets the error boundary over "Unexpected Server Error", and the add-on log gets `Error: Bad Request` thrown from `singleFetchAction` — neither of which mentions an origin, a host, or each other. They disagree when HA is reached through Nabu Casa or a reverse proxy, where the `Host` arriving here is the internal name while the browser posts from the public one. `server.js` therefore also allows the host named in **`X-Forwarded-Host`**, which such a proxy sets, and logs a line naming all three values the first time it sees a disagreement it cannot resolve. Trusting that header is safe here and would not be in general: config.yaml declares `ingress: true` with no `ports:`, so nothing but Supervisor's proxy can reach this port to forge it. [ingress-proxy.js](addon/test/ingress-proxy.js) reproduces the *working* shape on purpose — the other one is covered by posting at `directUrl` with the headers such a proxy sends.
- To reproduce ingress locally, run [addon/test/ingress-proxy.js](addon/test/ingress-proxy.js) in front of `npm run start`. Loading the app directly on port 3000 will not surface any of the bugs above, because there is no prefix to get wrong.

## Failing well in the browser

Every background request the page makes goes through `useFetchedJson` or
`usePolledJson` in [json-fetch.ts](addon/app/lib/json-fetch.ts) — a plain
`fetch`, with a failed round kept as a flag rather than thrown. **Do not
reach for `useFetcher().load()` or `useRevalidator().revalidate()` for
anything on a timer**, however much shorter it is.

The reason is what React Router does with a rejected `fetch`: inside its data
layer that is a *route error*, and a route error replaces the page with the
nearest `ErrorBoundary`. That is right for a navigation somebody asked for and
wrong for a poll firing every two seconds — Home Assistant restarts, a tunnel
blinks, a laptop wakes up, and the dashboard someone left open is gone until
they reload it. It reached production as a bare "TypeError: Failed to fetch"
over a minified stack trace, which is React Router's own default boundary; the
app had none of its own.

Three consequences worth keeping:

- **`root.tsx` exports `Layout`, the component, and `ErrorBoundary` separately.**
  The framework renders an error page inside the root `Layout` if there is one
  and inside a bare document of its own if there isn't, so collapsing the shell
  back into the default export would silently cost the error page its
  stylesheet, its navigation and its `Scripts`.
- **A hand-rolled `fetch` has to resolve its URL through `useHref`.** A fetcher
  applied the `basename` for us; a bare `/api/whatever` resolves against the
  Home Assistant origin, where this app is not served. Same trap as the asset
  manifest — see [Home Assistant ingress](#home-assistant-ingress).
- **Say when a poll is failing.** Both hooks return `failing` beside the data,
  and every caller shows something ("not updating", the **Offline** chip):
  silently holding the last values is the failure mode the health chip exists
  to prevent.

Form submissions still go through `<Form method="post">` and still land on the
error boundary when the connection drops. That is deliberate — a save that
didn't happen has to say so — and it is why the boundary distinguishes a
`TypeError` from a real fault and offers a retry.

## Theming

[addon/app/app.css](addon/app/app.css) is the only stylesheet, and it exists to hold the light/dark colour tokens. Components keep styling themselves with inline `style` objects, but every colour goes through a `var(--color-*)` — **never a literal hex**. A hardcoded colour is by definition broken in one of the two themes, which is exactly how the app ended up dark-grey-on-dark before the tokens existed.

There is one standing exception, and it is the same exception each time: **an inline style cannot express a pseudo-class or a media query**, so those live in app.css and nothing else does. Today that is `.visually-hidden`, the `code` rule (below), the `Top bar` block, and the `Page and dashboard layout` block, which owns every breakpoint in the app — the dashboard's cards are one column on a phone and two or three once there is room, the settings cards flow into as many as three, and the rule dividing a card's sections turns from a left edge into a top one as they stack. If a rule *could* be an inline style, it should be one; the stylesheet is not a general-purpose place to put styling.

Four things in that block are worth not re-deriving:

- **Every page is full width.** `.page` is the shell all three routes share, and it is padding and nothing else — no cap. Home Assistant's own panels use the whole panel, and an add-on that stops at a 640px column reads as a page that failed to load rather than one that was designed. What bounds a readable *measure* is the card, or a `maxWidth` on the one paragraph or form inside it; never the page.
- **The breakpoints come from what each card needs, not from device widths.** The price chart stops being legible when scaled below ~560px, four table columns stop fitting at ~620px, a settings card stops being comfortable under ~30rem, and so on. Each is commented with its reason.
- **A declaration a media query has to override cannot be inline.** An inline style outranks any stylesheet rule, however specific its selector. `display: grid` set inline on a decision-feed row silently defeated the phone rule that hides all but the first three — invisibly, because the page still looked plausible with eight. That one `display` therefore lives in app.css while the rest of the row's styling stays inline. The top bar had it worse: four of the five declarations in its phone block did nothing — three overridden by an inline style in `AppHeader.tsx`, the fourth naming a class no element carried — so the bar never tightened at all. The rule that falls out of both: **when a property changes with the viewport, both its values go in app.css**, and the component keeps only what does not move. `.page`, `.dash`, `.dash-metric` and `.app-header` all carry base and override together for that reason. Check for the same trap before adding a breakpoint that toggles something a component sets on itself.
- **Two of the pieces render twice**, with CSS showing one at a time (`.dash-chart-*`, `.dash-wide-only`/`.dash-narrow-only`). This is deliberate and neither is reachable by rearranging one set of markup. An SVG scaled into a phone column scales its axis labels down with it until they are four pixels tall, so the chart needs a *different plot geometry*, not a smaller copy of the same one. The wide one goes further and redraws itself for the width it is given ([PriceChart.tsx](addon/app/components/dashboard/PriceChart.tsx)): the same scaling works upwards, and a fixed viewBox at `width: 100%` on a full-width card was rendering 10px axis labels at 25px. Only the plot *width* is recomputed, from a `ResizeObserver`, which keeps the chart at 1:1 at any size; it measures `null` on the server and on the first client render, so hydration still matches. And the device table needs a real `<table>` on a panel and a list of rows on a phone: restyling table elements with `display` keeps the markup and throws the semantics away — a `<td>` set to `block` stops being a cell, and a hidden `<thead>` takes the column headers out of the accessibility tree with it. `display: none` removes the hidden copy from that tree too, so only one is ever announced. The cost lands on Playwright, where a bare `getByText` for a reading is two matches and a strict-mode violation; [app.spec.ts](addon/test/e2e/app.spec.ts) has an `onScreen` helper that filters to the visible copy.

Three things make the theme actually follow Home Assistant:

- **`color-scheme: light dark`** on `:root`. HA's own CSS custom properties do not cross the ingress iframe boundary, so the add-on cannot read HA's theme variables — but the browser *does* propagate the embedding document's used `color-scheme` into the iframe. That propagated value is what tells the app which theme HA is in. It also makes the browser restyle native controls (buttons, scrollbars, the page canvas) for dark, which no amount of our own CSS would do.
- **`light-dark()`** for each token, rather than a `prefers-color-scheme` media query. `light-dark()` resolves against the computed `color-scheme` property, so the declaration above is the single switch for the whole palette: forcing a theme later (an explicit user preference, say) means overriding that one property and nothing else. A media query would ignore it and keep following the OS.
- **The `<meta name="color-scheme">`** in [root.tsx](addon/app/root.tsx) duplicates the CSS declaration on purpose — it is parsed before the stylesheet loads, so the first paint of the canvas is already the right colour instead of flashing white.

Four traps worth knowing:

- The top bar is the one exception to "no rules, only tokens" in app.css: `.app-header :focus-visible` overrides the focus outline colour, because the page's focus blue only manages 1.3:1 against the bar's own blue and a pseudo-class is the one thing an inline style cannot express — and its five spacing properties are there because they change at 480px, where "Elias ems" plus three tabs stops having slack: 341px needed at full size, 261px tightened. Its `--color-header-bg` is *not* HA's `#03a9f4` — white on that is 2.2:1 — but a darkened blue that clears AA in both themes.
- `code` carries `overflow-wrap: anywhere`, which is not cosmetic. Nearly every one of them holds an entity id, an id has no space or hyphen for the browser to break at, and a word that cannot break sets a floor under how narrow its column can be — the settings page scrolled sideways on a phone until this was added.
- `addon/package.json` declares `"sideEffects": ["*.css"]`. With the plain `"sideEffects": false` it had before, Rollup is entitled to tree-shake the side-effect-only `import "./app.css"` out of the client build, and the app silently ships with no styles.
- Import the stylesheet as a side effect (`import "./app.css"`), not via a `links` export. The side-effect import lands the file in `assets.routes.<id>.css`, which is one of the fields [server.js](addon/server.js) rewrites with the ingress prefix; an href returned from `links` is not rewritten and would 404 behind ingress.

Check contrast in both themes when touching colours — every piece of text should clear WCAG AA (4.5:1, or 3:1 for large text) against the surface it actually sits on.

The place to do that check is the **component playground** at `/playground` ([playground.tsx](addon/app/routes/playground.tsx)), linked from the Debug section at the foot of Tools and from nowhere else. It renders every component against fixtures from [playground-fixtures.ts](addon/app/lib/playground-fixtures.ts), including the states a working installation never reaches — an unavailable sensor, a rejected form, a loop enabled but not running — so both repo-wide rules can be checked in one scroll: every token beside every component in whichever theme is active, and every breakpoint at once, with a ruler at the top saying which side of each the window is on. Three things about it are deliberate:

- **It ships rather than being stripped from the production build.** The theme it exists to be checked against is Home Assistant's, and that only reaches the app through the ingress iframe — so the check has to be runnable inside a real panel, not only against `npm run dev`.
- **Its fixtures take a `now` from the loader** rather than reading a clock during render. Several of them carry timestamps, some of which are printed verbatim, and a `Date.now()` on each side of the wire is a hydration mismatch.
- **The route has an `action`.** The settings sections post to whichever route renders them, so without one the first Save would be a 405. It reports the fields and saves nothing; the playground must never write to `addon/data`.

The two components under [components/playground/](addon/app/components/playground/) are the page's own chrome, and the only components with no specimen — cataloguing them would be the page describing itself.

## Talking to Home Assistant

Two modules do it, both through the Supervisor's proxy and both authenticated with the `SUPERVISOR_TOKEN` env var that Supervisor injects:

- [addon/app/lib/ha.server.ts](addon/app/lib/ha.server.ts) calls the **REST API** — `/states` for entity autocomplete, `/states/<entity_id>` for a single reading. Every request carries a 10-second deadline; `fetch` has none of its own, and a request HA accepts but never answers is a promise that never settles, which stalls whatever was waiting on it for good.
- [addon/app/lib/ha-live.server.ts](addon/app/lib/ha-live.server.ts) holds one **WebSocket** per process to `ws://supervisor/core/websocket`, subscribed to `state_changed`, and keeps the cache the dashboard actually reads. [docs/features/live-readings.md](docs/features/live-readings.md) covers the handshake, why every reconnect re-seeds, and how each hop degrades. `homeassistant_api: true` in config.yaml is what makes both proxies reachable.

Neither the token nor the `supervisor` hostname exists outside HA, so all of it fails locally by design; the UI degrades to a message rather than erroring.

To develop against real-looking data, start [addon/test/ha-mock.js](addon/test/ha-mock.js), which serves both halves, then set `SUPERVISOR_API` to its `apiUrl`, `SUPERVISOR_WS` to its `wsUrl` and `SUPERVISOR_TOKEN` to its token. Unset, those default to the real `http://supervisor/core/api` and `ws://supervisor/core/websocket`.

Two deadlines are overridable, both so a test can reach them in milliseconds rather than in half a minute: `HA_TIMEOUT_MS` for the REST request deadline, and `HA_HEARTBEAT_MS` for the WebSocket's liveness clock — the ping period, with the pong deadline (a third of it) and the handshake deadline (half of it) derived from that one number so they cannot drift into a combination that makes no sense.

`addon/test/` holds the harness (`ha-mock.js`, `ingress-proxy.js`, `stack.js`, `dev.js`, `listen.js`) alongside the suites in `unit/`, `integration/`, and `e2e/`. The harness files are plain JavaScript for the same reason `server.js` is: node runs them directly, with no build step in front.

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
