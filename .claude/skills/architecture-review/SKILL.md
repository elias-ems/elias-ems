---
name: architecture-review
description: Review docs/architecture.md and docs/roadmap.md against the actual codebase, reconcile the two, and propose architectural improvements as a pull request. Use when asked to run an architecture review, check whether the code still matches the architecture doc, or audit the repo's structure for drift and improvements.
---

# Architecture review

Reconcile [docs/architecture.md](../../../docs/architecture.md) and
[docs/roadmap.md](../../../docs/roadmap.md) with the code, then look for improvements.

**At most one architecture-review pull request is open at a time.** This runs daily and unattended
(see the routine in [docs/routines.md](../../../docs/routines.md)), so a run that opens its own PR
every morning buries the reviewer in near-duplicates inside a week — each one re-deriving the same
drift from `main`, in slightly different words. When a review PR is already open, this run rebases
it onto `main` and continues on that branch. The output is that one PR brought up to date, a new PR
only when none is open, or nothing at all.

Bias toward small, well-argued changes a reviewer can check quickly. A PR nobody wants to read is
worse than no PR.

## Step 0 — Pick up the open pull request, or start one

The branch is always `chore/architecture-review`, with no date in it. One long-lived branch is what
holds the routine to one PR; a dated branch per run is what stacked them up.

```bash
git fetch origin
gh pr list --state open --head chore/architecture-review --json number,url,title
```

`gh` is pinned in [mise.toml](../../../mise.toml) but is **not installed everywhere this runs** — a
cloud routine has the GitHub MCP tools instead (`list_pull_requests`, `create_pull_request`,
`update_pull_request`, `add_issue_comment`). Use whichever is available; every `gh` command below
has an MCP equivalent.

### A PR is open — rebase it and build on it

```bash
git checkout -B chore/architecture-review origin/chore/architecture-review
git rebase origin/main
```

Resolve conflicts in favour of `main` for any passage `main` itself rewrote, then re-apply the point
your commit was making on top of the new text. If `main` has since made that point itself, the
correction is spent: drop the hunk, and `git rebase --skip` a commit that empties out entirely.

Two things to do before reviewing anything, both of which the duplicate PRs skipped:

- **Read the branch's own diff** — `git diff origin/main...HEAD`. Whatever it already corrects is
  done. Do not restate it in different words.
- **Re-check its claims against the new `main`.** A doc correction written three days ago can be
  stale or already true after a rebase; the rebase replays the text, it does not revalidate it. Drop
  what no longer holds.

If the rebase leaves no diff against `main` at all, `main` has absorbed the work: close the PR with
a one-line comment saying so, delete the branch, and report that.

### No PR is open — start clean

```bash
git checkout -B chore/architecture-review origin/main
```

`-B` is deliberate. A local or remote branch of that name can outlive a merged or closed PR, and
reusing its commits would resurrect a diff that has already been dealt with. If the remote branch
still exists, the push in step 5 needs `--force-with-lease`.

### More than one review PR is open

Possible from the dated branches that predate this rule. Adopt the newest as the long-lived one and
close the rest, each with a comment pointing at the survivor. Don't hand-merge their contents —
anything in them that is still true will come back out of this run's own review.

## Step 1 — Read the architecture documentation

Read [docs/architecture.md](../../../docs/architecture.md) in full, plus the context it depends on:
[CLAUDE.md](../../../CLAUDE.md), [docs/project.md](../../../docs/project.md), and
[docs/roadmap.md](../../../docs/roadmap.md). The roadmap is both context and a target here — a gap
the roadmap has already scheduled is not drift and must not be "fixed" in code, but a roadmap item
that has since shipped is drift like any other.

Write down, for yourself, the concrete claims the docs make: which directories exist and what each
holds, which files are entry points, which constraints are load-bearing (Node version pin, ingress
handling, `server.js` staying plain JS, Biome instead of ESLint, and so on), and what the roadmap
still calls outstanding.

## Step 2 — Verify the codebase still matches

Check each claim against the tree. Look for every direction of drift:

- **Doc says, code doesn't** — files or directories that moved, were renamed, or no longer exist;
  described responsibilities that have since shifted elsewhere.
- **Code does, doc doesn't** — new top-level directories, new route groups, new server-side
  modules, new config files, or a new dependency that changes the shape of the system.
