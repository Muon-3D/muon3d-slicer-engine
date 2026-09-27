# Changes inside Orca's `src/`

**None in the Orca checkout.** The engine builds Orca's `src/libslic3r` without editing it. Every
adaptation lives in this directory; one wasm32 defect in Orca's code is fixed in a patched copy
generated in the build tree (see "Out-of-tree source patches" below).

| Problem | Where it is handled |
|---|---|
| Desktop-only sources (OCCT, OpenCV, assimp, draco, OpenVDB, SLA printing) | Left out of the source list: `cmake/OrcaSources.cmake` (`ORCA_LIBSLIC3R_EXCLUDED`, with the reason for each file) |
| Symbols kept code still needs from those files (`Step`, `load_svg`, `load_drc`, `load_assimp_textured_model`) | `stubs/Format/*.cpp`: throw "… is not supported in the browser engine." |
| `sla::DrainHole` members (used by AABBMesh, IndexedMesh, the 3MF readers) live in the OpenVDB-dependent `SLA/Hollowing.cpp` | `stubs/SLA/Hollowing.cpp.in`, filled at configure time with the member definitions copied verbatim from Orca's own file |
| `Platform.cpp` ends in `static_assert(false, "Unknown platform detected")` on Emscripten | `stubs/Platform.cpp` (Orca's unknown-platform answers) |
| `pthread_setname_np` / `pthread_getname_np` are missing from Emscripten's libc (Thread.cpp calls them) | `stubs/pthread_name.c` |
| `Utils.hpp` includes `<openssl/md5.h>` | `shims/common/openssl/md5.h` (real MD5 on Boost's md5) |
| `Model.hpp` → `Format/STEP.hpp` includes OCCT headers | `shims/occt/` (declarations only) |
| libigl's CGAL boolean code needs `Epeck_with_sqrt`, which a GMP-free CGAL cannot provide | `shims/cgal/` (compile-only placeholder, searched before CGAL for `libslic3r_cgal` only) |
| libslic3r's `FlushVolCalc.cpp` calls `RGB2HSV()`, which Orca defines in the GUI library (`src/slic3r/Utils/ColorSpaceConvert.cpp`, includes `<wx/colordlg.h>`) | That Orca file is compiled unchanged into libslic3r with a minimal `wxColour` stand-in, `shims/wx/` (`cmake/Libslic3r.cmake`) |
| oneTBB in the single-threaded engine | `shims/tbb-serial/` |

If an edit under `src/` ever becomes unavoidable, it must be tiny, guarded by
`#ifdef __EMSCRIPTEN__`, and recorded below with the file, the reason, and how it was verified.

## Recorded edits under `src/`

_None._

## Out-of-tree source patches

Defects in Orca's own code that only show on wasm32 (32-bit `size_t`, 64-bit `coord_t`) and cannot be
avoided with a shim or stub. `cmake/OrcaSourcePatches.cmake` copies the file into the build tree,
applies an exact text replacement (which must match exactly once, or configure fails), and compiles the
copy instead of the original. The copy keeps the original name for diagnostics (`#line`). Each fix is
portable (identical behaviour on 64-bit builds), so it can be upstreamed to the fork unguarded; once it
is there, delete the patch.

| # | File | Change | Why | Verified |
|---|---|---|---|---|
| 1 | `src/libslic3r/Arachne/SkeletalTrapezoidation.cpp`, `SkeletalTrapezoidation::interpolate()` | `next_inset_idx = left.toolpath_locations.size() - 1` → `next_inset_idx = coord_t(left.toolpath_locations.size()) - 1` | `next_inset_idx` is a `coord_t` (int64). For an empty `toolpath_locations`, `size() - 1` is `SIZE_MAX`, which converts to -1 only where `size_t` is 64-bit; on wasm32 it becomes 4294967295, the loop runs and reads `toolpath_locations[4294967295]`. | The M1 Benchy (Arachne walls) trapped with "memory access out of bounds" in `SkeletalTrapezoidation::propagateBeadingsDownward` ← `generateSegments` (symbolised stack) in both variants; with the patch `engine/test/engine.test.ts` passes 12/12 on st and mt, and st and mt G-code is identical. |

## Candidates to watch (not applied)

The reference port (Hiosdra/OrcaWasm, Orca 2.4.2) guarded several spots in Arachne that trapped as
"memory access out of bounds" under wasm. One of them, the empty-`toolpath_locations` case in
`SkeletalTrapezoidation::interpolate()`, is out-of-tree patch 1 above; its root cause is the 32-bit
`size_t`, not the geometry. The others (`getOrCreateBeading`, `WallToolPaths::shorterThan` /
`removeSmallLines`) are unchanged in 2.5.0-dev and are **not** patched: they would only be added if
the real-mesh test corpus reproduces a trap there.

Also noticed while compiling (wasm32 has a 32-bit `size_t`, native builds a 64-bit one), not patched:
`Arachne/WallToolPaths.cpp:525` clamps `max_bead_count` to `numeric_limits<coord_t>::max()`, which
becomes `SIZE_MAX` (4294967295) on wasm32. It only differs for absurd wall counts.

## Handled in the bridge, not in Orca

Orca defects that make a long-lived engine's G-code differ between jobs. The bridge (not the Orca
source) sets the values, so nothing here is a patch:

- `PrintObject::m_id` (`Print.hpp:607`) is never initialised and is only assigned by
  `GCode::set_object_info` (`GCode.cpp:10125`), which returns early for Bambu Lab printers and for
  flavours other than Klipper/Marlin/RRF. With `gcode_label_objects` on,
  `; printing object <name> id:<n> copy 0` then printed whatever was in memory (0, 6778473,
  151587082 …; the native CLI has the same defect). `slice_job.cpp` now calls `set_id(i)` on every
  print object after `Print::apply`, the value `set_object_info` would give, so Klipper output (the M1)
  is unchanged.
- Bambu Lab label ids (`; model label id:`, `; start printing object, unique label id:`,
  `; object ids of layer …`, the M624 skip-object ids) come from `ModelInstance::get_labeled_id()`.
  The CLI's plate code sets `use_loaded_id_for_label` (OS:6348), but an STL has no `loaded_id`, so
  the label was the process-wide `ObjectID`, which a worker keeps counting across jobs (28,38 →
  102,112 → …; the fresh CLI process prints 45,56). `slice_job.cpp` now numbers the instances
  1..n in plate order, as a 3MF's `loaded_id` would. Checked by the engine test "Bambu Lab G-code is
  the same in every job".

## Upstream behaviour that differs from an older native CLI (not patched)

The engine was compared with a native CLI built from the older fork commit `7c5b1764ba`; the engine is
built from the newer fork branch, so upstream changes merged since then show up as engine-vs-CLI
differences (print time estimates, new config keys, …). One of them is large enough to record:

**Arc fitting is lost on walls while the overhang fan is enabled.** Upstream 68ce4da19f "Fix overhang
fan speed bugs (#14788)" and e8115658e0 "Fix overhang fan control when overhang slowdown is enabled
(#15158)" make `GCode::_extrude` (`GCode.cpp:8441-8446`) set
`variable_speed = new_points.size() > 1` for every wall and bridge path whenever the filament's
`enable_overhang_bridge_fan` is on, so the path is written point by point to place the overhang fan
markers, and its arc-fitting result is never used. `ArcFitter.cpp` and `Circle.cpp` are unchanged; this
is not a wasm defect (with `enable_overhang_bridge_fan = 0` the engine fits the same arcs as the CLI).
Measured with M1 presets plus `enable_arc_fitting = 1` on a 96-facet cylinder: 6 of 14226 wall moves
are arcs (21711 lines) against 300 of 567 with the fan off (8043 lines); the old CLI gives 307 arcs in
732 wall moves. Bambu Lab's process profiles turn arc fitting on and the overhang fan is on by default,
so engine slices of those have about half the G2/G3 moves and ~20% more lines than the old CLI's (X1C
Benchy: 3418 vs 6797 arcs, 137517 vs 113588 lines). The M1 profiles have arc fitting off and are not
affected.

Decision: not patched. The engine's acceptance bar is equivalence with a native CLI built from the
same commit (`docs/WASM_ENGINE_SPEC.md` §8), and the patches above are limited to wasm32 defects whose
fix changes nothing on 64-bit builds; changing how Orca writes walls would make the engine the only
build that behaves this way. A native CLI built from the engine's commit writes the same G-code. Worth reporting upstream with this proposal: force the per-point output only when the fan state
actually changes inside the path, i.e. when for some `i` `check_overhang_fan(p[i-1]) && check_overhang_fan(p[i])`
differs from the marker the plain branch writes (`(overhang_fan_threshold == none && external
perimeter) || bridge infill || overhang perimeter`). That keeps #14788/#15158's fan output
exactly and gives the arcs back everywhere else. The engine test "arc fitting turns walls into G2/G3 …"
checks that arc fitting works with the fan off and reports the fan-on count, so an upstream fix shows
up there.
