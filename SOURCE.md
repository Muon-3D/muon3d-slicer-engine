# Source of the Muon3D Slicer Engine

The engine is free software under the GNU Affero General Public License, version 3 (`LICENSE`). Whoever
receives the engine's object code (`engine-st.wasm`, `engine-mt.wasm`, their `.mjs` loaders, `host.<hash>.js`)
is owed its Corresponding Source. This file says what that source is and where to get it.

## What a build is made of

| Part | What | Where |
|---|---|---|
| This repository | The bridge (`engine/bridge`), the build recipe (`engine/CMakeLists.txt`, `engine/cmake`, `engine/deps`, `engine/scripts`), shims and stubs, the worker host (`host/`), the protocol types (`packages/protocol`, Apache-2.0), the settings catalogue generator (`tools/settings-catalogue`) | <https://github.com/Muon-3D/muon3d-slicer-engine> at the commit a build names as `engineCommit` in `manifest.json` |
| OrcaSlicer | The slicing core, `src/libslic3r` and the resources the engine embeds | The `orca/` submodule: <https://github.com/Muon-3D/OrcaSlicer>, branch `muon3d-wasm`, at the commit a build names as `orcaCommit`. Every pinned commit is also tagged there, so it stays reachable: today `muon3d-wasm/2026-09-24` = `2d1163eb6f5228de605150e3b4800081947070eb` |
| Libraries linked into the engine | Boost 1.84.0, oneTBB 2021.12.0 (`mt` only), CGAL 5.6.3, Eigen 5.0.1, cereal 1.3.0, NLopt 2.5.0, libnoise 1.0, Qhull 8.0.2, libjpeg-turbo 3.0.1 | The archives named, with their download URLs, in `engine/deps/fetch-deps.sh`, checked against `engine/deps/SHA256SUMS` |
| Emscripten ports | zlib and libpng (`-sUSE_ZLIB=1 -sUSE_LIBPNG=1`), and Emscripten's own musl and libc++ | Fetched by Emscripten 6.0.10 at build time, pinned by the hashes in its `tools/ports/*.py` |

The toolchain itself is generally available and used unmodified, so it is not part of the Corresponding Source:
Emscripten 6.0.10, CMake 3.31 (3.24 or newer for the engine), Ninja, Node.js 22.18 or newer, Git Bash on Windows or
bash on Linux. `engine/scripts/README.md` has the exact commands.

### Changes to OrcaSlicer

- **Upstream base:** OrcaSlicer pull request #13777 (branch `feat-3D-Exclusion-Volumes`), head
  `432debfc74a7e62e84b1af420804c47590ace43f` of <https://github.com/OrcaSlicer/OrcaSlicer>
  (`refs/pull/13777/head`).
- **Commits after the base** on `muon3d-wasm`: one commit, `2d1163eb6f`, which adds the Muon3D M1 printer profiles
  under `resources/profiles/Muon3D*`.
- **Out-of-tree patches** applied at build time to copies in the build tree, never to `orca/`:
  `engine/cmake/OrcaSourcePatches.cmake`, described in `engine/PATCHES.md`.

## The profile sets

A release's profile set (`muon3d-slicer-profiles-<version>.tgz`, `docs/PROFILES.md`) is OrcaSlicer's
`resources/profiles` at the pinned commit, with the Muon3D vendor from `profiles/muon3d` of this repository,
normalised and packed by `tools/profiles` with the release's engine. Its source is those per-file JSON trees at the
commits its `SOURCE.json` names, and the build scripts in this repository; a release's source assets hold all of it.

## Getting and building it

```bash
git clone --recurse-submodules --shallow-submodules https://github.com/Muon-3D/muon3d-slicer-engine.git
cd muon3d-slicer-engine
git checkout <engineCommit> && git submodule update --init --depth 1 orca
bash engine/scripts/get-orca.sh --check      # orca/ is at the pinned commit, unchanged
```

Then follow `engine/scripts/README.md` ("From scratch"): fetch and build the dependencies, build both variants,
build the host. With the same Orca commit, the same `engineCommit` and Emscripten 6.0.10 on the same operating
system, the build is byte-for-byte reproducible: compare the sha256 of your `engine-<variant>.wasm` with
`variants.<variant>.sha256.wasm` in the `manifest.json` you received.

## Releases

Each release on <https://github.com/Muon-3D/muon3d-slicer-engine/releases> carries its Corresponding Source next to
the runtime, so it stays available even if an upstream download disappears:

- `muon3d-slicer-engine-<version>-source.tar.gz`: this repository at the release tag;
- `orcaslicer-<commit>-source.tar.xz`: the OrcaSlicer tree at the pinned commit;
- `third-party-sources-<key>.tar`: every library archive above, and the Emscripten ports zlib and libpng as
  Emscripten downloads them.

`docs/BUILD.md` ("From a release's source assets") rebuilds the engine from these three files alone, without the
network; every release is checked that way before it is published (`docs/RELEASING.md`). The `SOURCE.md` inside a
release's runtime adds a section naming that build's commits and source assets, with their sha256.
