# Spec: OrcaSlicer WebAssembly engine for the Muon3D web slicer

> **Status (2026-09-25, paths updated 2026-09-27): historical.** This is the brief the engine was
> built from, kept for its reasoning. It was written for the Muon3D web slicer app, where the engine
> started. The engine as built differs from it in several places, and where they disagree, `engine/`
> and `packages/protocol/src/v1.ts` are right:
> - **Where:** `engine/` in this repository (not a `wasm/` folder in the fork), building the `orca/`
>   submodule, branch `muon3d-wasm` (PR #13777 + the Muon3D profiles), out of tree. There is no
>   container or CI build yet (`engine/README.md`, "Build, publish, test").
> - **Dependencies:** Boost built with its own CMake (not b2), CGAL without GMP/MPFR
>   (`CGAL_DISABLE_GMP`), libjpeg-turbo instead of Emscripten's libjpeg (`engine/deps/README.md`).
> - **API:** the worker protocol and types are `packages/protocol/src/v1.ts` (the host is
>   `host/src/worker.ts`), not §6. Objects arrive already placed in bed coordinates (no `transform`),
>   and there is no `cancel` message: cancelling terminates the worker.
> - **Parity (§8):** no native CLI has been built from the engine's commit. The engine was compared
>   with an older native CLI build, so the G-code is not identical; see `engine/README.md`, "Parity
>   with a native CLI".

You are building a WebAssembly build of **our OrcaSlicer fork's real slicing core** (libslic3r) that
runs in a browser Web Worker: meshes and presets in, G-code plus structured results out. It will
replace the server-side `orca-slicer` CLI that our browser slicer UI calls today. The UI (React +
three.js) already exists and is not in the repository; this document gives you every interface
it needs. Work autonomously through the milestones below and report at each one.

## 1. Source and branches

- Repository: `https://github.com/Muon-3D/OrcaSlicer` (fork of SoftFever/OrcaSlicer, 2.5.0-dev).
- **Base branch: `muon3d-m1`.** It is what our printers run today (release binary built from
  `7c5b1764ba`, 2026-07-19) and the only branch containing the Muon3D profiles
  (`resources/profiles/Muon3D.json` + `resources/profiles/Muon3D/`).
- The exclusion-volume feature continues on `feat-3D-Exclusion-Volumes` (and
  `feature/exclusion-volume-travel-avoidance`, `feature/gcode-exclusion-volume-path-check`).
  Newer builds move the volume syntax from `bed_exclude_area` to `bed_exclude_volumes`. The build
  must work on `muon3d-m1` first and be able to rebuild from any of these branches without code
  changes (see §4, "out of tree").
- Work on a new branch `wasm-engine` created from `muon3d-m1`. Put everything you add under a
  new top-level `wasm/` directory.

## 2. Non-negotiable principles

1. **Compile Orca's own code; never re-implement slicing.** Walls, infill, supports, seams,
   G-code writing, placeholders, the GCodeProcessor (time estimates) and the fork's exclusion
   volume logic must be the fork's C++. The existing third-party ports (e.g. kimgh06/Three_Slicer)
   re-implemented most of the pipeline and are unsuitable for exactly this reason.
2. **Out-of-tree build.** Your CMake in `wasm/` globs the fork's `src/libslic3r` sources, excludes
   the desktop-only files listed in §4, and links stubs from `wasm/stubs/`. Do not edit files
   under `src/`. If a source change is truly unavoidable, make it minimal, guard it with
   `#ifdef __EMSCRIPTEN__`, and list it in `wasm/PATCHES.md` with the reason. The goal is that
   the fork can keep moving and CI keeps building the engine.
3. **Parity with the native CLI is the acceptance bar** (§8). Same flattened presets and same
   placed meshes must produce equivalent G-code.
4. **Reproducible toolchain.** Pin the Emscripten version and every dependency version; provide a
   Dockerfile (or devcontainer) that builds the engine from scratch, and a CI workflow.
5. AGPL-3.0: the engine is a derivative of OrcaSlicer. Ship it as AGPL with a source offer.

## 3. Prior art to learn from (do not depend on at runtime)

- **Hiosdra/OrcaWasm** — OrcaSlicer 2.4.2 compiled with Emscripten 3.1.74, single- and
  multi-threaded builds, `-fwasm-exceptions`, `-sSUPPORT_LONGJMP=wasm`, desktop libraries replaced
  through overrides/patches. Closest to what we want; start by building it (milestone M0) and
  reuse its toolchain decisions where they fit. Our fork is newer and has custom code, so its
  patches will not apply as-is.
- **lolookw/ipad-slicer** — OrcaWasm in Safari: ~38 MB raw / ~9 MB gzipped with OCCT, a Benchy
  in 3.5–6.6 s on an iPad M2, fixed 1 GiB shared memory after growable memory crashed on iOS.
- **kimgh06/Three_Slicer** — custom kernel, not full libslic3r; only useful for its tricks: a
  serial TBB shim, CGAL without GMP, split compile groups, dual ST/MT kernels.

## 4. Build: what to compile, stub and drop

Measured on the fork: libslic3r is ~239 .cpp files (~300k lines). No libslic3r file includes GUI
headers. Dependencies (versions in `deps/*/*.cmake`):

| Dependency | Needed for FFF slicing | Plan |
|---|---|---|
| Boost 1.84 (log, filesystem, thread, nowide, locale, regex, iostreams…) | yes | Build with b2 `toolset=emscripten`; filesystem on Emscripten's MEMFS; locale with a non-ICU backend. Emscripten's own boost port is headers-only — not enough. |
| oneTBB (fork pins 2021.5; ~495 uses incl. `parallel_pipeline` in GCode.cpp) | yes | wasm support starts at **2021.11** — bump it for the MT build. ST build: serial shim of the ~15 primitives used. Note `utils.cpp` `disable_multi_threading()` builds a temporary `global_control` and does nothing — don't rely on it. |
| CGAL 5.6 + GMP/MPFR | yes (Arachne Voronoi fix-ups `Geometry/Voronoi.cpp`, MeshBoolean, wipe tower) | Headers + GMP/MPFR built for wasm. **Risk:** wasm has no FPU rounding modes; use `CGAL_ALWAYS_ROUND_TO_NEAREST` and verify with parity tests. |
| Eigen, cereal, nlohmann, fast_float, libigl, earcut, clipper, Clipper2, admesh, libnest2d, qhull, miniz, glu-libtess, qoi, semver, expat, NLopt, libnoise | yes | Header-only or plain CMake; bundled in `deps_src/`. |
| zlib, libpng, libjpeg | yes (3MF, thumbnails) | Emscripten ports (`-sUSE_ZLIB -sUSE_LIBPNG -sUSE_LIBJPEG`); libpng needs `-sSUPPORT_LONGJMP=wasm`. |
| OpenSSL | MD5 only | Stub with a small MD5. |
| OCCT, OpenCV, assimp, draco, OpenVDB (+Blosc/OpenEXR), CURL, freetype/fontconfig, wxWidgets, glfw/GLEW, FFMPEG, OpenCSG, Python/pybind11, SLVS | no | Stub or exclude: `CAD/*`, `Format/STEP.*`, `Format/svg.*`, `Shape/TextShape.*`, `SLA*`, `SLAPrint*`, `OpenVDBUtils*`, `Format/AssimpImport*`, `Format/DRC*`, `TexturePainting*`, `ObjColorUtils*`, `TextureToColor/*`, `GCodeSender*`, `Emboss*`, `MacUtils*`. `Model.cpp` includes some of these headers — provide header stubs. Plugin hooks (`Print.cpp`) stay null. |

Resource files the core reads at runtime (preload into MEMFS): `resources/info/nozzle_info.json`,
`resources/info/nozzle_incompatibles.json`, and whatever `FlushVolPredictor` /
`ColorDecomposeRecipe` read. Add others you find.

Two variants:

- **ST** (single-threaded): works on any browser, no special headers.
- **MT** (pthreads + TBB): requires `SharedArrayBuffer`, i.e. the page is served with
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
  Load MT only when `crossOriginIsolated === true`, else ST.

Starting flags (tune freely, record final ones in `wasm/README.md`):
`-O3 -flto -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sMODULARIZE -sEXPORT_ES6
-sENVIRONMENT=worker -lembind -sFILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB
-sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=16MB` (Orca gives its threads 16 MB stacks); MT adds
`-pthread -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency -sDEFAULT_PTHREAD_STACK_SIZE=8MB`.
Do not use memory64. Ship the `.wasm` as a separate file (not `SINGLE_FILE`) so it streams.

## 5. The headless entry point (the main C++ work)

`src/OrcaSlicer.cpp` (`CLI::run`) **cannot be reused**: it includes GUI headers
(`slic3r/GUI/PartPlate.hpp`, `GLCanvas3D.hpp`, GLFW, wx) and slices through the GUI class
`Slic3r::GUI::PartPlate`. Write `wasm/bridge/engine.cpp` (~400–800 lines) that reproduces the
CLI's slicing path on one plate using libslic3r only:

1. Load the three flattened presets (§6.2) with `DynamicPrintConfig::load_from_json` (the CLI does
   this at `OrcaSlicer.cpp` ~line 2222) and build the full print config the way the CLI does
   (machine + process + filament merge, `filament_map` resize, `extruder_ams_count` defaults,
   `nozzle_volume_type`, `Model::setExtruderParams` / `setPrintSpeedTable`, plate origin (0,0,0),
   `curr_bed_type` from the process preset). Read `CLI::run` carefully and copy every
   pre-slice step that affects output for a single-plate FFF print; document any you skip.
2. Build a `Model` from the input objects (§6.2): one `ModelObject` per object with one
   `ModelVolume` (the mesh) and one instance using the given transform. Object names become the
   STL-style names Orca writes in `EXCLUDE_OBJECT_DEFINE` (we pass them already sanitised).
   **Do not arrange** (the UI places objects; the CLI equivalent is `--arrange 0`).
3. `Print::apply`, `Print::validate` (map its errors to the codes in §6.3), `Print::process` with
   a status callback forwarded as progress, `Print::export_gcode(path, &gcode_result, thumbnailCb)`.
4. Return the G-code bytes, the statistics, warnings and the toolpath arrays (§6.4) built from
   `GCodeProcessorResult` (moves, roles, widths, heights, feedrates, fan, temperature, times,
   layer ids) — not by re-parsing G-code text.
5. Also export `checkPlacement(configs, objects)`: run only the fork's pre-slice placement
   checks (`ModelInstance::intersects_bed_exclude_region(s)` against the machine's exclusion
   regions per extruder, printable-area/height checks as `PartPlate::check_outside` does) and
   return per-object results, including the intersecting triangles (as the GUI draws them red).
   The UI will call this on every object move, so it must be fast (no slicing).

Thumbnails: accept an optional callback so JS can supply PNGs (the UI renders them with
three.js); if absent, emit no thumbnail blocks. Project `.3mf` export (`store_bbs_3mf`) is
optional (milestone M5).

## 6. JavaScript API (what the UI will call)

Deliver a package `@muon3d/orca-wasm` (under `wasm/package/`) with `engine.mjs`, `engine.wasm`,
`engine-mt.mjs`, `engine-mt.wasm`, a ready-made `worker.mjs`, and `index.d.ts` containing exactly
these types (you may add fields, not rename them):

### 6.1 Worker protocol

```ts
// main thread → worker
type Request =
  | { type: 'init'; wasmBaseUrl: string; threads?: number }           // loads ST or MT
  | { type: 'slice'; id: string; job: SliceJob }
  | { type: 'check'; id: string; job: CheckJob }
  | { type: 'cancel'; id: string };                                   // MT: shared flag; ST: caller terminates the worker
// worker → main thread
type Response =
  | { type: 'ready'; variant: 'st' | 'mt'; orcaVersion: string; commit: string }
  | { type: 'progress'; id: string; percent: number; message: string }  // percent 0–100, monotonic
  | { type: 'warning'; id: string; warning: SliceWarning }
  | { type: 'done'; id: string; result: SliceResult }                   // buffers transferred, not copied
  | { type: 'checked'; id: string; result: CheckResult }
  | { type: 'error'; id: string; error: SliceError };
```

### 6.2 Inputs

```ts
/** Orca preset JSON, already inheritance-flattened by the caller (see below). */
type FlatConfig = Record<string, string | string[]>;

interface SliceObject {
  name: string;               // e.g. "Benchy.stl" — Orca names objects after their file
  positions: Float32Array;    // triangle soup, 9 floats per triangle, model units = mm
  transform: Float32Array;    // 4x4 column-major, maps `positions` to bed coordinates
}

interface SliceJob {
  machine: FlatConfig;
  process: FlatConfig;
  filaments: FlatConfig[];    // one per extruder/filament; the M1 uses one
  objects: SliceObject[];
  options?: { thumbnails?: (w: number, h: number) => Promise<Uint8Array /* PNG */> };
}
interface CheckJob { machine: FlatConfig; process: FlatConfig; filaments: FlatConfig[]; objects: SliceObject[] }
```

Bed coordinates are Orca's: mm, origin at the printable area's front-left, +Z up; objects already
rest on z = 0 at their final positions.

**Preset flattening** (done by the caller, but your tests need it): Orca's JSON presets use
`inherits`. Walk the chain through the vendor index (`resources/profiles/<Vendor>.json` lists
`machine_list`, `process_list`, `filament_list` with `sub_path`); filament parents fall back to
the `OrcaFilamentLibrary` vendor (e.g. `Generic PLA @System`). Merge parent → child (child keys
win), delete `inherits`, set `from: "system"`, `type`, `name`, `instantiation: "true"`. This is
required because the `muon3d-m1` CLI binary does **not** resolve `inherits` itself (it silently
falls back to defaults); newer fork commits add a resolver, but the engine must not depend on it. For the native CLI reference runs, also set the process preset's
`compatible_printers` to `[<machine name>]` when it is empty (the binary ignores
`compatible_printers_condition` and exits -17 otherwise). Reference chain for the M1:
machine `fdm_machine_common → fdm_common_muon_m1 → Muon3D M1 0.4 nozzle` (69 keys), process
`fdm_process_common → fdm_process_muon_m1_common → 0.20mm Standard @Muon3D M1` (123 keys),
filament `fdm_filament_common → fdm_filament_pla → Generic PLA @System → Generic PLA @Muon3D M1`
(74 keys).

### 6.3 Errors and warnings

```ts
interface SliceError {
  code: number;       // Orca CLI codes (src/libslic3r/Utils.hpp): -50 nothing inside, -51 validation,
                      // -52 partly outside, -63/-64 collisions (incl. exclusion volumes), -100 slicing,
                      // -102 unprintable area, -5 bad preset; 1 = engine crash/abort, 2 = out of memory
  message: string;    // Orca's own validation / exception text (untranslated)
  objects?: string[]; // objects the error concerns, when Orca says
}
interface SliceWarning { class: string; message: string; objects?: string[] }
// class: Orca's warning step/type, plus 'exclusion_volume_path' for the fork's
// "A G-code move intersects an exclusion volume…" critical warning.
```

### 6.4 Outputs

```ts
interface SliceResult {
  gcode: Uint8Array;
  stats: {
    printTimeSeconds: number; printTimeText: string; firstLayerTimeText: string;
    filamentMm: number; filamentCm3: number; filamentG: number; filamentCost: number | null;
    layers: number; maxZ: number;
  };
  toolpaths: Toolpaths;
  warnings: SliceWarning[];
  timingsMs: { load: number; slice: number; export: number };
}

/** Matches the UI's existing preview format; segments are ordered by layer. */
interface Toolpaths {
  roles: string[];                // Orca role names as in ';TYPE:' comments ("Outer wall", …)
  layerZ: Float32Array;           // print Z of each layer
  extrusions: {
    count: number;
    positions: Float32Array;      // 6 floats per segment (x0,y0,z0,x1,y1,z1), nozzle position
    layerStart: Uint32Array;      // layerCount + 1 entries
    roleIndex: Uint8Array;        // index into roles
    width: Float32Array;          // mm
    height: Float32Array;         // mm
    feedrate: Float32Array;       // mm/s
    fanSpeed: Uint8Array;         // 0–100 %
    temperature: Uint16Array;     // °C
    time: Float32Array;           // seconds from print start at the segment's end (normal mode)
  };
  travels: { count: number; positions: Float32Array; layerStart: Uint32Array };
}

interface CheckResult {
  objects: Array<{
    name: string;
    inside: boolean;                   // fully inside the printable volume
    exclusionHits: Array<{ extruder: number; regionIndex: number; triangles: Float32Array }>; // red pieces, bed coords
  }>;
}
```

## 7. Test data

- Models: `resources/handy_models/3DBenchy.3mf` (225,154 triangles), a generated 20 mm cube,
  `resources/handy_models/OrcaToleranceTest.stl`, a model needing support (e.g. an overhanging
  T), and a 6-object plate.
- Printers/presets (flatten per §6.2): Muon3D M1 0.4 nozzle / 0.20mm Standard / Generic PLA;
  M1 0.2 nozzle / 0.08mm Extra Fine; Prusa MK4 0.4 / its 0.20mm preset; Prusa CORE One 0.4 with
  its default (condition-only) process; Bambu Lab X1 Carbon 0.4 / 0.20mm Standard @BBL X1C.
- Setting variants: `wall_generator` arachne and classic; `enable_support` 1 with normal and
  tree; `spiral_mode` 1; `enable_arc_fitting` 1; `use_relative_e_distances` 0 and 1;
  `print_sequence` "by object"; `curr_bed_type` "Textured PEI Plate".
- Exclusion volumes (M1 `bed_exclude_area` region syntax,
  `"0..5;119.5x0,80.5x0,…|0..0.01;…"`): a cube at [100, 14] (inside the front notch → -64); two
  cubes at [40, 15] and [160, 15] (clear, but the skirt crosses the notch → expect the fork's
  path-check warning); a cube at [100, 90] (clear).

## 8. Acceptance criteria

1. **Parity.** For every test case, build the native Linux CLI from the same commit and run it
   with the same flattened presets and pre-placed STLs:
   `orca-slicer --load-settings "machine.json;process.json" --load-filaments filament.json --arrange 0 --slice 0 --outputdir out <objects>.stl`.
   The wasm G-code must be byte-identical after removing lines that differ legitimately
   (generation timestamp, file names in comments). Where it is not, document why and prove
   equivalence: same layer count, same per-role extrusion lengths within 0.1%, same time estimate
   within 1%, and a per-layer diff report. Error/warning codes must match the CLI's.
2. **Exclusion volumes.** `checkPlacement` agrees with the fork's GUI/`Print::validate` on the §7
   cases; slicing reports -64 and the path-check warning exactly as the native build does.
3. **Performance** (Chrome, recent 8-core laptop): M1 Benchy at 0.20 mm — ST ≤ 20 s, MT ≤ 7 s;
   peak memory ≤ 1 GB; `checkPlacement` for one Benchy against the M1 zones ≤ 50 ms.
4. **Size:** ≤ 8 MB brotli per variant (report raw/gzip/brotli).
5. **Browsers:** ST works in current Chrome, Firefox and Safari (macOS and iPadOS); MT in Chrome
   and Firefox with COOP/COEP. Memory growth settings documented per browser (iOS may need
   fixed memory).
6. **Robustness:** non-manifold and degenerate meshes, empty plates, objects off the bed and
   invalid settings return `error` responses — never a hung worker. A crash (abort/OOM) is
   reported as code 1/2 and the worker can be re-created.
7. **CI:** a workflow builds both variants from scratch (container), runs the parity suite (in
   Node against the same `.wasm`), and publishes the package artifact.

## 9. Milestones (report after each: what works, numbers, open problems)

| | Deliverable | Rough effort |
|---|---|---|
| M0 | Build Hiosdra/OrcaWasm; slice the M1 Benchy with our flattened presets; compare to the native CLI. Decide what to reuse. | 0.5–1 wk |
| M1 | `wasm/deps`: Boost (b2), oneTBB ≥ 2021.11 + serial shim, CGAL/GMP/MPFR, small libraries — built and cached in the container. | 2–3 wk |
| M2 | `wasm/CMakeLists.txt`: out-of-tree trimmed libslic3r + stubs, linking into a test executable that runs under Node. | 2–4 wk |
| M3 | `engine.cpp` + embind + worker + package; ST variant slicing the M1 Benchy end to end; `checkPlacement`. | 2–3 wk |
| M4 | Parity suite (§8.1–8.2) green; MT variant; performance and size numbers; CGAL rounding verified. | 2–3 wk |
| M5 (optional) | Thumbnails via callback; project `.3mf` export; build from `feat-3D-Exclusion-Volumes` (volume syntax in `bed_exclude_volumes`). | 1.5–2.5 wk |

Stop and ask (rather than guess) if: a required change touches more than a few lines under
`src/`; parity cannot be reached for a whole feature (e.g. Arachne because of CGAL); or the size
or performance budget is off by more than 2×.

## 10. Integration notes (for the UI team; no action needed from you)

The UI will load the worker lazily, send `SliceJob`s built from its plate (it already computes
each object's 4×4 placement matrix and flattens presets), render `Toolpaths` directly with its
three.js renderer, and call `checkPlacement` while objects are dragged. The
server CLI stays as a fallback for huge plates, STEP files and browsers without enough memory.
