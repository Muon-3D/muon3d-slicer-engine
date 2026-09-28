# The engine: OrcaSlicer's libslic3r compiled to WebAssembly

OrcaSlicer's real slicing core (`libslic3r`) compiled with Emscripten, to run in a Web Worker (or a Node
worker thread) and slice on the user's own computer. Nothing is re-implemented: the bridge follows the Orca CLI's
one-plate path (`CLI::run` for STL input with `--arrange 0`) step by step, and it takes the same flattened presets
Orca's CLI takes. See [Parity with a native CLI](#parity-with-a-native-cli) for how its output compares.

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
                     placement, toolpaths), Orca's option table as JSON (config_def), Orca's preset loading
                     and profile validator on vendor folders (profiles), Orca's log for a job (log_capture),
                     and the embind API (engine.cpp)
  scripts/           build.sh: builds one variant (st|mt) and publishes it into dist/; get-orca.sh, pin.sh
  PATCHES.md         every change needed inside Orca's src/ (none in the checkout, one out-of-tree patch)
```

Around it, in this repository:

```
orca/                        OrcaSlicer, the submodule the engine is built from (read only)
host/src/bridge.ts           the engine module: loads it, runs slice and check jobs, classifies failures
host/src/core.ts             the host core (protocol v2, docs/PROTOCOL.md); worker.ts serves it in a worker
host/src/configDefinitions.ts  reads configDefinitions() (below)
host/build.mjs               bundles the host into dist/host.<hash>.js (and the chunks it loads on demand)
packages/protocol/           protocol v2's types (Apache-2.0): see there first; change it only additively
test/                        engine.test.ts: Node tests that load the built engine and slice real plates;
                             conformance/: the protocol through the host, every transport;
                             compare.ts: the same plates through the engine and a native Orca CLI
