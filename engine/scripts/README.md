# Building the engine

How to get from an empty machine to a built engine and host in `dist/`, and how to check a build against another
one. The scripts are written for Git Bash on Windows 11; their paths are portable (see "Other systems" at the end).

## What you need

| Tool | Version | How to get it (Windows) |
|---|---|---|
| Git for Windows (Git Bash) | any recent | `winget install Git.Git` |
| CMake | 3.31 for the dependencies (others warn), ≥ 3.24 for the engine | `winget install Kitware.CMake` |
| Ninja | any | `winget install Ninja-build.Ninja` (Strawberry Perl also ships one) |
| Emscripten | exactly 6.0.10, in `$ORCA_WASM_ROOT/emsdk` or `ORCA_EMSDK` | below |
| Node.js | ≥ 22.18 (npm, the host build and the tests; the engine build runs the emsdk's node) | `winget install OpenJS.NodeJS` |

```bash
export ORCA_WASM_ROOT=~/OrcaWasm          # or any folder without spaces, outside any synced folder
git clone https://github.com/emscripten-core/emsdk $ORCA_WASM_ROOT/emsdk
cd $ORCA_WASM_ROOT/emsdk && ./emsdk install 6.0.10 && ./emsdk activate 6.0.10   # ~700 MB, a few minutes
```

`activate` is not optional: it writes the `.emscripten` file the scripts point `EM_CONFIG` at.

Everything large lives under `ORCA_WASM_ROOT` (default `~/OrcaWasm`; no spaces in it, since it goes into the compile
flags, so set it where the user name has a space): the emsdk, the dependency sources, prefixes and build trees.
Emscripten's cache (`EM_CACHE`, inside the emsdk by default) must be on the **same drive** as `ORCA_WASM_ROOT`:
Emscripten computes relative paths between them. The Orca source is the `orca/` submodule of this repository
(about 0.5 GB checked out).

## From scratch

From the repository root, in Git Bash:

```bash
npm ci                                                   # esbuild and TypeScript
bash engine/scripts/get-orca.sh                          # the orca/ submodule at the pin (shallow)
bash engine/deps/fetch-deps.sh                           # third-party sources, hash-checked (~170 MB)
VARIANT=st JOBS=12 bash "$PWD/engine/deps/build-deps.sh" &   # dependency prefixes, ~5 min, both at once
VARIANT=mt JOBS=12 bash "$PWD/engine/deps/build-deps.sh" &
wait
npm run build:engine          # engine st, then mt (~3 min each with a warm tree), published into dist/
npm run build:host            # the worker host, dist/host.<hash>.js
npm run test:engine           # engine tests, st then mt
npm test                      # every test (host, settings rules, catalogue, engine st)
```

With an Orca clone already on the machine, `ORCA_REFERENCE=<that clone> bash engine/scripts/get-orca.sh` borrows
its objects instead of downloading them.

`npm run build:engine` and `npm run test:engine` work from any shell (PowerShell and cmd too): they find Git Bash
themselves, since a bare `bash` on Windows is usually WSL's. One variant: `npm run build:engine -- mt`,
`npm run test:engine:mt`. From Git Bash, `bash engine/scripts/build.sh mt` does the same as
`npm run build:engine -- mt`.

After changing the bridge, the CMake files or the pin, only the build and test steps are needed. After changing the
dependency flags (`deps/build-deps.sh`), rebuild the prefixes first; the engine then recompiles in full. A build tree
configured from another copy of `engine/` is configured afresh, which also means a full rebuild.

## The files here

| File | What it does |
|---|---|
| `get-orca.sh` | Fetches the `orca/` submodule at the pinned commit, or checks a checkout (`--check`): HEAD must be the pin, with no changes in the sources the engine uses. Never changes an existing checkout. |
| `orca/pin.sh` | The pin: the submodule's commit in HEAD (`git rev-parse HEAD:orca`, `orcaCommit` in the manifest), its tag on the fork, and the upstream base (PR #13777). |
| `toolchain.sh` | Shared by all scripts: path helpers, the workspace root check, and the emsdk environment (`ORCA_EMSDK`, `EM_CACHE`, PATH). |
| `build.sh` | Configures and builds one variant, then publishes it into `dist/` (below). A target name builds that target only, unpublished. |
| `compress.mjs` | Writes `<file>.br` (brotli 11) and `<file>.gz` (gzip 9) next to published files. |
| `build-engine.mjs`, `test-engine.mjs` | `npm run build:engine` and `npm run test:engine`. A variant that is not built fails the tests instead of skipping them. |

## Moving the pin

The pin is the `orca/` submodule. To build from a newer Orca: push the new commit to branch `muon3d-wasm` of
<https://github.com/Muon-3D/OrcaSlicer> and tag it `muon3d-wasm/<date>` (the tag keeps the source reachable), then
`git -C orca fetch origin tag <tag> && git -C orca checkout <tag>`, set `ORCA_TAG` in `orca/pin.sh`, rebuild and test
both variants, regenerate the settings catalogue (`npm run gen:settings`) and the preset and profile fixtures (`npm run
profiles:fixtures`), check the profile set (`docs/PROFILES.md`), and commit the submodule change with them.

## What a build publishes

Into `dist/` (git-ignored):

- `engine-<variant>.mjs` and `engine-<variant>.wasm`;
- `engine-<variant>.{mjs,wasm}.{br,gz}`: precompressed copies a web server can send as they are, instead of
  compressing 10 MB on every request. The engine .wasm is about 2.2 MB as brotli-11;
- `host.<hash>.js` (+ `.br`/`.gz`): the worker host, from `npm run build:host`;
- `LICENSE`, `NOTICE`, `SOURCE.md`: served next to the object code;
- `manifest.json` (`EngineManifest` in `packages/protocol/src/v1.ts`): Orca version and commit, build time, per
  variant the file names, `wasmBytes`, `wasmTransferBytes` (size of the .br), `sha256` of both files, and
  `engineCommit`, this repository's commit with `-dirty` when `engine/` had uncommitted changes other than docs; and
  the `host` entry. The other variant's entry is kept only if it was built from the same Orca commit.

## Checking a build against another one

The build is deterministic, and nothing in the output depends on where things sit on disk:

- every compile uses `-ffile-prefix-map`, so recorded paths read `/orcawasm/...`, `/emcache/...`, `/orca/...`,
  `/engine/...` and `/build/...` instead of this machine's folders (Boost's `__FILE__` in throw sites used to put
  the workspace path into the wasm);
