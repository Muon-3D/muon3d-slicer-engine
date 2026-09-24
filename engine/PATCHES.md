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

Found while comparing the single- and multi-threaded builds (identical G-code otherwise), not
patched because it is Orca's behaviour natively too: `PrintObject::m_id` (`Print.hpp:607`) is never
initialised and is only assigned in `GCode.cpp:10149`, inside the EXCLUDE_OBJECT_DEFINE block. With
`gcode_label_objects` on and that block not run (e.g. `gcode_flavor = marlin`, `exclude_object = 0`),
the comment `; printing object <name> id:<n> copy 0` prints whatever was in memory (0 in one build,
19656648 in the other). Parity diffs must ignore that number; the M1 profile (Klipper, exclude_object)
takes the path that assigns it.
