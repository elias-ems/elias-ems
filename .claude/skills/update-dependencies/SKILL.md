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
| `site/` | The VitePress documentation site. One dependency. | `npm run lint`, `npm run typecheck`, `npm test`, `npm run docs:build` |

Do both in one pass and one PR — `site/` has a single dependency and skipping it
is how it drifts.

**At most one dependency PR is open at a time**, on the long-lived branch
`chore/update-dependencies` — no date in the name. A dated branch per run opens a
second PR beside the first, and two open PRs both rewriting `package-lock.json`
conflict with each other by construction: whichever merges first leaves the other
un-mergeable.

## 1. Start clean, or pick up the open PR

Confirm the working tree is clean — if it is dirty, stop and report it rather than
sweeping unrelated changes into the PR. Then fetch and look for an open
dependency PR:

```bash
git fetch origin
gh pr list --state open --json number,url,title,headRefName \
  --jq '[.[] | select(.headRefName | startswith("chore/update-dependencies"))]'
```

Match on the **prefix** so the dated branches that predate this rule are found
too. `gh` is pinned in [mise.toml](../../../mise.toml) but is not installed
everywhere this runs — a cloud routine has the GitHub MCP tools instead
(`list_pull_requests`, `create_pull_request`, `update_pull_request`). Use
whichever is available.

**No PR open** — branch from current `main`:

```bash
git checkout -B chore/update-dependencies origin/main
```

`-B` is deliberate: a branch of that name can outlive a merged or closed PR, and
reusing its commits would resurrect an update that has already been dealt with.
If the remote branch still exists, the push in step 6 needs `--force-with-lease`.

**A PR open** — rebase it onto `main` and re-derive the update on top:

```bash
git checkout -B chore/update-dependencies origin/chore/update-dependencies
git rebase origin/main
```

A lockfile has no meaningful three-way merge, so if `main` has touched one, expect
the conflict and do **not** hand-resolve it. Take main's copies and let the rest of
this skill regenerate the bump:

```bash
git checkout origin/main -- addon/package.json addon/package-lock.json
git checkout origin/main -- site/package.json site/package-lock.json
git add -A && git rebase --continue   # --skip if the commit is now empty
```

That leaves the branch at main's dependency state, which is the right base: steps
2–5 then produce one update against *current* `main` rather than a stack of bumps
computed against a base that moved. Whatever the earlier run held back is
re-decided this run, not inherited.

If the open PR is on a **dated branch** (or several are open), re-create it on the
fixed name — a PR's head branch can't be moved:
`git checkout -B chore/update-dependencies origin/chore/update-dependencies-<newest-date>`,
carry on as above, open one new PR, then close the dated ones with a comment
pointing at it and delete their branches.

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

From `site/`:

```bash
npm update
npm run lint && npm run typecheck && npm test && npm run docs:build
```

`docs:build` is the one that matters most for a VitePress bump: it is exactly
what [.github/workflows/docs.yml](../../../.github/workflows/docs.yml) runs, and
it fails on a dead link, which is the breakage a new VitePress is most likely to
cause. It regenerates `site/internals/` from `docs/` first; that directory is
gitignored output, so it should not show up in `git status`.

`lint` and `typecheck` here shell out to `addon/node_modules` — the site has no
Biome or TypeScript of its own — so **run step 3 first**, or at least
`npm install` in `addon/`. Without it they fail with a missing-package error
rather than doing nothing, which is the intended behaviour but is easy to
misread as a broken script.

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

## 6. Create or update the PR

Commit as a single Conventional Commit. Scope it to whichever projects actually
moved:

```bash
git commit -am "chore: update dependencies"
```

Use `chore(addon):` or `chore(site):` when only one of them changed. On a rebased
branch this run's work is a **new commit** — don't amend an earlier run's.

Push:

```bash
git push -u origin chore/update-dependencies                     # fresh branch
git push --force-with-lease -u origin chore/update-dependencies  # after a rebase
```

`--force-with-lease`, never a bare `--force`: it aborts rather than overwriting if
someone pushed to the branch since the fetch. The force-push does mark existing
review comments as outdated, so if the PR has feedback, address it in this run's
commit and reply to the thread instead of rewriting silently underneath it.

Then create the PR if none is open, or edit the open one's title and body in place
(`gh pr edit`, or `update_pull_request`) — don't post a per-run comment. Either way
the body describes the branch as it now stands against current `main`, rewritten
rather than appended to:

- The table of what moved, `name  old → new`, grouped by project.
- **Majors held back**, if any, with their version jumps.
- Anything pinned back in step 3, with the reason.
- Which verification commands passed, per project. Say plainly if any were
  skipped.

If neither `gh` nor the MCP tools are available, push the branch and hand back the
compare URL:
`https://github.com/elias-ems/elias-ems/compare/chore/update-dependencies?expand=1`.

## Nothing to do

If `npm outdated` is empty in both projects, do not open an empty PR.

- **No PR open** — delete the branch and report that everything is current.
- **A PR open** — everything current usually means the branch's own bumps are
  already in it; leave the PR alone. Push the rebase only if it changed something
  the reviewer cares about: the PR conflicted with `main` and now doesn't, or the
  regenerated lockfile differs. A weekly force-push that says nothing is noise.
