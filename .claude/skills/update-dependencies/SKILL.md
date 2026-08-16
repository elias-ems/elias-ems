---
name: update-dependencies
description: Update the npm dependencies in addon/ and site/, verify the whole toolchain still passes, and open a PR. Use when asked to update, refresh, or bump dependencies, when checking for outdated packages, or when the weekly dependency routine fires.
---

# Update dependencies

Bump the repo's npm dependencies, prove nothing broke, and open a PR.

There are **two npm projects**, each with its own `package.json`, lockfile and
`node_modules`; the repo root has none of the three, so every command below runs
from one directory or the other:

| Project | What it is | Verified by |
| --- | --- | --- |
| `addon/` | The add-on itself. Dozens of dependencies. | `npm run lint`, `npm run typecheck`, `npm run test:all` |
| `site/` | The VitePress documentation site. One dependency. | `npm run docs:build` |

Do both in one pass and one PR — `site/` has a single dependency and skipping it
is how it drifts.

## 1. Start clean

Confirm the working tree is clean and branch from an up-to-date `main`:

```bash
git switch main && git pull && git switch -c chore/update-dependencies-$(date +%Y-%m-%d)
```

If the tree is dirty, stop and report it rather than sweeping unrelated changes
into the PR.

## 2. See what is outdated

Run `npm outdated` in **each** project directory. Split the results into two
piles:

- **In-range (patch/minor)** — satisfied by the existing semver range. These are
  the routine's actual job.
- **Major** — a new major that the range excludes. Do **not** bundle these into
  the same PR. List them in the PR body under "Majors held back", one line each
  with the version jump, so a human can schedule them deliberately.

Note that `npm outdated` compares against the `latest` dist-tag, so a package
whose next major only exists as a pre-release shows up as current. That is the
right answer — see the VitePress note in step 4 — but it means "nothing
outdated" is not the same as "nothing newer exists".

### Packages in `addon/` that need judgement first

- **`@biomejs/biome` is pinned exactly** (no caret) on purpose — Biome's
  formatter output changes between releases, so a floating range would make the
  hook reformat the tree out from under unrelated commits. Bumping it is fine,
  but keep it exact and expect [biome.json](../../../addon/biome.json)-driven
  reformatting; if the diff spreads beyond the packages you bumped, that is why.
- **`@types/node` tracks the Node major, not the newest release.** The Docker
  images pin `node:24-alpine` and [mise.toml](../../../mise.toml) pins the same
  major, so keep `@types/node` on `^24` — `npm outdated` will keep listing it as
  behind `latest`, and that is correct.
- **Bumping `lefthook` needs a follow-up.** npm only runs its postinstall — the
  thing that installs the git hooks — because of the version-pinned
  `allowScripts` entry in [package.json](../../../addon/package.json). A new
  version does not match the pin, so the hooks silently stop installing. Run
  `npm approve-scripts lefthook` from `addon/` after the bump and commit the
  updated pin; `npm install` warning about `allow-scripts` is the tell that you
  forgot.

## 3. `addon/`: apply and verify

```bash
npm update
```

Then re-run `npm outdated` and reconcile: anything still listed is a major you
are deliberately holding back. `npm update` moves `package-lock.json` and only
rewrites `package.json` ranges when a bump needs it — commit both.

Run the full gate, in this order, all from `addon/`:

```bash
npm run lint && npm run typecheck && npm run test:all
```

Notes that save time when one of these goes red:

- `typecheck` runs `react-router typegen` first, so a missing `./+types/...`
  import resolves itself here rather than being a real error.
- `test:all` builds before the integration and e2e suites. E2E needs Chromium:
  `npx playwright install chromium` if Playwright complains it is missing.
- Shut down any hand-started `npm run start:ingress` stack before running the
  suites. Playwright's `reuseExistingServer` cannot distinguish it from its own
  and will run the tests against the real `addon/data`.

If something fails, first decide whether it is the update or a pre-existing
failure — re-run the same command on `main` to find out. Fix breakage caused by
the update. If a single package is the culprit and the fix is not small, drop
that one package back to its previous version, note it in the PR body, and keep
the rest of the update.

## 4. `site/`: apply and verify

Same two commands, from `site/`:

```bash
npm update
npm run docs:build
```

`docs:build` is the whole gate — there is no lint or test suite here. It is also
exactly what [.github/workflows/docs.yml](../../../.github/workflows/docs.yml)
runs, and it fails on a dead link, which is the failure a VitePress bump is most
likely to cause. It regenerates `site/internals/` from `docs/` first; that
directory is gitignored output, so it should not show up in `git status`.

**VitePress 2 is a deliberate hold while it is pre-release.** `vitepress` is the
site's only dependency, and 2.0 has been in alpha for a long time; `latest` is
still 1.x. Do not install `vitepress@next`, and in particular do not reach for it
to clear the audit findings in step 5 — a pre-release build tool publishing the
public site is the worse trade. Check whether the hold can end with:

```bash
npm view vitepress dist-tags
```

If `latest` has moved to 2.x, that is a major: hold it back from this PR like any
other and list it in the body, since it needs its own pass over
[.vitepress/config.ts](../../../site/.vitepress/config.ts) and the generated
`internals/` pages.

## 5. `npm audit`, and the standing exception

Run `npm audit` in both projects. `addon/` should be clean; treat anything there
as real and fix it, or say plainly in the PR body why you did not.

`site/` reports a handful of findings — as of this writing three, one of them
`high` — and they are **known and accepted**, not something to fix:

- Every one of them is in `esbuild` or `vite`, pulled in transitively by
  `vitepress`, and every one is reachable **only through the dev server**:
  requests to `vitepress dev` from another origin
  ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) and
  path handling in the dev server's own file serving
  ([GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff),
  Windows-only, the `high` one). What ships is static HTML from `docs:build`,
  and CI never starts a dev server.
- npm reports `fixAvailable: false`, and it is right: VitePress 1.6.4 is the
  latest stable and pins vite 5. The only fix is the VitePress 2 hold above.

So do not run `npm audit fix --force` (it would install the alpha), and do not
open a PR for these. Do re-read the report each run rather than skipping it: a
new finding that is **not** dev-server-only — one that reaches the built output,
the build itself, or CI — is not covered by this exception and needs to be
raised.

## 6. Open the PR

Commit as a single Conventional Commit. Scope it to whichever projects actually
moved:

```bash
git commit -am "chore: update dependencies"
```

Use `chore(addon):` or `chore(site):` when only one of them changed.

Push and open the PR. The body should carry:

- The table of what moved, `name  old → new`, grouped by project.
- **Majors held back**, if any, with their version jumps.
- Anything pinned back in step 3, with the reason.
- Which verification commands passed, per project. Say plainly if any were
  skipped.

If `gh` is unavailable, push the branch and hand back the compare URL:
`https://github.com/elias-ems/elias-ems/compare/<branch>?expand=1`.

## Nothing to do

If `npm outdated` is empty in both projects, do not open an empty PR. Delete the
branch and report that everything is current.
