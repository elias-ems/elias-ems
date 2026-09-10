# Publish prebuilt add-on images to GHCR, driven by GitHub releases

## Context

Installing the add-on today makes Home Assistant build the container on the
user's own machine: `addon/config.yaml` has no `image:` key, so Supervisor
clones the repo and runs `addon/Dockerfile` locally — `npm install` twice and a
full Vite build on whatever SD card or SSD the HA box has. That is the "give it
a few minutes" step both README.md and `site/guide/install.md` currently
apologise for, and it is also the step with the most ways to fail: a transient
npm registry hiccup, a slow ARM box, a base image that moved.

Home Assistant's documented preference is prebuilt images ("this makes the
installation process fast and has almost no chance of failure, so it is the
preferred method"). The move is: build `amd64` and `aarch64` in GitHub Actions,
push them to GHCR as a multi-arch manifest, and point `config.yaml` at that
image. Install and update become a pull.

Three mechanics shape the design, all verified rather than assumed:

- **Supervisor reads `version` from `addon/config.yaml` on the default branch**
  and compares it to what is installed — nothing else. Its store reload task
  runs every 3 hours (`RUN_RELOAD_APPS = 10800` in `supervisor/misc/tasks.py`),
  plus on Supervisor start and on a manual "Check for updates". So a version
  visible on `main` with no image behind it is an update that fails on pull.
- **Supervisor pulls with an explicit platform** (`platform = MAP_ARCH[...]` in
  `supervisor/docker/interface.py`), which is what makes one generic multi-arch
  image name work; the `{arch}` placeholder is legacy compatibility only.
- **`main` has a ruleset, but it only blocks deletion and non-fast-forward** —
  no pull request requirement — so a workflow holding `contents: write` can
  push to it directly.

That last point is what lets the release be the *only* gesture: **publishing a
GitHub release builds and pushes the images first, and only then writes the new
version into `addon/config.yaml` on `main`.** Main therefore never advertises a
version whose image does not already exist — the failure window is zero, not
merely short — and no release needs a pull request. Ordinary feature PRs stop
touching `version` altogether.

Note that `home-assistant/builder@master` is **deprecated** and slated for
removal. The current path is the composite actions in that same repo, pinned to
a release tag — latest is `2026.06.0`.

## Approach

### 1. New workflow: `.github/workflows/image.yml`

Modelled on the builder repo's example workflow and on
`home-assistant/addons-example`'s `build-app.yaml`, collapsed to one add-on and
extended with the bump-back job.

