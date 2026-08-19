# Contributing

The repository is [elias-ems/elias-ems](https://github.com/elias-ems/elias-ems).
Issues and pull requests are welcome — reports from real installations are the
most useful thing right now, since the failure modes that matter most (an
inverter that ignores a target power, an ingress proxy that buffers a stream) cannot
be reproduced outside a real Home Assistant.

If you are here to understand how it works rather than to change it, start with
[Under the hood](/internals/architecture).

## Getting set up

The tools that don't come from npm are pinned in `mise.toml`, and Node itself in
`.node-version` (which mise and CI both read), so
[mise](https://mise.jdx.dev/) installs the lot at the right versions — Node 24
and the GitHub CLI:

```bash
mise install
```

Then, from `addon/`:

```bash
npm install && npm run dev:mock
```

`npm install` is also what installs the git hooks. Playwright needs its browser
downloaded once, with `npx playwright install chromium`.

## The commands

All of these run from `addon/`.

| Command | What it does |
| --- | --- |
| `npm run dev` | The React Router dev server. |
| `npm run dev:mock` | The dev server plus a mock Home Assistant. **This is the one to reach for.** |
| `npm run build` | Production build. |
| `npm run typecheck` | Regenerates route types, then `tsc --strict`. |
| `npm run lint` | Biome — formatting, lint rules and import order. |
| `npm run lint:fix` | The safe fixes, applied. |
| `npm test` | Unit tests (Vitest). Fast, no build needed. |
| `npm run test:integration` | Builds, then drives the real `server.js` behind a mock ingress proxy over HTTP. |
| `npm run test:e2e` | The same stack in Chromium, via Playwright. |
| `npm run test:all` | All three in order. |

There is also `npm run start:ingress`, which brings up the full production stack
behind an ingress proxy. It is the only local setup where the ingress bugs can
show up at all.

## Three things worth knowing before you start

**Ingress is where the surprises live.** Home Assistant serves the add-on behind
a proxy at a path that is only known at request time and is stripped before the
request arrives. `addon/server.js` reconstructs it from a header and uses it for
three different things, each of which was a separate observed failure — the
worst being a page that server-renders perfectly and is completely inert because
every asset URL 404s. Loading the app directly on its port will not surface any
of it. Read the ingress section of
[CLAUDE.md](https://github.com/elias-ems/elias-ems/blob/main/CLAUDE.md) before
touching that file.

**Colours go through a token, never a literal.** `addon/app/app.css` holds
light/dark tokens and components style themselves inline through
`var(--color-*)`. A hardcoded hex is by definition broken in one of the two
themes, which is how the app once ended up dark-grey-on-dark. Check contrast in
both themes when you touch one.

**Each test stack owns its own block of ports**, and they must not overlap.
Playwright cannot tell a manually started stack from one of its own, so when
these collided, running the suite while a dev stack was up made it adopt that
stack and run against real data instead of a throwaway directory.

## Linting

**Biome** is both the linter and the formatter. There is no ESLint and no
Prettier, and adding them is not a small decision: `typescript-eslint` loads the
TypeScript compiler API and throws at import time on the TypeScript version this
repo is on, so ESLint would need a second TypeScript installed purely to feed
the linter. Biome has its own parser and never loads `typescript`.

The tradeoff is that Biome has **no type-aware rules** — nothing like
`no-floating-promises`. `npm run typecheck` is what covers that ground, so keep
running it; lint is not a substitute.

A pre-commit hook formats staged files and re-stages what it fixed. Unfixable
lint errors fail the commit.

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <description>`, imperative mood, lowercase, no trailing
period. Common types are `feat`, `fix`, `docs`, `chore`, `refactor`, `test`,
`ci` and `build`; the scope is optional and usually `addon`.

Run `npm run lint`, `npm run typecheck` and `npm test` before opening a pull
request. If you touched anything the browser renders or the server serves, run
`npm run test:integration` as well.

## Working on the docs

The pages under **Guide** are written by hand and live in `site/` — edit them
there. The pages under **Under the hood** are *generated* at build time from
`docs/` in the repository; the banner on each says which file it came from, and
editing the copy under `site/internals/` would be overwritten on the next build.

To run the site locally, from `site/`:

```bash
npm install && npm run docs:dev
```

`npm run docs:build` is what CI runs, and it fails on dead links.

There are three more commands, and they need `npm install` to have been run in
`addon/` as well — the site has no linter or TypeScript of its own, and borrows
the add-on's rather than installing a second copy of each to disagree with the
first:

| Command | What it does |
| --- | --- |
| `npm run lint` / `lint:fix` | Biome over `.vitepress/config.ts` and the scripts. |
| `npm run typecheck` | `tsc` over `.vitepress/config.ts`. VitePress loads it through esbuild, which strips the types without checking them, so nothing else catches a config option of the wrong type. |
| `npm test` | Node's built-in test runner over the link rewriting in `scripts/sync-docs.mjs`. The dead-link check only sees links that stay on the site, so the tests are what cover the ones that become GitHub URLs. |

That `npm install` prints a handful of audit findings, one of them `high`. They
are known and they are not worth acting on: every one is an `esbuild` or `vite`
advisory that VitePress pulls in, and every one only affects the **dev server** —
cross-origin requests to `vitepress dev`, and its own file serving. What gets
published is static HTML, and CI never starts a dev server. npm reports no fix
because VitePress 1.6.4 is the latest stable release and pins vite 5; the version
that moves off it is VitePress 2, still in alpha. So please don't "fix" it with
`npm audit fix --force` — that installs the pre-release. A finding that is *not*
dev-server-only would be a different matter; those are worth an issue.

## The rest

[CLAUDE.md](https://github.com/elias-ems/elias-ems/blob/main/CLAUDE.md) in the
repository root is the long-form version of all of this: the framework
constraints, the ingress quirks in full, the theming traps, and how the add-on
talks to Home Assistant. It is written as instructions for an AI agent working
in the repo, which makes it blunter than a contributor guide and more complete
than one.