- the Orca resources embedded in the engine are copied into the build tree with LF line ends first, so a Windows
  checkout with `core.autocrlf` (CRLF files) gives the same bytes as a Linux one.

So the same Orca commit, the same `engineCommit` and Emscripten 6.0.10 give byte-identical `engine-<variant>.wasm`
and `.mjs`: compare `sha256sum dist/engine-st.wasm` with `variants.st.sha256.wasm` of another build's
`manifest.json`. Checked on 2026-09-25 (st built from a CRLF and from an LF Orca checkout into two build trees: same
sha256 for both files), and again on 2026-09-27 when the engine moved into this repository: both variants built
from the new layout (Orca from the submodule) are byte-identical to the builds made before the move, at the same
pin.

To rebuild into a separate tree without publishing:
`ENGINE_BUILD=<folder> bash engine/scripts/build.sh st orca_engine`, then compare `<folder>/out/engine-st.wasm`.

One difference remains between operating systems: clang on Windows joins some header paths with a backslash
(`/orcawasm/prefix-st/include\boost/...`), so a Linux build differs from a Windows build in those few strings.
Compared on 2026-09-27 (st, same commits): the `.mjs` files are identical, and the `.wasm` files have the same size
and differ only in nine such path strings (Boost.Multiprecision, Boost.Log, libc++abi's demangler) and in the
libjpeg-turbo build date, which was then fixed (`deps/README.md`), plus the data addresses that move with those
strings. Linux is the canonical build (`docs/BUILD.md`):
compare a build with a release on Linux.

## Other systems

`toolchain.sh` only uses `cygpath` and `pwd -W` where they exist, uses `bsdtar` (package `libarchive-tools`) and the
Linux emsdk's `node/*/bin/node` elsewhere, and defaults `ORCA_WASM_ROOT` to `~/OrcaWasm`. On Linux the same
sequence runs as it is; it is what CI runs (`.github/workflows`), and a Linux build is the canonical one:
`docs/BUILD.md` has the Linux setup (`tools/ci/setup-toolchain.sh`), the rebuild from a release's source assets in
the `emscripten/emsdk:6.0.10` container, and the CI caches and timings.
