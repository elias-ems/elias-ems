# Routines

<!-- Scheduled Claude routines for this repo. Update as they're added, changed, or retired. -->

Routines run as cloud agents (managed at <https://claude.ai/code/routines>), so their schedules
live outside this repo. What they *do* belongs in here: a routine whose task is more than a
sentence gets its playbook as a skill under `.claude/skills/`, and the routine prompt just invokes
it. That keeps the instructions versioned, reviewable in a PR, and runnable by hand as
`/<skill-name>`.

- **Update dependencies** — every Monday 10:00. Check for outdated npm dependencies in `addon/`, update them, run the build, and open a PR if everything passes.
- **Architecture review** — daily at 07:00 Europe/Brussels (cron `7 5 * * *`, UTC — so it lands an hour later in local time over winter). Runs the [`architecture-review`](../.claude/skills/architecture-review/SKILL.md) skill: reconcile [architecture.md](architecture.md) with the code, look for improvements, and open a PR only if something actually changed.
- **Bug fixing** — nightly. Check for newly reported bugs (issues) and fix them if any are found.
- **Cloud cost review** — nightly. Review cloud costs and flag or address any unexpected increases.
