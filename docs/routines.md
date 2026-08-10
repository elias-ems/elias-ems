# Routines

<!-- Scheduled Claude routines for this repo. Update as they're added, changed, or retired. -->

- **Update dependencies** — every Monday 07:00. Check for outdated npm dependencies in `addon/`, update them, run the build, and open a PR if everything passes. The procedure lives in the [update-dependencies skill](../.claude/skills/update-dependencies/SKILL.md); the schedule that fires it is registered per-machine (see below).
- **Architecture review** — nightly. Review the codebase against [architecture.md](architecture.md); update the doc or make code changes to keep the architecture clean and consistent.
- **Bug fixing** — nightly. Check for newly reported bugs (issues) and fix them if any are found.
- **Cloud cost review** — nightly. Review cloud costs and flag or address any unexpected increases.

## How a routine is wired

Two halves, and only one of them is in git:

- **The procedure** — a skill under [.claude/skills/](../.claude/skills/). Versioned, reviewable in a PR, and runnable by hand as `/<skill-name>` when you don't want to wait for the schedule.
- **The schedule** — a scheduled task registered in Claude Code, stored per-machine under `~/.claude/scheduled-tasks/`. It is not repo state, so a fresh clone gets the procedure but no timer; whoever wants the routine running registers it on their own machine. Its prompt should do nothing but invoke the skill, so the logic has exactly one home.

Scheduled tasks only fire while Claude Code is open. A run that comes due while it is closed happens at next launch instead.

