# Releasing the engine

A release is a pushed tag `v<version>`. `.github/workflows/release.yml` does the rest: it builds from clean,
makes every asset, checks that the source assets rebuild the engine byte for byte with the network off, and only
then publishes. Between releases, every push to `main` updates the rolling `edge` prerelease
(`.github/workflows/build.yml`).

## Versions

- **SemVer, `0.x`** until protocol v2 settles. **MAJOR** when the protocol major changes or a variant or capability
  goes; **MINOR** for new operations or capabilities, or a new Orca base (the G-code changes); **PATCH** for fixes
  with the same protocol and the same Orca commit.
- The version is `version` in `package.json`; the tag is `v` + that version, and the workflow stops if they differ.
- The release title names the Orca version and commit: "Muon3D Slicer Engine 0.1.0 (OrcaSlicer 2.5.0-dev @
  2d1163eb6f)". `manifest.json` carries both, and more (below).
- `packages/protocol` has its own version, which follows the protocol (`2.0.x` = protocol 2.0). Each release carries
  it as an npm tarball (below) until it is published to npm.

## Cutting a release

1. **Everything is on `main` and green.** The `Build` workflow has passed on the commit to release, and the `edge`
   prerelease is that commit.
2. **The notices are current.** `npm run notices:check` (it needs the dependency sources and the emsdk, as for a
   build: `engine/scripts/README.md`). When it fails, `npm run notices` and commit `THIRD-PARTY-NOTICES.md`. The
   release workflow runs the same check.
3. **The version.** Set `version` in `package.json` (and `package-lock.json`: `npm install --package-lock-only`),
   commit, and merge to `main`.
4. **Tag and push:**

   ```bash
   git tag -a v0.1.0 -m "Muon3D Slicer Engine 0.1.0"
   git push origin v0.1.0
   ```

   To try the whole pipeline first, push a release candidate tag `v0.1.0-rc.1`: it runs every job but `publish`
   and leaves a verified draft (a prerelease), which can then be deleted with its tag.
5. **Watch `Release`** (`gh run watch`). It takes about 35 minutes: the two clean engine builds, the source assets,
   the draft, then the offline rebuilds of both variants in parallel.
6. **Check the result:** `bash tools/release/verify-release.sh v0.1.0` downloads every asset, checks
   `SHA256SUMS` and the runtime's `manifest.json` (the host's chunks too), validates the M1 presets through the
   runtime's settings service (`examples/settings-cli`), and slices a cube on both variants from the runtime tarball.

If a job fails before `publish`, nothing is public but the tag and possibly a **draft** release. Fix the cause on
`main` and release the next patch version; a draft left behind can be deleted. (Re-running the workflow for the same
tag replaces its draft; it refuses to touch a published release.)

## What a release carries

| Asset | What |
|---|---|
| `muon3d-slicer-engine-<v>.tgz` | The runtime, in a folder `muon3d-slicer-engine-<v>/`: `host.<hash>.js` and the scripts it loads on demand (`host-*.<hash>.js`, `manifest.host.chunks`), `engine-st.{mjs,wasm}`, `engine-mt.{mjs,wasm}`, each with `.br` and `.gz` copies; `manifest.json`; `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md` and `SOURCE.md`. Serve the folder as it is |
| `muon3d-slicer-engine-<v>-source.tar.gz` | This repository at the tag (`git archive`), plus `SOURCE_COMMITS`, which names the commit, the Orca commit and its tag, so that the scripts build from it without git |
| `orcaslicer-<commit>-source.tar.xz` | The OrcaSlicer tree at the pinned commit, under `orca/`: extract it into the folder above |
| `third-party-sources-<key>.tar` | Every third-party source archive the build uses: the archives of `engine/deps/SHA256SUMS` (GMP and MPFR aside, which the default build does not use), the Emscripten ports zlib and libpng as emcc downloads them, and any npm package bundled into the host (none today). `<key>` is a hash of its contents |
| `muon3d-slicer-engine-protocol-<p>.tgz` | The protocol package `@muon3d/slicer-engine-protocol` (Apache-2.0; `npm pack` of `packages/protocol`, built): `npm install <its URL>` |
| `SHA256SUMS` | sha256 of every asset above |

Each asset also has a **build-provenance attestation** (Sigstore, stored by GitHub):
`gh attestation verify muon3d-slicer-engine-0.1.0.tgz --repo Muon-3D/muon3d-slicer-engine`.

