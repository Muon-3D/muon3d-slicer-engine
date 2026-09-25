# Muon3D slicing engine (OrcaSlicer → WebAssembly)

OrcaSlicer's real slicing core (`libslic3r`) compiled with Emscripten and run in a Web Worker, so
the web slicer can slice on the user's own computer ("Slice on: This computer"). Nothing is
re-implemented: the bridge follows the Orca CLI's one-plate path (`CLI::run` for STL input with
`--arrange 0`) step by step, and it takes the same flattened presets the server hands its CLI.
The engine is built from a newer Orca commit than the CLI the server runs, though, so the two do
**not** produce the same G-code yet: see [Parity with the server's CLI](#parity-with-the-servers-cli).

## Layout

```
engine/
  research/          findings that shaped the build (CLI path, dependencies)
  deps/              fetch + build scripts for third-party libraries (Boost, oneTBB, CGAL, …): deps/README.md
  CMakeLists.txt     out-of-tree build of Orca's src/libslic3r + the bridge, per variant
  cmake/             Orca source list, libslic3r and engine targets, out-of-tree source patches
  shims/             replacement headers: serial TBB (st), openssl/md5.h, OCCT headers Model.hpp pulls in
  stubs/             replacement sources for desktop-only parts (STEP, SVG, DRC, assimp, Platform, …)
  bridge/            headless port of the Orca CLI's slicing path (cli_config, model_input, slice_job,
                     placement, toolpaths) and the embind API (engine.cpp)
  test/              engine.test.ts: Node tests that load the built engine and slice real plates;
                     compare.ts: the same plates through the engine and the server's CLI
  scripts/           build.sh: builds one variant (st|mt) and publishes it into web/public/engine/
  PATCHES.md         every change needed inside Orca's src/ (none in the checkout, one out-of-tree patch)
web/src/engine/
  protocol.ts        the contract (types, worker messages) — see there first; change it only additively
  worker.ts          the Web Worker hosting the engine module
  client.ts          EngineClient: loading, variant choice, progress, cancel
  engineHost.ts      probes /engine/manifest.json, shares one client, warms it up after page load
  localJob.ts        plate → SliceJob → JobInfo: the browser's counterpart of server/jobs.ts
  plateMesh.ts       a library model's mesh for a local job (from the 3D view's cache or the server)
```

How the engine fits into the app (serving, headers, the "Slice on" choice) is in
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#slicing-in-the-browser).

## Where things live on disk (outside any synced folder — builds are large)

| Path | What |
|---|---|
| `$ORCA_WASM_ROOT/orca` | Orca source, branch `muon3d-wasm` = PR OrcaSlicer#13777 (`feat-3D-Exclusion-Volumes`) + Muon3D profiles (read only) |
| `$ORCA_WASM_ROOT/emsdk` | Emscripten 6.0.10 (`emsdk_env.ps1` / `emsdk_env.sh`) |
| `$ORCA_WASM_ROOT/deps-src` | pinned dependency sources (hash-checked) |
| `$ORCA_WASM_ROOT/prefix-st`, `prefix-mt` | installed dependencies per variant |
| `$ORCA_WASM_ROOT/build-st`, `build-mt` | engine build trees |
| `$ORCA_WASM_ROOT/test-out` | G-code written by `engine/test` (`ENGINE_TEST_OUT`) |

All of these can be overridden with `ORCA_WASM_ROOT` (default `~/OrcaWasm`) and `ORCA_SRC`.

## Build, publish, test

Git Bash on Windows. The scripts set up the emsdk environment themselves (see the top of
`scripts/build.sh`), so nothing needs sourcing first. The dependencies are built once per variant
(details in [deps/README.md](deps/README.md)); rebuild the engine whenever the bridge, the CMake
files or the Orca checkout change (a few minutes per variant when the build tree exists).

```bash
bash engine/deps/fetch-deps.sh                        # once: sources into $ORCA_WASM_ROOT/deps-src
VARIANT=st bash "$PWD/engine/deps/build-deps.sh"      # once per variant: $ORCA_WASM_ROOT/prefix-st
VARIANT=mt bash "$PWD/engine/deps/build-deps.sh"
VARIANT=st bash engine/scripts/build.sh               # engine, published into web/public/engine/
VARIANT=mt bash engine/scripts/build.sh               # one variant per run: st, then mt
node --test engine/test/engine.test.ts                # st
ENGINE_VARIANT=mt node --test engine/test/engine.test.ts
npm run build                                         # copies web/public/engine into web/dist/engine
```

What `build.sh` publishes into `web/public/engine/`:
- `engine-<variant>.mjs` (the Emscripten module factory) and `engine-<variant>.wasm`;
- `manifest.json` (`EngineManifest` in `protocol.ts`): Orca version and commit, build time, and
  each variant's file names and wasm size. An entry for the other variant is kept only if it was
  built from the same Orca commit, so after moving the checkout rebuild **both** variants.

`web/public/engine/` is git-ignored (it is not excluded from file sync, so it does reach other PCs through
a synced folder). A fresh git clone has no engine until it is built here, or until that folder is copied
from a machine that has it. `npm run build` must run **after** the engine build: the
server serves `web/dist/engine`, which Vite copies from `web/public/engine` (`npm run dev` serves
`web/public/engine` directly). Without an engine the app still works; "This computer" is disabled
and every slice runs on the server.

`node engine/test/compare.ts` slices the same plates with the engine and with the server's CLI (see
the next section for why its tolerances are loose).