```yaml
name: Add-on image

on:
  release:
    types: [published]
  pull_request:
    paths:
      - "addon/Dockerfile"
      - "addon/.dockerignore"
      - ".github/workflows/image.yml"
  workflow_dispatch:
    inputs:
      version:
        description: Version to (re)publish, e.g. 1.0.0-alpha.39
        required: true
      force:
        description: Overwrite the tag if it already exists
        type: boolean
        default: false

env:
  ARCHITECTURES: '["amd64", "aarch64"]'
  IMAGE_NAME: elias-ems

permissions:
  contents: read

concurrency:
  group: image-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

`workflow_dispatch` is the escape hatch for a release whose build failed
halfway — re-running it republishes without cutting a second release.

The `paths:` filter is safe here for the same reason docs.yml's is: this
workflow is **not** a required status check. (`ci.yml`'s comment about filtered
required checks still stands and is why that one has none.)

The PR filter is deliberately narrow — `ci.yml`'s `addon-integration` job
already runs `npm run build` on every PR, so a TypeScript or Vite break is
caught there and an image build would only re-prove it. What an image build
proves that nothing else does is that the **Dockerfile** and the **build
context** still work. `.dockerignore` is in the list for that second reason: it
can exclude a file the build needs and break the image with nothing else in the
repo changing. Drop that one line if you want it strictly Dockerfile-only.

Four jobs:

- **`init`** — resolve and validate the version, then build the matrix.
  - A release tag must be `v<semver>`; anything without the `v` prefix fails
    before a build starts. The normalized version is that tag with its required
    `v` stripped, or the dispatch input, or — on a PR, where nothing is pushed
    and it only feeds a label — the current `version` out of
    `addon/config.yaml` via plain `sed` (no `yq`: the ARM runner image is not
    guaranteed to carry it).
  - Fail fast on a release tag that is not `v` followed by a valid version
    (`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`), then validate the
    normalized version as a Docker tag.
  - Fail if `docker buildx imagetools inspect ghcr.io/elias-ems/elias-ems:<v>`
    already resolves, unless `force`. Re-using a published version is the one
    mistake Supervisor cannot recover from on the user's side: they already
    have that version string installed and will never be offered it again.
  - `publish` = the event is `release` or `workflow_dispatch`.
  - Matrix from
    `home-assistant/builder/actions/prepare-multi-arch-matrix@2026.06.0` with
    `architectures: ${{ env.ARCHITECTURES }}`, `image-name: elias-ems`,
    `registry-prefix: ghcr.io/elias-ems`.

  Outputs: `version`, `publish`, `matrix`.

- **`build`** — `strategy.matrix: ${{ fromJSON(needs.init.outputs.matrix) }}`,
  `runs-on: ${{ matrix.os }}`. The matrix action maps `amd64 → ubuntu-24.04`
  and `aarch64 → ubuntu-24.04-arm`, so both build **natively** — no QEMU, and
  ARM runners are free on public repos, which this one is. Permissions
  `contents: read`, `id-token: write` (Cosign), `packages: write`. Then
  `home-assistant/builder/actions/build-image@2026.06.0`:

  ```yaml
  arch: ${{ matrix.arch }}
  context: "./addon"
  image: ${{ matrix.image }}          # ghcr.io/elias-ems/{amd64,aarch64}-elias-ems
  image-tags: |
    ${{ needs.init.outputs.version }}
    latest
  labels: |
    io.hass.type=addon
    io.hass.name=Elias ems
    io.hass.description=Home Energy Management System (HEMS) that complements and extends Home Assistant
    io.hass.url=https://elias-ems.github.io/elias-ems/
  push: ${{ needs.init.outputs.publish }}
  version: ${{ needs.init.outputs.version }}
  container-registry-password: ${{ secrets.GITHUB_TOKEN }}
  ```

  Checkout uses `ref: ${{ github.event.release.tag_name }}` on a release, so
  the image is built from the tagged commit rather than from whatever `main`
  has drifted to. `io.hass.*` labels are informational — Supervisor validates
  none of them on pull — but they are what the store and `docker inspect`
  show; `arch` and `version` labels are added by the action itself. On a PR,
  `push: false`, so the registry login and Cosign signing steps skip
  themselves while the build still fails the job if the Dockerfile is broken.
  `timeout-minutes: 30`, matching this repo's habit of never leaving a job on
  the 6-hour default.

- **`manifest`** — `if: needs.init.outputs.publish == 'true'`, needs both,
  `publish-multi-arch-manifest@2026.06.0` with the same architectures, image
  name, registry prefix and tags. This is what creates
  `ghcr.io/elias-ems/elias-ems:<version>` and `:latest` from the two per-arch
  images. `latest` always moves, prerelease or not — Supervisor never looks at
  it, but `build-image` reads it back as its registry cache source.

- **`bump`** — the piece that makes releases PR-free. `needs: [init, manifest]`,
  `if: needs.init.outputs.publish == 'true'`, `permissions: contents: write`.
  Checks out `main`, rewrites the `version:` line in `addon/config.yaml` with
  `sed`, and if anything changed commits as `github-actions[bot]` with
  `chore(release): <version> [skip ci]` and pushes. Idempotent: a re-run where
  the version already matches exits clean. `[skip ci]` keeps the bot commit
  from re-running lint and tests over a one-line change. Note the hooks in
  `lefthook.yml` are not involved — CI checkouts never install them.

  Because this job runs *after* `manifest`, `main` only ever names a version
  that is already pullable.

Caching, for expectations: `build-image` writes a GHA cache scoped per arch and
BuildKit inline cache into the pushed image, then reads `:latest` back next
run. A PR-branch GHA cache is not visible to other branches, so a release build
does repeat a PR's work — it reuses the dependency layers from the previous
release's `:latest` whenever `package-lock.json` is untouched, and redoes
`COPY . .` plus `npm run build`. Expect a few minutes per arch, in parallel.

### 2. `addon/Dockerfile` — `npm ci`

Both stages currently run `npm install`, which is free to resolve outside the
lockfile. `package-lock.json` is already copied by `COPY package*.json ./`, so
switch to `npm ci` (build stage) and `npm ci --omit=dev` (runtime stage). That
makes a published image reproducible from its commit and keeps the dependency
layer cache-stable. Everything else — `node:24-alpine`, the two stages,
`CMD ["npm", "run", "start"]` — stays as is.

### 3. `addon/config.yaml` — the `image:` key

```yaml
image: "ghcr.io/elias-ems/elias-ems"
```

The generic multi-arch name, per the current docs ("Preferred — resolves via
the multi-arch manifest"). No `{arch}`, and no `build.yaml` — the docs are
explicit that build.yaml "is no longer used".

**Setting this key disables local building entirely**, which is why the rollout
below publishes an image before flipping it on. Rollback at any point is
deleting the line: Supervisor goes straight back to building locally.

### 4. Rollout

1. **One PR — the machinery.** `image.yml`, the Dockerfile `npm ci` change, and
   the doc updates below. Because it touches the Dockerfile, the PR itself
   builds both arches without pushing. `version` in config.yaml is left alone;
   the `image:` key is **not** added yet.
2. **Cut the first release:**
   ```bash
   gh release create v1.0.0-alpha.35 --title 1.0.0-alpha.35 --generate-notes --prerelease
   ```
   That builds, pushes, publishes the manifest, and bumps config.yaml on main.
   HA is still local-building at this point, so a failure here costs nothing.
3. **One-time and by hand:** at `https://github.com/orgs/elias-ems/packages`
   (or the repo's Packages panel) set `elias-ems`, `amd64-elias-ems` and
   `aarch64-elias-ems` to **public**. GHCR packages are private by default and
   Supervisor pulls anonymously.
4. **A second, tiny PR adds the `image:` key.** It changes no code that reaches
   the image (config.yaml is only read from the repo — the runtime stage copies
   just `server.js` and `build/`), so the already-published alpha.35 image is
   the right one for it and no new release is needed.

From then on the loop is: merge PRs without touching `version`, and run
`gh release create v<version> --title <version>` when you want it in front of
users. Git tags carry the `v`; GitHub release titles, `addon/config.yaml`, and
GHCR image tags do not.

### 5. Documentation

- **CLAUDE.md — "Versioning"** currently says to bump `version` manually as
  part of the release commit. That instruction inverts: **never edit `version`
  by hand**, the release workflow owns it, and the git tag is the source. Also
  worth stating there why the order is build-then-bump.
- **CLAUDE.md — "Continuous integration"** gains the third workflow: the pinned
  `2026.06.0` builder actions and that `@master` is deprecated; native ARM
  runners rather than QEMU; the GHCR packages having to be public; that
  `image:` disables local builds; that the PR filter is narrow on purpose
  because `addon-integration` already covers `npm run build`; and the
  `workflow_dispatch` escape hatch. This also closes that section's standing
  note that building the Dockerfile is "a job that does not exist yet".
- **README.md** — install step 5 loses "watch the build log (first build
  compiles the React Router app inside Docker, so it takes a few minutes)", and
  the Development section gains the one-line release procedure.
