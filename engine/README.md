# Muon3D slicing engine (OrcaSlicer → WebAssembly)

OrcaSlicer's real slicing core (`libslic3r`) compiled with Emscripten and run in a Web Worker, so
the web slicer can slice on the user's own computer. Same presets, same code, same G-code as the
Orca CLI the server runs — nothing re-implemented.

## Layout

```
engine/
  research/          findings that shaped the build (CLI path, dependencies)
  deps/              fetch + build scripts for third-party libraries (Boost, oneTBB, CGAL, …)
  CMakeLists.txt     out-of-tree build of Orca's src/libslic3r + the bridge, per variant
  shims/             replacement headers: serial TBB (st), openssl/md5.h, OCCT headers Model.hpp pulls in
  stubs/             replacement sources for desktop-only parts (STEP, SVG, DRC, assimp, Platform, …)
  bridge/            engine.cpp: headless port of the Orca CLI's slicing path + embind API
  test/              Node tests that load the built engine and slice real plates
  scripts/           build.sh (deps + engine, st|mt) and publishing into web/public/engine/
  PATCHES.md         every change needed inside Orca's src/ (goal: none)
web/src/engine/
  protocol.ts        the contract (types, worker messages) — see there first
  worker.ts          the Web Worker hosting the engine module
  client.ts          EngineClient: loading, variant choice, progress, cancel
```

## Where things live on disk (outside any synced folder — builds are large)

| Path | What |
|---|---|
| `$ORCA_WASM_ROOT/orca` | Orca source, branch `muon3d-wasm` = PR OrcaSlicer#13777 (`feat-3D-Exclusion-Volumes`) + Muon3D profiles |
| `$ORCA_WASM_ROOT/emsdk` | Emscripten 6.0.10 (`emsdk_env.ps1` / `emsdk_env.sh`) |
| `$ORCA_WASM_ROOT/deps-src` | pinned dependency sources (hash-checked) |
| `$ORCA_WASM_ROOT/prefix-st`, `prefix-mt` | installed dependencies per variant |
| `$ORCA_WASM_ROOT/build-st`, `build-mt` | engine build trees |

All of these can be overridden with `ORCA_WASM_ROOT` (default `~/OrcaWasm`) and `ORCA_SRC`.

## Variants

- **st** — single-threaded; runs in every browser; TBB replaced by a serial shim.
- **mt** — pthreads + oneTBB 2021.12; needs `SharedArrayBuffer`, i.e. the page must be
  cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`). The client picks mt when
  `crossOriginIsolated` is true.

## Toolchain rules (every library and the engine must agree)

- Compile and link: `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1`, plus
  `-pthread` for mt.
- Defines: `CGAL_ALWAYS_ROUND_TO_NEAREST` (wasm cannot change FPU rounding; CGAL's interval
  filters are otherwise silently wrong), `CGAL_DISABLE_GMP` (Boost.Multiprecision backend), and
  `BOOST_HAS_PTHREADS` for st.
- Always `-G Ninja` with `emcmake` (Strawberry Perl's MinGW make is on PATH), and keep
  `EM_CACHE` on `D:`.

See `research/deps-plan.md` and `research/headless-entry.md` for the
details behind these rules, and `../docs/WASM_ENGINE_SPEC.md` for the requirements.
