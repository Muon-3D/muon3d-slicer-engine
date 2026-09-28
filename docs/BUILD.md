# Building the engine

The engine builds on Linux and on Windows (Git Bash) with the same scripts. **Linux is the canonical build**: the
CI workflows and every release build on Linux, and a build is compared with a release only on Linux (see
[Reproducibility](#reproducibility)). `engine/scripts/README.md` has the day-to-day details (Windows setup, one
variant, moving the pin); this page covers Linux, rebuilding a release from its source assets, and CI.

## Toolchain

| Tool | Version | Notes |
|---|---|---|
| Emscripten | **6.0.10** exactly | `$ORCA_WASM_ROOT/emsdk`, or `ORCA_EMSDK` |
| CMake | 3.31.6 in CI (3.31 for the dependencies, 3.24 or newer for the engine) | |
| Ninja | 1.12.1 in CI (any) | |
| Node.js | 22.18 or newer (24 in CI) | npm, the host build, the tests; the engine build itself runs the emsdk's node |
| bash, git, curl, bsdtar (`libarchive-tools`), GNU tar, xz, python3 | any recent | |

`tools/ci/setup-toolchain.sh` installs Emscripten, CMake, Ninja and ccache into `$ORCA_WASM_ROOT` on Linux x86-64.

## On Linux

```bash
git clone --recurse-submodules --shallow-submodules https://github.com/Muon-3D/muon3d-slicer-engine.git
cd muon3d-slicer-engine
export ORCA_WASM_ROOT=~/OrcaWasm                      # no spaces; outside any synced folder
bash tools/ci/setup-toolchain.sh                      # emsdk 6.0.10, CMake, Ninja, ccache
export PATH=$ORCA_WASM_ROOT/tools/cmake/bin:$ORCA_WASM_ROOT/tools/bin:$PATH
bash engine/scripts/get-orca.sh --check               # orca/ is at the pin, unchanged
bash engine/deps/fetch-deps.sh                        # third-party sources, hash-checked
VARIANT=st bash "$PWD/engine/deps/build-deps.sh"      # dependency prefixes
VARIANT=mt bash "$PWD/engine/deps/build-deps.sh"
npm ci
npm run build                                         # engine st, mt and the host, into dist/
npm run test:engine
node examples/node-cli/slice.mjs --cube 20 -o cube.gcode
```

`SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)` makes `manifest.json`'s `builtAt` the commit time, as CI does.

## From a release's source assets (offline)

Every release carries its Corresponding Source as three assets (docs/RELEASING.md): the engine source bundle, the
Orca tree at the pin, and the third-party source archives. With those and the toolchain, the engine rebuilds
without the network, byte for byte:

```bash
V=0.1.0
tar -xzf muon3d-slicer-engine-$V-source.tar.gz            # muon3d-slicer-engine-$V/, with SOURCE_COMMITS
tar -xJf orcaslicer-*-source.tar.xz -C muon3d-slicer-engine-$V   # its orca/
tar -xf third-party-sources-*.tar                         # third-party-sources-<key>/
(cd third-party-sources-* && sha256sum -c SHA256SUMS)

export ORCA_WASM_ROOT=$PWD/root                           # prefixes and build trees go here
export ORCA_EMSDK=~/emsdk                                 # an installed and activated emsdk 6.0.10
export EM_CACHE=$PWD/emcache                              # a fresh Emscripten cache is fine
mkdir -p $ORCA_WASM_ROOT/deps-src/_archives $EM_CACHE && cp third-party-sources-*/deps/* $ORCA_WASM_ROOT/deps-src/_archives/
export PATH=$ORCA_EMSDK/upstream/emscripten:$PATH
emcc --check                                              # writes the new cache's sanity file first
echo 'int main(void) { return 0; }' > x.c && emcc -c x.c -o x.o   # installs the sysroot headers
node muon3d-slicer-engine-$V/tools/release/emscripten-ports.mjs seed \
  $ORCA_EMSDK/upstream/emscripten third-party-sources-*/emscripten-ports $EM_CACHE/ports

cd muon3d-slicer-engine-$V
bash engine/deps/fetch-deps.sh                            # finds the archives: verifies and extracts only
VARIANT=st bash "$PWD/engine/deps/build-deps.sh"
bash engine/scripts/build.sh st                           # dist/engine-st.{mjs,wasm}
sha256sum dist/engine-st.wasm dist/engine-st.mjs          # = variants.st.sha256 in the release's manifest.json
```

The bundle is not a git checkout: the scripts take the engine and Orca commits from `SOURCE_COMMITS`.
`tools/release/rebuild-offline.sh` is the same sequence for the `emscripten/emsdk:6.0.10` container of
`tools/release/offline/Dockerfile`, run with `--network none`; the release workflow runs it for both variants
before it publishes a release. The host rebuilds from the bundle with `npm ci && npm run build:host` (its only
network use is `npm ci`, for esbuild).

## Reproducibility

The same Orca commit, the same engine commit and Emscripten 6.0.10 give byte-identical `engine-<variant>.wasm` and
`.mjs`, wherever the folders are: every compile maps its paths with `-ffile-prefix-map`, and Orca's resources are
embedded with LF line ends. Checked:

- **Linux**: the CI builds of `main` (with ccache), the clean builds of the release workflow, and the offline
  rebuilds from the source assets in the emsdk container (other folders, a fresh Emscripten cache, no network)
  gave the same sha256 for both variants (release candidate `v0.1.0-rc.3`, 2026-09-27: st `da459bb4…`, mt
  `a642334c…`). The offline st rebuild ran past midnight UTC, so the build date plays no part either.
- **Windows**: builds from two Orca checkouts (CRLF and LF) and from the source bundles are identical to each
  other.
- **Windows against Linux**: they differ. Clang on Windows joins some header paths with a backslash
  (`/orcawasm/prefix-st/include\boost/...`), and those strings reach the wasm. Compare a build with a release on
  Linux; the Windows build is for development. Apart from those nine strings (and the data addresses that move
  with them), a Windows and a Linux build of the same commits are the same (`engine/scripts/README.md`).

## Continuous integration

| Workflow | When | Does |
|---|---|---|
| `build.yml` | every pull request, every push to `main` | `checks` (`npm run check`, the host build, `npm test` with the protocol conformance suite on the host without the engine, the protocol package packed) always. `engine` (st and mt in parallel: toolchain, engine build, engine tests with the conformance suite's engine part, the `THIRD-PARTY-NOTICES.md` check) only when `engine/` (docs aside), the `orca` pin, `tools/ci/` or the workflow changed; otherwise the next job reuses the `edge` engine. `runtime`: the host, the engine tests on a reused engine, the runtime assembled and a cube sliced on both variants, and the profile set built and checked (docs/PROFILES.md, "Building and checking a set"): the preset fixtures, OrcaSlicer's profile validator and `orca_profile_tool.py check`, every preset against OrcaSlicer's loader, the Muon3D record. On `main`, `edge`: the rolling prerelease. A newer push to the same branch cancels the older run |
| `toolchain.yml` | the dependency recipe changes on `main` | warms the toolchain cache for both variants |
| `release.yml` | a tag `v*` | the release (docs/RELEASING.md) |
| `upstream-canary.yml` | Mondays, or by hand | builds and tests both variants against upstream OrcaSlicer (the head of PR #13777, and `main`) instead of the pin; opens or updates an `upstream-canary` issue when that fails |

**Caches** (`actions/cache`, 10 GB per repository, dropped after 7 days unused):

- **Toolchain** (`.github/actions/toolchain`), one per variant: `~/OrcaWasm/emsdk` (with its Emscripten cache,
  which holds the system libraries and the zlib and libpng ports), `~/OrcaWasm/tools` (CMake, Ninja, ccache) and
  `~/OrcaWasm/prefix-<variant>`. The key is the hash of `engine/deps/**` (docs aside), `engine/scripts/toolchain.sh`
  and `tools/ci/setup-toolchain.sh`, so a change to the dependency recipe or a tool version rebuilds it. On a miss
  the job builds it and saves it.
- **ccache** for the engine compile (`EM_COMPILER_WRAPPER=ccache`), per variant and Orca commit, saved by runs on
  `main` and restored by every run. Releases build without it.

**Timings** on GitHub's standard Linux runner (4 vCPU, 16 GB), per variant; st and mt run in parallel:

| Run | st | mt |
|---|---|---|
| **Cold**: no toolchain cache, no ccache (the first run) | 19.6 min: toolchain 4.8 min (install 0.7, dependencies 4.1), engine 13.9 min, tests 11 s | 22.5 min: toolchain 5.8 min, engine 16.0 min, tests 7 s |
| Toolchain cache miss (the dependency recipe changed), ccache warm | 8.5 min: toolchain 5.4 min, engine 2.0 min | 8.0 min: toolchain 5.6 min, engine 1.8 min |
| **Warm**: toolchain from the cache, ccache warm (an engine change) | 3.3 min: toolchain restore 10 s, engine 2.0 min, tests 11 s | 2.3 min: toolchain restore 11 s, engine 1.6 min, tests 7 s |
| No engine change (docs, host, tests): `checks` and `runtime` only | under a minute for the whole run | |

Measured on the first runs, 2026-09-27. A warm engine build is mostly the link, `wasm-opt` and the brotli-11
compression (ccache hits 263 of 265 compiles). The `runtime` job adds about 25 s, and on a run without an engine
build it also runs the engine tests on the reused engine.

**A release** (`release.yml`, measured on release candidate `v0.1.0-rc.3`) takes about 35 minutes: the clean engine
builds 7.8 min (st) and 13.0 min (mt) with the toolchain from the cache, the source assets 1.7 min, the draft
0.6 min, then the checks and offline rebuilds, 20 min per variant in parallel (in the container: dependencies
6 min, engine 12-13 min, starting from an empty Emscripten cache).