- **site/guide/install.md** — the same edit at step 5; the "Updating" section
  can now say what an update actually does (pull a prebuilt image).
- **docs/architecture.md** — line 8 says "two workflows"; it becomes three,
  with the release-driven publish and the bump-back. Line 13's Dockerfile
  bullet gains that the image is built and published by CI rather than by the
  user's HA.

## Verification

Before opening the PR, locally — this is what the PR job does:

```bash
docker build -t elias-ems:test addon
```

```bash
docker run --rm -p 3000:3000 elias-ems:test
```

`http://localhost:3000` should render the dashboard; every Home Assistant call
fails by design outside HA, so expect the degraded-state messages, not errors.

On the PR: **Add-on image** must show two green build jobs (`amd64`,
`aarch64`), no manifest and no bump — nothing is pushed from a PR.

After the first release, once the workflow finishes:

```bash
docker buildx imagetools inspect ghcr.io/elias-ems/elias-ems:1.0.0-alpha.35
```

It must list both `linux/amd64` and `linux/arm64`. Check that `main` now has
the bot's `chore(release)` commit and that `addon/config.yaml` reads
`1.0.0-alpha.35`. Then make the packages public and re-run that inspect from a
logged-out shell (`docker logout ghcr.io`) to prove anonymous pulls work —
that is exactly what Supervisor does.

After the `image:` key lands, in Home Assistant: **Settings → Add-ons → Add-on
Store → ⋮ → Check for updates**, then update the add-on. The log should show a
pull rather than a build and finish in seconds. Confirm it starts and the panel
loads.

`npm run test:all` in `addon/` is unaffected by any of this but is worth one
run, since the Dockerfile change alters how dependencies are installed.
