# Building the engine

How to get from an empty machine to a published engine in `web/public/engine/`, and how to check a
build against the one that is deployed. The scripts are written for Git Bash on Windows 11; their
paths are portable (see "Other systems" at the end).

## What you need

| Tool | Version | How to get it (Windows) |
|---|---|---|
| Git for Windows (Git Bash) | any recent | `winget install Git.Git` |
| CMake | 3.31 for the dependencies (others warn), ≥ 3.24 for the engine | `winget install Kitware.CMake` |
| Ninja | any | `winget install Ninja-build.Ninja` (Strawberry Perl also ships one) |
| Emscripten | exactly 6.0.10, in `$ORCA_WASM_ROOT/emsdk` or `ORCA_EMSDK` | below |
| Node.js | ≥ 22.18 (for npm; the build itself runs the emsdk's node) | `winget install OpenJS.NodeJS` |

```bash
git clone https://github.com/emscripten-core/emsdk $ORCA_WASM_ROOT/emsdk
cd $ORCA_WASM_ROOT/emsdk && ./emsdk install 6.0.10 && ./emsdk activate 6.0.10   # ~700 MB, a few minutes
```

`activate` is not optional: it writes the `.emscripten` file the scripts point `EM_CONFIG` at.

Everything large lives under `ORCA_WASM_ROOT` (default `~/OrcaWasm`, outside any synced folder; no spaces in
it, since it goes into the compile flags): the Orca checkout (1.8 GB), the emsdk, the dependency
sources, prefixes and build trees. Emscripten's cache (`EM_CACHE`, inside the emsdk by default) must
be on the **same drive** as `ORCA_WASM_ROOT`: Emscripten computes relative paths between them.

## From scratch

From the repository root, in Git Bash:

```bash
bash engine/scripts/get-orca.sh                          # Orca at the pinned commit -> $ORCA_WASM_ROOT/orca
bash engine/deps/fetch-deps.sh                           # third-party sources, hash-checked (~170 MB)
VARIANT=st JOBS=12 bash "$PWD/engine/deps/build-deps.sh" &   # dependency prefixes, ~5 min, both at once
VARIANT=mt JOBS=12 bash "$PWD/engine/deps/build-deps.sh" &
wait
npm run build:engine          # engine st, then mt (~3 min each), published into web/public/engine/
npm run test:engine           # engine tests, st then mt (needs $ORCA_WASM_ROOT/orca/resources)
npm run build                 # the web app; copies web/public/engine/ into web/dist/engine/
```

`npm run build:engine` and `npm run test:engine` work from any shell (PowerShell and cmd too): they
find Git Bash themselves, since a bare `bash` on Windows is usually WSL's. One variant:
`npm run build:engine -- mt`, `npm run test:engine:mt`. From Git Bash, `bash engine/scripts/build.sh mt`
does the same as `npm run build:engine -- mt`.

After changing the bridge, the CMake files or the Orca checkout, only the last three steps are
needed. After changing the dependency flags (`deps/build-deps.sh`), rebuild the prefixes first; the
engine then recompiles in full.

## The files here

| File | What it does |
|---|---|
| `get-orca.sh` | Checks out the exact Orca source the engine is built from, or checks an existing checkout (`--check`). Never changes an existing checkout. |
| `orca/pin.sh` | The pin: PR #13777's base commit, the patches, and the resulting commit (`orcaCommit` in the manifest). |
| `orca/0001-Muon3D-M1-profiles.patch` | The Muon3D M1 profiles commit on top of the PR (`git format-patch --binary`), applied as the identical commit. |
| `toolchain.sh` | Shared by all scripts: path helpers, and the emsdk environment (`ORCA_EMSDK`, `EM_CACHE`, PATH). |
| `build.sh` | Configures and builds one variant, then publishes it (below). A target name builds that target only, unpublished. |
| `compress.mjs` | Writes `<file>.br` (brotli 11) and `<file>.gz` (gzip 9) next to published engine files. |
| `build-engine.mjs`, `test-engine.mjs` | `npm run build:engine` and `npm run test:engine`. A variant that is not built fails the tests instead of skipping them. |

## What a build publishes

Into `web/public/engine/` (git-ignored):

- `engine-<variant>.mjs` and `engine-<variant>.wasm`;
- `engine-<variant>.{mjs,wasm}.{br,gz}`: precompressed copies. `server/engineAssets.ts` sends them as
  they are (brotli when the browser accepts it), instead of compressing 10 MB on every request, and
  ignores one older than its file. The engine .wasm is about 2.2 MB as brotli-11 against about 3 MB
  from the compression middleware on the fly;
- `manifest.json` (`EngineManifest` in `web/src/engine/protocol.ts`): Orca version and commit, build
  time, and per variant the file names, `wasmBytes`, `wasmTransferBytes` (size of the .br),
  `sha256` of both files, and `engineCommit`, this repository's commit with `-dirty` when `engine/`
  had uncommitted changes other than docs and tests. The other variant's entry is kept only if it was
  built from the same Orca commit.

## Checking a build against the deployed one

The build is deterministic, and nothing in the output depends on where things sit on disk:

- every compile uses `-ffile-prefix-map`, so recorded paths read `/orcawasm/...`, `/emcache/...`,
  `/orca/...`, `/engine/...` and `/build/...` instead of this machine's folders (Boost's `__FILE__`
  in throw sites used to put `$ORCA_WASM_ROOT/...` into the wasm);
- the Orca resources embedded in the engine are copied into the build tree with LF line ends first, so
  a Windows checkout with `core.autocrlf` (CRLF files) gives the same bytes as a Linux one.

So the same Orca commit, the same `engineCommit` and Emscripten 6.0.10 give byte-identical
`engine-<variant>.wasm` and `.mjs`: compare `sha256sum web/public/engine/engine-st.wasm` with
`variants.st.sha256.wasm` of the deployed `manifest.json`. Checked on 2026-09-25: st built from
`$ORCA_WASM_ROOT/orca` (CRLF checkout) into `build-st`, and from a `get-orca.sh` checkout elsewhere (LF)
into another build tree (`ENGINE_BUILD`), gave the same sha256 for both files. Before these changes
the wasm held 11 `$ORCA_WASM_ROOT/...` paths and CRLF resources, so builds in two roots differed.

To rebuild into a separate tree without publishing:
`ORCA_SRC=<checkout> ENGINE_BUILD=<folder> bash engine/scripts/build.sh st orca_engine`, then compare
`<folder>/out/engine-st.wasm`.

One difference remains between operating systems: clang on Windows joins some header paths with a
backslash (`/orcawasm/prefix-st/include\boost/...`), so a Linux build differs from a Windows build in
those few strings. Compare builds made on the same OS.

## Other systems

`toolchain.sh` only uses `cygpath` and `pwd -W` where they exist, uses `bsdtar` (package
`libarchive-tools`) and the Linux emsdk's `node/*/bin/node` elsewhere, and defaults `ORCA_WASM_ROOT`
to `~/OrcaWasm`. The scripts have not been run on Linux yet, and there is no container recipe or CI
workflow: this repository has no remote to run one. A starting point would be the
`emscripten/emsdk:6.0.10` image plus `cmake`, `ninja-build`, `libarchive-tools` and `git`, running
the sequence above with `ORCA_EMSDK=/emsdk`.
