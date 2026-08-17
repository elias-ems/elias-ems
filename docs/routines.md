# Routines

<!-- Scheduled Claude routines for this repo. Update as they're added, changed, or retired. -->

- **Update dependencies** — every Monday 07:00. Check for outdated npm dependencies in both npm projects — `addon/` and `site/` — update them, run each one's verification gate, and open a PR if everything passes. The procedure lives in the [update-dependencies skill](../.claude/skills/update-dependencies/SKILL.md); the schedule that fires it is registered per-machine (see below).
- **Architecture review** — daily at 07:00 Europe/Brussels (cron `7 5 * * *`, UTC — so it lands an hour earlier in local time over winter). Runs the [`architecture-review`](../.claude/skills/architecture-review/SKILL.md) skill: reconcile [architecture.md](architecture.md) and [roadmap.md](roadmap.md) with the code, look for improvements, and open a PR only if something actually changed. Because it runs every day, it keeps **one** pull request rather than one per run: a single long-lived `chore/architecture-review` branch, rebased onto `main` and added to on each run. Dating the branch per run is what produced a pile of near-duplicate PRs, each re-deriving the same drift from `main` in different words.
- **Bug fixing** — nightly. Check for newly reported bugs (issues) and fix them if any are found.
- **Cloud cost review** — nightly. Review cloud costs and flag or address any unexpected increases.

## How a routine is wired

Two halves, and only one of them is in git:

- **The procedure** — a skill under [.claude/skills/](../.claude/skills/). Versioned, reviewable in a PR, and runnable by hand as `/<skill-name>` when you don't want to wait for the schedule. Any routine whose task is more than a sentence gets one, and the routine's prompt should do nothing but invoke the skill, so the logic has exactly one home.
- **The schedule** — never repo state. A fresh clone gets the procedure but no timer; whoever wants the routine running registers it themselves. Two hosts are in use: a scheduled task registered in Claude Code, stored per-machine under `~/.claude/scheduled-tasks/` (update dependencies), or a cloud agent managed at <https://claude.ai/code/routines> (architecture review).

Scheduled tasks only fire while Claude Code is open — a run that comes due while it is closed happens at next launch instead. Cloud routines fire on their own schedule regardless.