## Parity with the server's CLI

"This computer" and "Server" run two different Orca builds, so the same plate gives different
G-code on each (state of 2026-09-25):

| Slice on | Build | Orca commit |
|---|---|---|
| Server | `../OrcaSlicer/OrcaSlicer/build/OrcaSlicer/orca-slicer.exe` (built 2026-07-21, branch `muon3d-m1`) | `7c5b1764ba` |
| This computer | the engine, `web/public/engine/manifest.json` `orcaCommit` (branch `muon3d-wasm`) | `2d1163eb6f` |

Both call themselves "2.5.0-dev". They split at `edab1c0dc1` (2026-07-19): the engine has 1236
commits the CLI lacks (upstream Orca, e.g. `aaa8e98bb0` "Time estimator fixes", plus PR #13777's
exclusion volumes); the CLI has 20 the engine lacks (the earlier exclusion-volume work on
`muon3d-m1`; its M1 profile set reached `muon3d-wasm` as a separate commit, with the keep-out zones
moved to `bed_exclude_volumes`).

Measured with identical flattened presets, over 15 plates (M1 0.2/0.4/0.6 nozzles, fine to draft,
normal and tree support, vase, arc fitting, several objects, overrides, Prusa CORE One, Bambu X1C,
A1 mini, H2D, H2C) plus error cases:

- **The same:** every setting both builds know has the same value in the CONFIG block (the engine
  writes about 20 newer settings as well). Layer count and max Z are equal on every plate, and
  filament is within 1.5 %. Every error case gave the same code on both (-6, -17, -18, -50, -51,
  -52, -61, -63, -64, -100). Object names in `EXCLUDE_OBJECT_*` are identical, non-ASCII included.
- **Different toolpaths:** the G-code differs from the first layer on. For example, the Benchy's
  `EXCLUDE_OBJECT_DEFINE` polygon has 34 points in the engine and 455 on the server, and a
  normal-support plate has 4947 mm of support interface in the engine and 7420 mm on the server.
- **Shorter time estimates in the engine:** M1 plates −2 % to −6 % (the Benchy at 0.20 mm: 33m 10s
  vs 34m 55s, −5.0 %), M1 tree support −11.7 %, CORE One −1.1 %, X1C −0.3 %, A1 mini 0 %, and H2D
  −30 % (a 20 mm cube: 14m 20s vs 20m 31s; the start of the G-code and every acceleration command
  are identical, so the difference is in the time estimator).
- **More warnings in the engine:** objects outside the plate, Orca's validation warnings, Bambu
  G-code processor warnings (e.g. traditional timelapse on the A1 mini) and
  `exclusion_volume_path`.

None of these come from the bridge: it was checked against `CLI::run` step by step, and every
difference traces to the version gap. `engine/test/compare.ts` therefore only checks that results
are close (layers ±1, max Z ±0.05 mm, print time ±10 %, filament ±5 %), on the M1 cube and Benchy,
which pass. Other plates would not: M1 tree support and multi-nozzle Bambu printers are outside
10 % on print time.

**For identical output**, build the native Orca CLI from the engine's commit into a folder of its
own (never inside `../OrcaSlicer`, which is read only) and point the server at it with `ORCA_DIR`
(or `ORCA_EXE` and `ORCA_RESOURCES`). Its M1 profile keeps the keep-out zones in
`bed_exclude_volumes`; `shared/bed.ts` reads both syntaxes, but re-check the keep-out behaviour
against that build (see "Muon3D M1" in `docs/ARCHITECTURE.md`). After that, `compare.ts` can be
made strict.

## Variants

- **st** — single-threaded; runs in every browser; TBB replaced by a serial shim.
- **mt** — pthreads + oneTBB 2021.12; needs `SharedArrayBuffer`, i.e. the page must be
  cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`). The client picks mt when `crossOriginIsolated` is
  true and the manifest lists it. The server and the Vite dev server send both headers on every
  response (`shared/crossOriginIsolation.ts`), but browsers honour them only in a secure context
  (https:// or localhost): opened by a LAN address over plain http, the page uses st.

Both are wasm32, so an engine has at most 4 GB of memory. A plate too big for that fails with an
error instead of slicing (the next job still works); slice it on the server.

## Toolchain rules (every library and the engine must agree)

- Compile and link: `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1`, plus
  `-pthread` for mt.
- Defines: `CGAL_ALWAYS_ROUND_TO_NEAREST` (wasm cannot change FPU rounding; CGAL's interval
  filters are otherwise silently wrong), `CGAL_DISABLE_GMP` (Boost.Multiprecision backend), and
  `BOOST_HAS_PTHREADS` for st.
- Always `-G Ninja` with `emcmake` (Strawberry Perl's MinGW make is on PATH), and keep
  `EM_CACHE` on `D:`.

See `research/deps-plan.md` and `research/headless-entry.md` for the
details behind these rules. `../docs/WASM_ENGINE_SPEC.md` holds the original requirements, written
before the engine existed; where it and this folder disagree, this folder is right.
