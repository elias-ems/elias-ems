---
name: update-dependencies
description: Update the addon/ npm dependencies, verify the whole toolchain still passes, and open a PR. Use when asked to update, refresh, or bump dependencies, when checking for outdated packages, or when the weekly dependency routine fires.
---

# Update dependencies

Bump `addon/`'s npm dependencies, prove nothing broke, and open a PR. Everything
runs from `addon/` — that is where `package.json` lives; the repo root has no
`node_modules`.

## 1. Start clean

Confirm the working tree is clean and branch from an up-to-date `main`:

```bash
git switch main && git pull && git switch -c chore/update-dependencies-$(date +%Y-%m-%d)
```

If the tree is dirty, stop and report it rather than sweeping unrelated changes
into the PR.

## 2. See what is outdated

```bash
npm outdated
```

Split the results into two piles:

- **In-range (patch/minor)** — satisfied by the existing semver range. These are
  the routine's actual job.
- **Major** — a new major that the range excludes. Do **not** bundle these into
  the same PR. List them in the PR body under "Majors held back", one line each
  with the version jump, so a human can schedule them deliberately.

Two packages need judgement before you touch them:

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

## 3. Apply the in-range updates

```bash
npm update
```

Then re-run `npm outdated` and reconcile: anything still listed is a major you
are deliberately holding back. `npm update` moves `package-lock.json` and only
rewrites `package.json` ranges when a bump needs it — commit both.

## 4. Verify

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

## 5. Open the PR

Commit as a single Conventional Commit:

```bash
git commit -am "chore(addon): update dependencies"
```

Push and open the PR. The body should carry:

- The table of what moved, `name  old → new`.
- **Majors held back**, if any, with their version jumps.
- Anything pinned back in step 4, with the reason.
- Which verification commands passed. Say plainly if any were skipped.

If `gh` is unavailable, push the branch and hand back the compare URL:
`https://github.com/elias-ems/elias-ems/compare/<branch>?expand=1`.

## Nothing to do

If `npm outdated` is empty, do not open an empty PR. Delete the branch and
report that everything is current.
