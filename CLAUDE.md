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
- `npm run start` — run the built server (`node server.js`, a small custom Express server — needed because Home Assistant's ingress proxy strips its dynamic path prefix before forwarding requests here; `server.js` reads the `X-Ingress-Path` header and adds it back so React Router's server-side route matching and the `basename` it hands to the client for hydration both agree with what the browser actually sees. Without it, client-side hydration fails and the app is not interactive when run inside Home Assistant, even though it looks fine on first paint. `react-router-serve` can't do this — it has no hook for per-request `basename`.)

There is no lint or test setup yet.

## Framework and toolchain

The app is **React Router 8 in framework mode** (the successor to Remix — Remix v2's packages were collapsed into `react-router` in v7), written in **TypeScript**.

- React Router 8 requires **Node >= 22.22**, React >= 19.2.7, and Vite 7+. The Docker images pin `node:22-alpine`; do not move to `node:24-alpine` without dropping `armv7` from `config.yaml`, since Node 24 publishes no 32-bit ARM images.
- Routes still use Remix-style file naming under `addon/app/routes/`, wired up by `flatRoutes()` from `@react-router/fs-routes` in [addon/app/routes.ts](addon/app/routes.ts).
- Route modules get generated per-route types in `.react-router/types` (gitignored). Import them as `import type { Route } from "./+types/<route-file-name>"` and prefer `Route.ComponentProps` over `useLoaderData`/`useActionData`. Run `npm run typecheck` after adding or renaming a route so the types exist.
- `json()` and `defer()` were removed in v7 — return plain objects from loaders/actions, and use `data(value, { status })` when you need to set a status code.
- `server.js` stays plain JavaScript on purpose: it is the Node entry point, it imports the generated `build/server/index.js`, and typechecking it would mean either compiling it separately or depending on Node's experimental type stripping. Everything under `addon/app/` is TypeScript.

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