examples/node-cli/           slicing from the command line through the host
```

## Where things live on disk

Everything large stays outside the repository, under `ORCA_WASM_ROOT` (default `~/OrcaWasm`; no spaces in it,
since it goes into the compile flags; keep it out of any synced folder, the builds are large):

| Path | What |
|---|---|
| `$ORCA_WASM_ROOT/emsdk` | Emscripten 6.0.10 (`ORCA_EMSDK` overrides it) |
| `$ORCA_WASM_ROOT/deps-src` | pinned dependency sources (hash-checked) |
| `$ORCA_WASM_ROOT/prefix-st`, `prefix-mt` | installed dependencies per variant |
| `$ORCA_WASM_ROOT/build-st`, `build-mt` | engine build trees (`ENGINE_BUILD` overrides them) |

The Orca source is the `orca/` submodule (`ORCA_SRC` overrides it); build output goes to `dist/` (`ENGINE_DIST`) and
test output to `test-out/` (`ENGINE_TEST_OUT`).

## Build, publish, test

Git Bash on Windows, or bash on Linux. The scripts set up the emsdk environment themselves (see the top of
`scripts/build.sh`), so nothing needs sourcing first. The dependencies are built once per variant (details in
[deps/README.md](deps/README.md)); rebuild the engine whenever the bridge, the CMake files or the pin change (a few
minutes per variant when the build tree exists). The whole sequence from an empty machine is in
[scripts/README.md](scripts/README.md).

```bash
bash engine/scripts/get-orca.sh                       # the orca/ submodule at the pin
bash engine/deps/fetch-deps.sh                        # once: sources into $ORCA_WASM_ROOT/deps-src
VARIANT=st bash "$PWD/engine/deps/build-deps.sh"      # once per variant: $ORCA_WASM_ROOT/prefix-st
VARIANT=mt bash "$PWD/engine/deps/build-deps.sh"
npm run build:engine                                  # st, then mt, published into dist/
npm run build:host                                    # dist/host.<hash>.js
npm run test:engine                                   # st, then mt
```

What `build.sh` publishes into `dist/`:
- `engine-<variant>.mjs` (the Emscripten module factory) and `engine-<variant>.wasm`, with precompressed `.br` and
  `.gz` copies;
- `manifest.json` (`EngineManifest` in `packages/protocol/src/manifest.ts`): Orca version and commit, build time, and
  each variant's file names, sizes, sha256 and `engineCommit`. An entry for the other variant is kept only if it
  was built from the same Orca commit, so after moving the pin rebuild **both** variants. `npm run build:host` adds
  the `host` entry (file, sha256, protocol, canary, the chunks it loads).

`dist/` is git-ignored. A page serves the whole folder as it is and starts the host by URL:
`new Worker(base + manifest.host.file, { type: 'module' })`, then protocol v2 (`docs/PROTOCOL.md`): `hello`, `load`
(optional: the first op that needs the engine loads it), `slice`.

`ORCA_EXE=<orca-slicer> node test/compare.ts` slices the same plates with the engine and with a native Orca CLI
(see the next sections for why its tolerances are loose).

## Per-object settings and the option table

- **Per-object settings.** `PlateObject.config` (optional; the bridge's `EngineObject.config`) carries an object's own settings as Orca text values,
  in the order given, keyed by Orca's per-object keys (`objectKeys` and `regionKeys` of `configDefinitions()`).
  Before any mesh loads, `check_object_config` (`bridge/model_input.cpp`) applies them over the plate's config and
  runs Orca's `validate()`, the check the presets pass; `load_object` then sets them on the `ModelObject` with
  `config.set_deserialize`, as Orca's 3MF loader does, and `Print::apply` takes them from there. An unknown key, a
  value Orca cannot read or one outside Orca's limits fails the job with code -5 and a message naming the object
  and the setting, for example `has an invalid value for the setting "Wall loops" (wall_loops): "-1". It must be
  between 0 and 1000.` Settings never carry over to the next job.
- **`configDefinitions()`** (`bridge/config_def.cpp`) returns Orca's option table as JSON text: every option of
  `print_config_def` (type, labels, tooltip, unit, limits, enum values, labels and every name `deserialize`
  accepts, default in Orca's text form, mode, GUI type) plus the key sets libslic3r defines (preset scopes,
  per-extruder and variant keys, per-object keys). It is deterministic (everything sorted) and needs no job. The
  settings catalogue generator (`npm run gen:settings`, `tools/settings-catalogue/generate.ts`) loads the built `st`
  engine in Node to read it, so after an engine rebuild run `npm run gen:settings -- --check` and regenerate if it
  reports drift. The shape is `ConfigDefinitions` in `packages/protocol/src/definitions.ts` (`format: 1`); the op
  `config.definitions` returns it.
- **`profilesNormalize()`, `profilesResolve()`, `profilesValidate()`** (`bridge/profiles.cpp`) take and return JSON
  text: the ops `profiles.*` of protocol 2.1 (docs/PROTOCOL.md, 6.10). The vendor folders of a request are written
  into a job folder of the virtual file system, and Orca's own code does the rest: `ConfigBase::load_from_json` and
  `Preset::remove_invalid_keys` per file (normalize), `PresetBundle::load_presets` as the desktop app loads system
  presets, with `data_dir()` pointed at the job folder for the call (resolve), and the same load in validation mode
  followed by `PresetBundle::has_errors` (validate, OrcaSlicer_profile_validator without its slicing mode). The
  loader's errors are collected from Orca's log (`bridge/log_capture.cpp`), which also gives `slice` its optional
  log.

## Parity with a native CLI

The engine was compared with a native Orca CLI that is an older build (state of 2026-09-25):

| Build | Orca commit |
|---|---|
| native CLI, branch `muon3d-m1` of the Muon3D fork (built 2026-07-21) | `7c5b1764ba` |
| the engine (`orcaCommit` in `dist/manifest.json`, branch `muon3d-wasm`) | `2d1163eb6f` |

Both call themselves "2.5.0-dev". They split at `edab1c0dc1` (2026-07-19): the engine has 1236 commits the CLI lacks
(upstream Orca, e.g. `aaa8e98bb0` "Time estimator fixes", plus PR #13777's exclusion volumes); the CLI has 20 the
engine lacks (the earlier exclusion-volume work on `muon3d-m1`; its M1 profile set reached `muon3d-wasm` as a
separate commit, with the keep-out zones moved to `bed_exclude_volumes`).

Measured with identical flattened presets, over 15 plates (M1 0.2/0.4/0.6 nozzles, fine to draft, normal and tree
support, vase, arc fitting, several objects, overrides, Prusa CORE One, Bambu X1C, A1 mini, H2D, H2C) plus error
cases:

- **The same:** every setting both builds know has the same value in the CONFIG block (the engine writes about 20
  newer settings as well). Layer count and max Z are equal on every plate, and filament is within 1.5 %. Every
  error case gave the same code on both (-6, -17, -18, -50, -51, -52, -61, -63, -64, -100). Object names in
  `EXCLUDE_OBJECT_*` are identical, non-ASCII included.
- **Different toolpaths:** the G-code differs from the first layer on. For example, the Benchy's
  `EXCLUDE_OBJECT_DEFINE` polygon has 34 points in the engine and 455 from the CLI, and a normal-support plate has
  4947 mm of support interface in the engine and 7420 mm from the CLI.
- **Shorter time estimates in the engine:** M1 plates −2 % to −6 % (the Benchy at 0.20 mm: 33m 10s vs 34m 55s,
  −5.0 %), M1 tree support −11.7 %, CORE One −1.1 %, X1C −0.3 %, A1 mini 0 %, and H2D −30 % (a 20 mm cube: 14m 20s
  vs 20m 31s; the start of the G-code and every acceleration command are identical, so the difference is in the
  time estimator).
- **More warnings in the engine:** objects outside the plate, Orca's validation warnings, Bambu G-code processor
  warnings (e.g. traditional timelapse on the A1 mini) and `exclusion_volume_path`.

None of these come from the bridge: it was checked against `CLI::run` step by step, and every difference traces to
the version gap. `test/compare.ts` therefore only checks that results are close (layers ±1, max Z ±0.05 mm, print
time ±10 %, filament ±5 %), on the M1 cube and Benchy, which pass. Other plates would not: M1 tree support and
multi-nozzle Bambu printers are outside 10 % on print time.

**For identical output**, build the native Orca CLI from the engine's commit (the `orca/` submodule, in a build
folder of its own) and point `ORCA_EXE` at it. After that, `compare.ts` can be made strict.

## Variants

- **st** — single-threaded; runs in every browser; TBB replaced by a serial shim (`shims/tbb-serial`).
- **mt** — pthreads + oneTBB 2021.12; needs `SharedArrayBuffer`, i.e. the page must be cross-origin isolated
  (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). A client picks mt when
  `crossOriginIsolated` is true and the manifest lists it. Browsers honour those headers only in a secure context
  (https:// or localhost): a page opened by a LAN address over plain http has to use st.

Both are wasm32, so an engine has at most 4 GB of memory. A plate too big for that fails with an error instead of
slicing (code 2; the next job in a fresh worker still works).

## Toolchain rules (every library and the engine must agree)

- Compile and link: `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1`, plus `-pthread` for mt.
- Defines: `CGAL_ALWAYS_ROUND_TO_NEAREST` (wasm cannot change FPU rounding; CGAL's interval filters are otherwise
  silently wrong), `CGAL_DISABLE_GMP` (Boost.Multiprecision backend), and `BOOST_HAS_PTHREADS` for st.
- Always `-G Ninja` with `emcmake` (on Windows, Strawberry Perl's MinGW make is often on PATH), and keep `EM_CACHE`
  on the same drive as `ORCA_WASM_ROOT`.

See `research/deps-plan.md` and `research/headless-entry.md` for the details behind these rules.
`../docs/WASM_ENGINE_SPEC.md` holds the original requirements, written before the engine existed; where it and
this folder disagree, this folder is right.
