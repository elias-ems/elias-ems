// Unit tests for the link rewriting in scripts/sync-docs.mjs, run by node's
// built-in test runner — `npm test` from site/. No test framework: this is one
// script's worth of pure string handling, and a runner would be a second
// dependency for the project whose one dependency this repo is trying not to
// let drift.
//
// The build's dead-link check already covers everything that stays on the site,
// so these cover what it cannot see: links that leave for GitHub. A rule that
// turns a source path into a plausible but wrong blob URL ships a 404 and no
// gate notices.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PAGES, rewriteLinks, withBanner } from "../scripts/sync-docs.mjs";

const BLOB = "https://github.com/elias-ems/elias-ems/blob/main";

/** Every doc that gets copied is nested one level deeper than the others, so
 *  rewriting from `docs/features/` is the case that exercises `..` resolution. */
const FROM = "docs/features/battery-control.md";

const rewrite = (target, source = FROM) =>
  rewriteLinks(`[text](${target})`, source).slice("[text](".length, -1);

test("a source file becomes a GitHub blob URL", () => {
  assert.equal(
    rewrite("../../addon/app/lib/control-loop.server.ts"),
    `${BLOB}/addon/app/lib/control-loop.server.ts`,
  );
});

test("a doc that is not published becomes a GitHub blob URL", () => {
  assert.equal(rewrite("../roadmap.md"), `${BLOB}/docs/roadmap.md`);
});

test("a published sibling doc becomes a relative site page", () => {
  assert.equal(rewrite("live-readings.md"), "./live-readings");
  assert.equal(rewrite("diagnostics.md"), "./diagnostics");
});

test("a published doc a directory up becomes a relative site page", () => {
  assert.equal(rewrite("../architecture.md"), "./architecture");
});

test("rewriting from the top-level architecture doc resolves its own paths", () => {
  const source = "docs/architecture.md";
  assert.equal(
    rewrite("features/battery-control.md", source),
    "./battery-control",
  );
  assert.equal(rewrite("../CLAUDE.md", source), `${BLOB}/CLAUDE.md`);
});

test("brackets in a path are percent-encoded", () => {
  assert.equal(
    rewrite("../../addon/app/routes/api.diagnostics[.]txt.tsx"),
    `${BLOB}/addon/app/routes/api.diagnostics%5B.%5Dtxt.tsx`,
  );
});

test("a hash survives both kinds of rewrite", () => {
  assert.equal(rewrite("../architecture.md#ingress"), "./architecture#ingress");
  assert.equal(rewrite("../../CLAUDE.md#theming"), `${BLOB}/CLAUDE.md#theming`);
});

test("links that are already right are left alone", () => {
  for (const target of [
    "https://github.com/elias-ems/elias-ems/issues/4",
    "http://supervisor/core/api",
    "mailto:someone@example.com",
    "#power-limits",
    "/elias-ems/guide/install",
  ]) {
    assert.equal(rewrite(target), target);
  }
});

test("every published page is reachable by its own path", () => {
  // Guards the PAGES keys against a doc being moved in the repo without its
  // entry moving with it: each source, rewritten from a sibling, must resolve
  // to a site page rather than falling through to a GitHub URL.
  for (const [source, page] of PAGES) {
    const from = source.startsWith("docs/features/")
      ? FROM
      : "docs/architecture.md";
    const target = source.replace(from.slice(0, from.lastIndexOf("/") + 1), "");
    if (target === source) continue; // not a sibling; covered above
    assert.equal(rewrite(target, from), `./${page}`);
  }
});

test("the banner goes under the first heading, not above it", () => {
  const out = withBanner("# Battery control\n\nBody.\n", FROM);
  const lines = out.split("\n");

  assert.equal(lines[0], "# Battery control");
  assert.match(out, /::: info Generated page/);
  assert.match(out, new RegExp(`\\(${BLOB.replace(/\//g, "\\/")}/${FROM}\\)`));
  assert.ok(out.endsWith("Body.\n"));
});

test("a document with no heading still gets the banner", () => {
  const out = withBanner("Body only.\n", FROM);

  assert.match(out.split("\n")[1], /::: info Generated page/);
  assert.ok(out.endsWith("Body only.\n"));
});

test("importing the module does not generate anything", async () => {
  // The copying is guarded behind `import.meta.main`; without that, importing
  // it here would wipe and rewrite site/internals/ as a side effect of the
  // tests. Re-importing is a no-op, so a fresh import must still not create it.
  const { readdir } = await import("node:fs/promises");
  const before = await readdir(new URL("../", import.meta.url));

  await import("../scripts/sync-docs.mjs");

  const after = await readdir(new URL("../", import.meta.url));
  assert.deepEqual(after, before);
});
