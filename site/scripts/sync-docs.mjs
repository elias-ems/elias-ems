// Copies the repo's internal docs into site/internals/ as the site's
// "Under the hood" section, rewriting their links on the way.
//
// Those docs are maintained in `docs/` and rewritten by the daily
// architecture-review routine, so a hand-copied version here would drift within
// days. They are copied at build time instead: `docs/` stays the single source
// of truth and `site/internals/` is generated output, gitignored.
//
// The links are the whole reason this is a script rather than a `cp`. A doc in
// `docs/features/` points at `../../addon/app/lib/x.ts` and at its sibling
// docs; on the site the first has to become a GitHub URL and the second a page.
// Anything a rule below doesn't recognise is left alone, and VitePress's
// dead-link check fails the build on it — so the rules do not have to be
// exhaustive to be safe.
//
// Runs as part of `docs:dev` and `docs:build`. It does not watch: editing a file
// under `docs/` while the dev server is up needs a re-run.
//
// The rewriting half is exported and unit-tested; only the file copying at the
// bottom is guarded behind `import.meta.main`, so importing this module has no
// side effects and does not wipe `site/internals/`. The dead-link check cannot
// stand in for those tests — it only sees links that stay on the site, and a
// rule that produces a plausible but wrong GitHub URL passes it.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.resolve(fileURLToPath(import.meta.url), "../..");
const repoRoot = path.resolve(siteDir, "..");
const outDir = path.join(siteDir, "internals");

const BLOB = "https://github.com/elias-ems/elias-ems/blob/main";

// Repo-relative source -> page name under site/internals/. An explicit list
// rather than a glob: which internal docs are public is an editorial decision,
// and `project.md` and `routines.md` deliberately are not.
export const PAGES = new Map([
  ["docs/architecture.md", "architecture"],
  ["docs/features/battery-control.md", "battery-control"],
  ["docs/features/live-readings.md", "live-readings"],
  ["docs/features/diagnostics.md", "diagnostics"],
]);

/** GitHub tolerates raw brackets in a path, but a URL that carries them
 *  unescaped breaks the moment something else parses it. */
const encodePath = (p) => p.replaceAll("[", "%5B").replaceAll("]", "%5D");

function splitHash(target) {
  const at = target.indexOf("#");
  return at === -1 ? [target, ""] : [target.slice(0, at), target.slice(at)];
}

export function rewriteLinks(markdown, source) {
  const fromDir = path.posix.dirname(source);

  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    // Absolute URLs and bare anchors are already right.
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole;

    const [relative, hash] = splitHash(target);
    if (!relative) return whole;

    const resolved = path.posix.normalize(path.posix.join(fromDir, relative));
    const page = PAGES.get(resolved);

    // A sibling page on the site. Relative rather than absolute so it stays
    // correct under the `/elias-ems/` base without VitePress rewriting it.
    if (page) return `](./${page}${hash})`;

    // Everything else — source files, CLAUDE.md, the docs that don't ship — is
    // only readable on GitHub.
    return `](${BLOB}/${encodePath(resolved)}${hash})`;
  });
}

/** Sits under the page's own `# Heading`, so VitePress still takes the title
 *  from the first h1 and the sidebar entry doesn't become the banner. */
export function withBanner(markdown, source) {
  const banner = [
    "",
    "::: info Generated page",
    `This is a copy of [\`${source}\`](${BLOB}/${source}), which lives in the`,
    "repository and is maintained there. Links to source files point at GitHub.",
    ":::",
  ].join("\n");

  const firstHeading = markdown.match(/^#\s.*$/m);
  if (!firstHeading) return `${banner}\n\n${markdown}`;

  const end = firstHeading.index + firstHeading[0].length;
  return `${markdown.slice(0, end)}\n${banner}${markdown.slice(end)}`;
}

if (import.meta.main) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const [source, page] of PAGES) {
    const markdown = await readFile(path.join(repoRoot, source), "utf8");
    const generated =
      "---\neditLink: false\n---\n\n" +
      withBanner(rewriteLinks(markdown, source), source);

    await writeFile(path.join(outDir, `${page}.md`), generated);
  }

  console.log(`synced ${PAGES.size} docs into site/internals/`);
}
