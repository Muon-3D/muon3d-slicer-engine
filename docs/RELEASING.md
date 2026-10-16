# Releasing the engine

Release preparation is manual, self-hosted and draft-only. Use [the supervisor runbook](RELEASE_050.md)
for exact tag/dispatch/publish/pin steps, prerequisites and release gates. Tag pushes alone do not
launch the release workflow. One job selected by vars.LINUX_RUNS_ON builds/tests both variants,
assembles assets, creates a draft, verifies downloads and performs offline source rebuilds.
Intermediate files remain on the runner; no Actions artifact uploads are used. Publishing is
an explicit separate supervisor command. The ordinary Build/edge workflow remains separate.

## Versions

- **SemVer, `0.x`** until protocol v2 settles. **MAJOR** when the protocol major changes or a variant or capability
  goes; **MINOR** for new operations or capabilities, or a new Orca base (the G-code changes); **PATCH** for fixes
  with the same protocol and the same Orca commit.
- The version is `version` in `package.json`; the tag is `v` + that version, and the workflow stops if they differ.
- The release title names the Orca version and commit: "Muon3D Slicer Engine 0.1.0 (OrcaSlicer 2.5.0-dev @
  2d1163eb6f)". `manifest.json` carries both, and more (below).
- `packages/protocol` has its own version, which follows the protocol (`2.0.x` = protocol 2.0). Each release carries
  it as an npm tarball (below) until it is published to npm.

## What a release carries

| Asset | What |
|---|---|
| `muon3d-slicer-engine-<v>.tgz` | The runtime, in a folder `muon3d-slicer-engine-<v>/`: `host.<hash>.js` and the scripts it loads on demand (`host-*.<hash>.js`, `manifest.host.chunks`), `engine-st.{mjs,wasm}`, `engine-mt.{mjs,wasm}`, each with `.br` and `.gz` copies; `manifest.json`; `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md` and `SOURCE.md`. Serve the folder as it is |
| `muon3d-slicer-engine-<v>-source.tar.gz` | This repository at the tag (`git archive`), plus `SOURCE_COMMITS`, which names the commit, the Orca commit and its tag, so that the scripts build from it without git |
| `orcaslicer-<commit>-source.tar.xz` | The OrcaSlicer tree at the pinned commit, under `orca/`: extract it into the folder above |
| `third-party-sources-<key>.tar` | Every third-party source archive the build uses: the archives of `engine/deps/SHA256SUMS` (GMP and MPFR aside, which the default build does not use), the Emscripten ports zlib and libpng as emcc downloads them, and any npm package bundled into the host (none today). `<key>` is a hash of its contents |
| `muon3d-slicer-profiles-<v>.tgz` | The profile set (`docs/PROFILES.md`), built by `tools/profiles` with this release's engine from the pinned OrcaSlicer tree and `profiles/muon3d`, in a folder `muon3d-slicer-profiles-<v>/`: `profiles/<v>/` (index, vendor bundles, all-in-one file, `SOURCE.json`), `profiles/assets/`, `goldens.json.gz`, `report.json`, `README.md`, `LICENSE`. Serve its `profiles/` folder as it is |
| `muon3d-slicer-engine-protocol-<p>.tgz` | The protocol package `@muon3d/slicer-engine-protocol` (Apache-2.0; `npm pack` of `packages/protocol`, built): `npm install <its URL>` |
| `SHA256SUMS` | sha256 of every asset above |

Each asset also has a **build-provenance attestation** (Sigstore, stored by GitHub):
`gh attestation verify muon3d-slicer-engine-0.1.0.tgz --repo Muon-3D/muon3d-slicer-engine`.

The runtime's **`manifest.json`** keeps every field a local build has (`orcaVersion`, `orcaCommit`, `builtAt`,
`host`, `variants`) and adds, as `EngineManifest` in `packages/protocol` describes: `manifest: 2`, `version`,
`protocol` (major and minor: `PROTOCOL` of `packages/protocol` when the host was built, which `host/build.mjs`
records as `host.protocol` and `host.protocolMinor`; releases up to 0.4.0 wrote minor 0), `license`, `orca`
(version, commit, tag, repository, upstream base), `build` (engine commit, emsdk, build time, which is the commit
time), `source` (this repository, the tag, the commit and the three source assets with their URLs and sha256), and
`files` (the sha256 and size of every other file in the folder).

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