- **Constraints that have quietly eroded** — e.g. TypeScript creeping into files documented as
  plain JavaScript, `trust proxy` being enabled, business logic landing in route modules instead of
  `addon/app/lib/`, or the ingress path handling in [addon/server.js](../../../addon/server.js)
  losing one of its three responsibilities.
- **Roadmap behind the code** — an item under "still to do" that has shipped, or a V1 entry whose
  remaining work is no longer what the entry says it is. Correct the entry; do not promote items
  between sections or re-prioritise, which is the human's call.

For every mismatch, decide which side is wrong. **The code is usually right and the doc is stale** —
prefer updating the doc. Only change code when the code genuinely violates a constraint that the
doc is right to state.

## Step 3 — Look for improvements

Only now, with the map verified, look for architectural improvements. Good candidates:

- A module doing two unrelated jobs that would be clearer split.
- Logic duplicated across routes that belongs in `addon/app/lib/`.
- A layering violation — client code reaching into `*.server.ts`, or server-only concerns leaking
  into components.
- A boundary the doc should name but doesn't, so future changes have somewhere obvious to go.

Out of scope here, because other routines or humans own them: dependency upgrades, bug fixes,
feature work from the roadmap, and pure formatting.

**Scope rules.** The budget is per pull request, not per run — a reviewer opens the PR and sees the
branch's whole diff, however many mornings went into it. So: roughly one coherent improvement in the
open PR. If the PR already carries one, this run is limited to doc reconciliation, and anything new
goes under **Deferred** in the body instead. No behavioral changes to the EMS logic or the UI. No
renaming or moving files unless the doc change alone can't fix the drift. If you find something too
large for one PR, describe it under Deferred rather than starting it.

When you do make a change, update [docs/architecture.md](../../../docs/architecture.md) in the same
commit so the doc and the code land together.

## Step 4 — Verify

Any code change must pass, from `addon/`:

```bash
npm install && npm run typecheck && npm run lint && npm test
```

Run `npm run test:integration` as well if you touched [addon/server.js](../../../addon/server.js),
routing, or the build. If a check fails and you can't fix it inside the scope above, revert that
change and carry on with the rest.

A rebase that replayed an earlier run's **code** change onto a moved `main` needs the same gate,
even when this run changed nothing itself: the checks last passed against the old base.

Doc-only runs still need `npm run lint` to pass if any file under `addon/` was touched.

## Step 5 — Commit, then create or update the pull request

Use [Conventional Commits](https://www.conventionalcommits.org/) per
[CLAUDE.md](../../../CLAUDE.md) — typically `docs: …` for a doc-only run, `refactor(addon): …` when
code moved. Add this run's work as a **new commit**; don't amend an earlier run's, so the branch
stays legible as a sequence.

Push:

```bash
# first push of a fresh branch
git push -u origin chore/architecture-review
# after a rebase, or onto a branch left over from a closed PR
git push --force-with-lease -u origin chore/architecture-review
```

`--force-with-lease`, never a bare `--force`: it aborts instead of overwriting if someone pushed to
the branch since the fetch. Be aware that the force-push marks existing review comments as outdated,
so if the PR has review feedback, address it in this run's commit and reply to the thread — don't
quietly rewrite the branch out from under it.

Then the PR itself:

- **None open** — create it.

  ```bash
  gh pr create --base main --title "<conventional commit subject>" --body "<see below>"
  ```

- **One open** — edit the existing title and body in place (`gh pr edit`, or `update_pull_request`).
  Don't post a per-run comment; the body is the running record, and a thread of daily progress notes
  is the same noise as a thread of daily PRs.

Either way the body has three sections mirroring the steps: **Drift found** (each mismatch and which
side was corrected), **Improvements made** (what changed and why), and **Deferred** (anything noticed
but deliberately left alone, so the next run doesn't re-litigate it). Cite files as
`path/to/file.ts:42`. Write all three to describe the **branch's whole diff** as it now stands, not
just today's commit — rewrite the sections rather than appending to them, dropping anything the
rebase made obsolete.

## If nothing needs changing

That is a normal outcome and the most likely one on most days.

- **No PR open** — delete the branch, open nothing, and report what you checked and why it was
  already consistent.
- **A PR open** — leave it alone. Push the rebase only if it changes something the reviewer cares
  about: the PR conflicted with `main` and now doesn't, or the replay altered the diff. A daily
  force-push that says nothing is noise on someone's notifications.

Never open or pad a PR to show activity.
