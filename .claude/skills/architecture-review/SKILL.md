---
name: architecture-review
description: Review docs/architecture.md against the actual codebase, reconcile the two, and propose architectural improvements as a pull request. Use when asked to run an architecture review, check whether the code still matches the architecture doc, or audit the repo's structure for drift and improvements.
---

# Architecture review

Reconcile [docs/architecture.md](../../../docs/architecture.md) with the code, then look for
improvements. The output is **one pull request**, or nothing at all.

This runs unattended (see the routine in [docs/routines.md](../../../docs/routines.md)), so bias
toward small, well-argued changes a reviewer can check quickly. A PR nobody wants to read is worse
than no PR.

## Step 0 — Branch

Start from an up-to-date `main` and branch:

```bash
git checkout main && git pull --ff-only && git checkout -b chore/architecture-review-$(date +%Y-%m-%d)
```

If the branch already exists, append a counter (`-2`, `-3`, …) rather than reusing it.

## Step 1 — Read the architecture documentation

Read [docs/architecture.md](../../../docs/architecture.md) in full, plus the context it depends on:
[CLAUDE.md](../../../CLAUDE.md), [docs/project.md](../../../docs/project.md), and
[docs/roadmap.md](../../../docs/roadmap.md). The roadmap matters — a gap that the roadmap has
already scheduled is not drift, and should not be "fixed" here.

Write down, for yourself, the concrete claims the doc makes: which directories exist and what each
holds, which files are entry points, which constraints are load-bearing (Node version pin, ingress
handling, `server.js` staying plain JS, Biome instead of ESLint, and so on).

## Step 2 — Verify the codebase still matches

Check each claim against the tree. Look for both directions of drift:

- **Doc says, code doesn't** — files or directories that moved, were renamed, or no longer exist;
  described responsibilities that have since shifted elsewhere.
- **Code does, doc doesn't** — new top-level directories, new route groups, new server-side
  modules, new config files, or a new dependency that changes the shape of the system.
- **Constraints that have quietly eroded** — e.g. TypeScript creeping into files documented as
  plain JavaScript, `trust proxy` being enabled, business logic landing in route modules instead of
  `addon/app/lib/`, or the ingress path handling in [addon/server.js](../../../addon/server.js)
  losing one of its three responsibilities.

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

**Scope rules.** Keep the diff reviewable — roughly one coherent improvement per run, not a
sweep. No behavioral changes to the EMS logic or the UI. No renaming or moving files unless the doc
change alone can't fix the drift. If you find something too large for one PR, describe it in the PR
body as a follow-up instead of starting it.

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

Doc-only runs still need `npm run lint` to pass if any file under `addon/` was touched.

## Step 5 — Commit and open the pull request

Use [Conventional Commits](https://www.conventionalcommits.org/) per
[CLAUDE.md](../../../CLAUDE.md) — typically `docs: …` for a doc-only run, `refactor(addon): …` when
code moved. Then:

```bash
gh pr create --base main --title "<conventional commit subject>" --body "<see below>"
```

The PR body should have three sections mirroring the steps: **Drift found** (each mismatch and
which side was corrected), **Improvements made** (what changed and why), and **Deferred** (anything
noticed but deliberately left alone, so the next run doesn't re-litigate it). Cite files as
`path/to/file.ts:42`.

## If nothing needs changing

That is a normal outcome and the most likely one on most days. Delete the branch, open no PR, and
report what you checked and why it was already consistent. Never open an empty or cosmetic PR to
show activity.