The runtime's **`manifest.json`** keeps every field a local build has (`orcaVersion`, `orcaCommit`, `builtAt`,
`host`, `variants`) and adds, as `EngineManifest` in `packages/protocol` describes: `manifest: 2`, `version`,
`protocol`, `license`, `orca` (version, commit, tag, repository, upstream base), `build` (engine commit, emsdk,
build time, which is the commit time), `source` (this repository, the tag, the commit and the three source assets
with their URLs and sha256), and `files` (the sha256 and size of every other file in the folder).

The runtime's **`SOURCE.md`** is the repository's `SOURCE.md` plus a "This build" section that names this release,
its commits and its source assets. It is the "where is the source" notice that sits next to the object code
wherever the runtime is served.

**`THIRD-PARTY-NOTICES.md`** is generated (`tools/release/third-party-notices.mjs`) from the dependency list in
`engine/deps/fetch-deps.sh` and from the sources themselves: the dependency libraries, the Emscripten ports, the
Emscripten runtime and system libraries (musl, libc++, libc++abi, libunwind, compiler-rt, dlmalloc, mimalloc), the
libraries OrcaSlicer carries in `deps_src/` that the engine compiles, and whatever the host bundles. A dependency
added to `fetch-deps.sh` without an entry in the generator stops it.

**Licence banners:** `host.<hash>.js`, its chunks and both `engine-<variant>.mjs` start with a `/*! @license AGPL-3.0-only …
@source … */` comment, which minifiers keep.

## The release workflow

| Job | Does |
|---|---|
| `engine` (st, mt) | Checks that the tag is `v` + `package.json`'s version; builds the engine in a fresh tree without ccache (the dependency prefixes come from the toolchain cache, keyed on their recipe); `SOURCE_DATE_EPOCH` is the commit time; runs the engine tests |
| `sources` | `THIRD-PARTY-NOTICES.md` is current; the three source assets (`tools/release/source-bundles.sh`) |
| `draft` | Merges the two builds, builds the host, assembles the runtime (`tools/release/assemble.mjs`), packs it reproducibly, packs the protocol package, writes `SHA256SUMS`, slices a cube on both variants from the tarball, attests every asset, and creates a **draft** release |
| `verify` (st, mt) | Downloads the draft's assets and checks them (`tools/release/verify-release.sh`); rebuilds its variant from the three source assets alone in `emscripten/emsdk:6.0.10` (plus CMake, Ninja, bsdtar), **with the network off and an empty Emscripten cache** (`tools/release/rebuild-offline.sh`), and requires the same sha256 for the `.wasm` and the `.mjs`; the st job also rebuilds the host and its chunks from the source bundle (`npm ci` needs the network) and requires the same sha256 |
| `publish` | Adds the verification to the notes and publishes the release |

## The `edge` prerelease

Every push to `main` that passes `Build` replaces the assets of the prerelease `edge` and moves its tag to that
commit: `muon3d-slicer-engine-edge.tgz` (a runtime whose `version` is `<version>-edge.<commit>`) and `SHA256SUMS`,
with an attestation. When a push does not touch `engine/`, the pin or the toolchain, the engine is not rebuilt: the
runtime reuses the previous `edge` engine, and its `variants.*.engineCommit` names the commit that built it. `edge`
is for branches and tools that need an unreleased engine; nothing that ships should point at it.

A pull request's run keeps its runtime as the workflow artifact `runtime` (`muon3d-slicer-engine-pr-<n>.tgz`) for
14 days.

## Moving the Orca pin

See `engine/scripts/README.md` ("Moving the pin"): the new commit is pushed and tagged `muon3d-wasm/<date>` on
<https://github.com/Muon-3D/OrcaSlicer> first (by the fork's maintainers), then the submodule moves in a pull
request here, whose `Build` rebuilds both variants. The next release is a MINOR one, and it carries the new Orca
tree as its Orca source asset.

## Not done yet

- A second host for the source assets (today they live only on GitHub Releases).
- Fingerprints of the Orca sources the host's settings rules translate (`orca-fingerprints.json`).
- Sharing the Orca and third-party source assets between releases with the same pin (each release carries its own
  copy today, about 320 MB).
- The profiles tarball, and publishing `@muon3d/slicer-engine-protocol` to npm.
- `-pr.<n>` prereleases on request (a pull request's runtime is a workflow artifact today).
