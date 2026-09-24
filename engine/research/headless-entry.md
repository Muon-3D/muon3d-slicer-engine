# headless-entry

## Summary

Traced CLI::run in $ORCA_WASM_ROOT/orca/src/OrcaSlicer.cpp (muon3d-wasm, lines 1229-7880) for the path `--load-settings "m;p" --load-filaments f --arrange 0 --slice 0 --outputdir out *.stl`. The slicing path can be rebuilt with libslic3r alone. Only five GUI pieces are involved, and each is small to replace or has no effect in this case:
- **PartPlateList/PartPlate** supply a plain `new Print()`, plate origin (0,0,0), plate index 0, a plate config of `{filament_map_mode = fmmAutoForFlush}`, and the plate shape `make_counter_clockwise(printable_area)`.
- **BitmapCache::parse_color4** and **Plater's get_min_flush_volumes** are used only by the flush-matrix step. They are about 60 lines to copy.
- **PartPlate::estimate_wipe_tower_polygon** (the wipe-tower clamp) does nothing for STL input with `--arrange 0`, because objects are never added to the plate. Skip it for parity.
- **get_extruders_under_cli** returns empty in this case, so the checks built on it pass trivially.

The report gives:
- every pre-slice step, with line numbers and whether it needs GUI code;
- an engine.cpp sketch, with exact "copy verbatim" line ranges for the filament-merge and flush-matrix blocks;
- the status/cancel/exception API and the CLI exit-code mapping;
- a GCodeProcessorResult→Toolpaths recipe. Note that `MoveVertex.time` is per-move, not cumulative. Layer Z has to be taken from extrusion Z because non-BBL printers leave `print_z` at 0. The "first layer time" line in the G-code is actually the start-G-code time.
- the exclusion-volume API with exact signatures, plus a checkPlacement recipe;
- the libslic3r CMake analysis: 221 sources, the link targets, a 15-file exclusion list, and the stubs needed. The stubs are an openssl/md5.h shim, 4 OCCT .hxx shims (Model.hpp includes Format/STEP.hpp), and implementations for Step/load_svg/load_drc/load_assimp_textured_model, Platform and SLA DrainHole.
- the runtime resource files libslic3r reads.

The biggest parity traps:
- Bambu label ids depend on the global ObjectID counter.
- libjpeg-turbo is needed for `JCS_EXT_RGBA`.
- Platform.cpp fails to compile under Emscripten (`static_assert`).
- `export_gcode` returns early when the output file already exists, so use a fresh Print per job.
- `load_from_json` only reads files, so presets must be written to MEMFS first.

## Reusable

- $ORCA_WASM_ROOT/orca/src/OrcaSlicer.cpp:590-649 load_default_gcodes_to_config (copy)
- $ORCA_WASM_ROOT/orca/src/OrcaSlicer.cpp:2210-2284 load_config_file (preset load/validation logic)
- $ORCA_WASM_ROOT/orca/src/OrcaSlicer.cpp:3060-3121 update_full_config lambda (copy as function)
- $ORCA_WASM_ROOT/orca/src/OrcaSlicer.cpp:3135-3338 machine+process merge incl. cli_config.json clamp 3180-3243
- $ORCA_WASM_ROOT/orca/src/OrcaSlicer.cpp:3432-3683 filament merge block (copy verbatim with listed substitutions)
- $ORCA_WASM_ROOT/orca/src/OrcaSlicer.cpp:3685-3862 flush-volume matrix block (copy; replace GUI helpers)
- $ORCA_WASM_ROOT/orca/src/OrcaSlicer.cpp:3999-4110 extra-config apply, normalize, FullPrintConfig fill, validate(-18)
- $ORCA_WASM_ROOT/orca/src/OrcaSlicer.cpp:6331-6970 per-plate slice path (BuildVolume, pre-check, new_print_config, apply/validate/process/export, code mapping)
- $ORCA_WASM_ROOT/orca/src/slic3r/GUI/BitmapCache.cpp:543-556 parse_color4 + src\slic3r\GUI\GUI_Utils.hpp:438-444 hex_digit_to_int
- $ORCA_WASM_ROOT/orca/src/slic3r/GUI/Plater.cpp:1034-1095 get_min_flush_volumes (pure config math)
- $ORCA_WASM_ROOT/orca/src/slic3r/GUI/PartPlate.cpp:2993-3092 estimate_wipe_tower_footprint/polygon clamp (optional GUI-parity)
- $ORCA_WASM_ROOT/orca/src/slic3r/GUI/PartPlate.cpp:3439-3519 check_outside, 4148-4167 get_build_volume, 1380-1460 red intersection preview
- $ORCA_WASM_ROOT/orca/src/slic3r/GUI/3DScene.cpp:1370-1470 per-extruder exclusion state merge
- $ORCA_WASM_ROOT/orca/src/slic3r/GUI/LibVGCode/LibVGCodeWrapper.cpp:191-266 GCodeProcessorResult->vertex conversion reference
- $ORCA_WASM_ROOT/orca/src/libvgcode/src/Layers.cpp:20-42 layer z rule
- $ORCA_WASM_ROOT/orca/src/libslic3r/Print.cpp:70-150 exclusion helpers (colliding_bed_exclusion), 1446-1600 layered_print_cleareance_valid, 1812+ validate
- $ORCA_WASM_ROOT/orca/src/libslic3r/PrintConfig.cpp:12950-13420 bed exclusion parsing/resolution
- $ORCA_WASM_ROOT/orca/src/libslic3r/Model.cpp:3403-3727 convex_hull_2d + intersects_bed_exclude_region(s); 3833 calc_print_volume_state
- $ORCA_WASM_ROOT/orca/src/libslic3r/GCode.cpp:2523-2740 do_export (processor, warnings, stats), 2396-2436 update_print_estimated_stats
- $ORCA_WASM_ROOT/orca/src/libslic3r/GCode/GCodeProcessor.hpp:32-360 result structures
- $ORCA_WASM_ROOT/orca/src/libslic3r/SLA/Hollowing.cpp:151-279 DrainHole methods (copy into stub)
- $ORCA_WASM_ROOT/orca/src/libslic3r/Platform.cpp (copy into stub with __EMSCRIPTEN__ branch)
- $ORCA_WASM_ROOT/orca/src/libslic3r/CMakeLists.txt:28-305 source list to parse (strip # comments), 367-373 libslic3r_cgal, 452-477 link list
- $ORCA_WASM_ROOT/ref/OrcaWasm/wasm/shims-common/openssl/md5.h (reference md5 shim)
- $ORCA_WASM_ROOT/ref/OrcaWasm/wasm/shims/tbb (reference serial TBB shim headers)
- $ORCA_WASM_ROOT/ref/OrcaWasm/patches/apply.py (sections 8-8f: Arachne UB guards found under wasm; 5: Platform; 6: JPEG; 7: Boost.Log)
- $ORCA_WASM_ROOT/ref/OrcaWasm/wasm/CMakeLists.txt (tested emcc link flags incl. PTHREAD_POOL_SIZE notes)
- $ORCA_WASM_ROOT/orca/resources/info/nozzle_info.json, resources\info\nozzle_incompatibles.json, resources\flush\*.txt, resources\filament_mixing\standard_color_recipes.json, resources\profiles\BBL\cli_config.json (MEMFS preload set)
- $ORCA_WASM_ROOT/orca/resources/profiles/Muon3D/machine/fdm_common_muon_m1.json:136-137 (bed_exclude_volumes syntax on this branch)

## Risks

- Bambu label ids break byte parity: on Bambu printers the G-code carries `; model label id:` and M624 label ids taken from ModelInstance::get_labeled_id(), which is the global ObjectBase::s_last_id counter (private). The engine's IDs will differ from the CLI's and drift across jobs in one worker. The parity diff should normalize them, or the engine can set instance->loaded_id with use_loaded_id_for_label=true, which changes the output vs the CLI. Non-Bambu flavours (the M1 on Klipper) use sequential ids and are not affected.
- CLI parity requires skipping the wipe-tower clamp: in the STL + --arrange 0 path PartPlate::estimate_wipe_tower_polygon does nothing because objects are never added to the plate, so the raw wipe_tower_x/y from the preset is used. This differs from the GUI, which clamps. Multi-filament UI jobs will want a tower position override, which breaks parity by design.
- The G-code 'estimated first layer printing time' line is actually machine start-G-code time (prepare_time); the real first-layer time is initial_layer_time. Pick one deliberately for firstLayerTimeText.
- curr_bed_type in the CLI comes only from the loaded JSON or the default btPC (Cool Plate). The CLI never uses default_bed_type as the GUI does, so bed temperatures differ unless the UI puts curr_bed_type into the process FlatConfig.
- load_from_json only reads from a file path, so presets must be written to MEMFS first. Presets must also be flattened with from=system and a type key: an 'inherits' value, a missing 'type', or from=user make the CLI load a PresetBundle, which the engine must refuse. A process JSON with an empty different_settings_to_system array hits unchecked [0] indexing in the CLI (OS:2346).
- Build blockers that need out-of-tree workarounds: Platform.cpp static_assert under Emscripten (replace the file); GCode/Thumbnails.cpp needs libjpeg-turbo for JCS_EXT_RGBA (not Emscripten's -sUSE_LIBJPEG); Utils.hpp includes openssl/md5.h everywhere (shim); Model.hpp includes Format/STEP.hpp, which includes OCCT headers (4 .hxx shims or -ivfsoverlay); utils.cpp's Boost.Log async sink and thread-id attribute do not compile against a BOOST_LOG_NO_THREADS Boost; pthread_setname_np in Thread.cpp; CGAL on 32-bit wasm likely needs CGAL_DO_NOT_USE_MPZF plus CGAL_ALWAYS_ROUND_TO_NEAREST.
- Arachne undefined behaviour showed up as wasm 'memory access out of bounds' traps in the reference project (Hiosdra/OrcaWasm patches/apply.py sections 8-8f: SkeletalTrapezoidation getOrCreateBeading/interpolate, WallToolPaths shorterThan/removeSmallLines, uninitialized WallToolPathsParams). Expect to need small #ifdef __EMSCRIPTEN__ guards under src/, recorded in PATCHES.md.
- GCode::do_export returns immediately without refilling GCodeProcessorResult when psGCodeExport is done and the output file exists (GCode.cpp:2537). Use a fresh Print per job, or delete the output file first.
- A naive glob of src/libslic3r compiles dead files (ExPolygonCollection.cpp, JumpPointSearch.cpp, GCodeSender.cpp, TryCatchSignalSEH.cpp). Parsing the CMake list without stripping '#' comments also picks up the commented-out GCodeSender.cpp and SLA/SupportTreeIGL.cpp.
- The stub list assumes libslic3r is linked as a static archive. A whole-archive or OBJECT-library link pulls in e.g. SLA Rotfinder/SupportPointGenerator and needs many more stubs.
- Progress is not monotonic (71 → 50 → 75 → 70 → 80) and there is no status during long single steps such as tree support. In the ST build, cancel only works by terminating the worker; in MT it needs a shared-memory flag plus a watcher thread, because the slicing thread cannot receive postMessage.
- Toolpath memory: GCodeProcessor inserts 'actual speed' split moves (internal_only, time=0), so Benchy-scale jobs can reach millions of segments (~24 B/segment for positions alone). Consider merging collinear points; arcs are also internal_only, so merge only collinear ones.
- Warnings raised during export (SlicingEmptyGcodeLayers, SlicingExclusionVolumeToolpath, priming overlap) do not change the CLI exit code: they are collected after the CLI's warning check. The engine must report them as warnings, not errors, to match the CLI's exit codes.
- Branch differences: this branch reads collision volumes from bed_exclude_volumes (M1 profile line 137), while muon3d-m1 / the 7c5b1764ba binary used the volume syntax inside bed_exclude_area. The spec's §7 test strings and flush-contact behaviour must be checked per branch.
- The CLI reads resources/profiles/BBL/cli_config.json to lower machine_max_* for Bambu Lab A1, A1 mini and A2L. If it is not preloaded (or embedded), time estimates and the M201/M203 limits differ for those printers.
- Presets flattened with extra keys that update_full_config copies blindly (e.g. different_settings_to_system or inherits_group inside machine.json) would overwrite the CLI-computed columns and change the config block.

## Details

# Headless slicing entry point spec — Orca `muon3d-wasm` ($ORCA_WASM_ROOT/orca, HEAD 2d1163eb6f = PR #13777 @432debfc74 + M1 profiles)

All line numbers are for this checkout. `OS` = `src/OrcaSlicer.cpp`, `PP` = `src/slic3r/GUI/PartPlate.cpp`, `L/` = `src/libslic3r/`.

Reference invocation analysed: `orca-slicer --load-settings "machine.json;process.json" --load-filaments f1.json[;f2.json] --arrange 0 --slice 0 --outputdir out a.stl [b.stl …]`.

---
## 1. Pre-slice pipeline in CLI::run (OS:1229–7880) for STL input, no arrange, one plate

### 1.1 Step table ("GUI?" = needs a slic3r/GUI class)

| # | Lines (OS) | What happens | GUI? | Engine action |
|---|---|---|---|---|
| 1 | 1374-1380 | `m_extra_config` gets `has_filament_switcher=false` and `enable_filament_dynamic_map=false` (unless given on the command line), then `m_extra_config.apply(m_config,true)` and `normalize_fdm()`. No CLI key collides with print_config_def keys (checked), so extra = these 2 bools. They end up in the G-code config block. | no | copy |
| 2 | 1718-1775, 1947-1990 | Each STL is loaded with `Model::read_from_file(file,…, LoadModel\|AddDefaultInstances)`, which calls `load_stl` (L/Format/STL.cpp:17). `TriangleMesh::ReadSTLFile(repair=true)` runs `trianglemesh_repair_on_import` (L/TriangleMesh.cpp:79-178). Normals are recomputed, so input normals don't matter. Object name = file basename (including `.stl`). `Model::add_object(name,path,mesh)` (L/Model.cpp:570) sets object config `extruder=1`. `add_default_instances()` adds an identity instance, then `o->ensure_on_bed()` runs (1987). `need_arrange=true` until `--arrange 0`. | no | Write a binary STL to MEMFS and call `load_stl(path,&model,name)` for the identical code path; see §1.3 |
| 3 | 2008-2009 | The file config is merged into `m_print_config`; it is empty for STL. | no | skip |
| 4 | 2210-2284 | `load_config_file`: `config.load_from_json(file, Enable, kv, reason)` (2222; L/Config.cpp:843). **It reads only from a file path.** Then: `from` must be `system`/`User`/`user`, else -5; `type` comes from kv (if missing, PresetBundle probes it); `resolve_preset` builds a PresetBundle only when `inherits` is non-empty (2120-2162); `config.normalize_fdm()` (2265). | PresetBundle is libslic3r, not GUI, but heavy | Require flattened presets with `type` and without `inherits` (or empty), `from:"system"`. Reject otherwise with -5. |
| 5 | 2287-2370 | machine: `printer_settings_id=name` (2303); `printer_model`→`printer_model_id` from `resources/profiles/BBL/machine_full/*.json` (3MF-only use). process: `print_settings_id=name` (2340); `new_print_compatible_printers = compatible_printers` (2342); `different_process_setting = different_settings_to_system[0]` if the key exists (2344-2347; the CLI indexes `[0]` unchecked, so an empty array is undefined behaviour). | no | copy |
| 6 | 2425-2475 | filaments: name, `filament_id` (kv `filament_id`), `inherits` only recorded for from=User; config kept per slot `index+1`. | no | copy |
| 7 | 2837-2966 | Compatibility check: `is_compatible_with_printer(proc, Preset::TYPE_PRINT, machine, new_printer_system_name)` (L/Preset.hpp:465). It evaluates `compatible_printers` and `compatible_printers_condition`. Failure gives **-17** (2961-2965). | no | copy (use machine `name`) |
| 8 | 3125-3131 | `different_settings_to_system` and `inherits_group` are resized to `filament_count+2`; [0] = process diff. | no | copy |
| 9 | 3135-3257 | Machine merge: `load_default_gcodes_to_config(machine, TYPE_PRINTER)` (3162; function OS:590-649) creates missing G-code keys. `update_full_config(m_print_config, machine, …, update_all=true)` (3174; lambda OS:3060-3121) copies every key except `compatible_prints, compatible_printers, model_id, inherits, dev_model_name, name, from, type, version, setting_id, instantiation`. Because new_printer_name != current_printer_name(""), `resources/profiles/BBL/cli_config.json` → `printer[printer_model].machine_limits` lowers `machine_max_*` (key `cli_safe_*` with the first 8 chars replaced) (3180-3243). This only applies to Bambu Lab A1, A1 mini and A2L. | no (reads a resource) | copy, or embed the 3-printer table |
| 10 | 3258-3263 | `new_extruder_count = nozzle_diameter.size()`; `new_printer_variant_count = printer_extruder_variant.size()` | no | copy |
| 11 | 3266-3338 | Process merge: `print_compatible_printers = compatible_printers`; `different_settings[0]`, `inherits_group[0]=""`; `load_default_gcodes_to_config(TYPE_PRINT)` does nothing; `update_full_config(update_all=true)`. | no | copy |
| 12 | 3340-3366 | `new_nozzle_volume_type` = [nvtStandard]×extruders (unless `--nozzle-volume-type`); `current_nozzle_volume_type` = [nvtStandard] (current_extruder_count=1). | no | copy |
| 13 | 3368-3430 | machine_switch (3MF only) | - | skip |
| 14 | 3432-3683 | **Filament merge** (below) | no | copy verbatim |
| 15 | 3685-3862 | **Flush matrix** (below) | **yes**: `GUI::BitmapCache::parse_color4`, `GUI::get_min_flush_volumes` | copy with the helpers re-implemented |
| 16 | 3865-3888 | `printer_technology` defaults to ptFFF; multiple Models merged into one via `m.add_object(*o)` clones + `add_default_instances()`, in input order | no | build one Model directly (same result except ObjectIDs, see risks) |
| 17 | 3968-4055 | Bookkeeping for command-line overrides in different_settings_to_system (none in our case) | no | skip |
| 18 | 3999, 4057, 4059-4073, 4075 | `m_print_config.apply(m_extra_config,true)`; `normalize_fdm()`; mixed-slot check gives -69; `printer_technology=ptFFF` | no | copy |
| 19 | 4079-4101, 4103-4110 | `FullPrintConfig fff; fff.apply(cfg,true); cfg.apply(fff,true);` fills every default (e.g. `curr_bed_type` default = **btPC / Cool Plate**, L/PrintConfig.cpp:1299; the CLI does **not** use `default_bed_type`). `cfg.validate(true)` non-empty gives **-18**. | no | copy |
| 20 | 4112-4167 | `enable_wrapping_detection` option created; "disable prime tower after mapping" is 3MF only | no | create the option only |
| 21 | 4169-4280 | `PartPlateList partplate_list(NULL, model, ptFFF)`: `PartPlateList::init` (PP:4849) does `new Print()` and `new GCodeResult()`. `PartPlate::set_print` (PP:3318) calls `print->set_plate_origin((0,0,0))` (PP:3328). `set_index(0)` sets `print->set_plate_index(0)` (PP:3115). `PartPlate::init` (PP:195) sets plate `m_config = {filament_map_mode: fmmAutoForFlush}`. Then `reset_size(bbox w,d,h,false)` clears plate instances, and `set_shapes(make_counter_clockwise(printable_area), legacy_exclude, wrapping, extruder_printable_area, extruder_printable_height, "", lid, rod)` → plate 0 shape = printable_area in CCW order shifted by (0,0) (PP:4045). | **yes** | Replace with the 5 values above |
| 22 | 4282-4715 | old-3MF params, plate_data translate, downward check | - | skip |
| 23 | 4717-5070 | transforms; `arrange` 0 sets `need_arrange=false` (4868-4882) | no | - |
| 24 | 5075-6049 | orient/arrange: skipped. **Objects are therefore never added to PartPlate::obj_to_instance_set.** | - | - |
| 25 | 6051-6060 | `--ensure-on-bed` (default false, L/PrintConfig.cpp:12157) | no | - |
| 26 | 6262-6285 | Wipe-tower clamp via `plate->estimate_wipe_tower_polygon(cfg, index, pos, size)` (PP:3047). **No effect here:** `estimate_wipe_tower_footprint` (PP:2993) gets filaments from `get_extruders(true,cfg,cfg)` (PP:2087), which only counts objects in `obj_to_instance_set` (empty), so footprint = 0 and the step `continue`s. The raw `wipe_tower_x/y` from the preset is used. | yes | **skip for CLI parity**; optional GUI-parity clamp in §1.5 |
| 27 | 6309-6310 | `part_plate->get_print(&print,&gcode_result,&idx)` | yes | a local `Print` + `GCodeProcessorResult` |
| 28 | 6331-6339 | `BuildVolume(plate->get_shape(), printable_height, plate->get_extruder_areas(), extruder_printable_height)`; `model.update_print_volume_state(bv)==0` gives **-50** | shape only | `BuildVolume(ccw(printable_area), …)` |
| 29 | 6340-6680 | Pre-check (slice 0 means pre_check=true): each instance gets `use_loaded_id_for_label=true` (no effect, loaded_id=0 for STL); `Partly_Outside` gives **-52**; `--mtcpp` triangle limit gives -59. If extruders>1: per-extruder printable area gives -66/-68. TPU check (`check_tpu_printable_status`, PP:2722) always returns true. Mixed-filament type gate -69. `get_extruders_under_cli` is empty for STL. | yes (trivial) | copy -50/-52; multi-extruder part only if needed |
| 30 | 6688-6749 | `new_print_config = m_print_config; apply(*plate->config()); apply(m_extra_config,true)`. If extruders>1 and mode<fmmManual: `extruder_ams_count[e]="1#0\|4#1"` and `print->set_extruder_filament_info` with 4 dummy {colour #FFFFFFFF, type cycled from filament_type, is_support 0} per extruder (6697-6735). `filament_map` resized to filament_count (fill 1), all 1 if 1 extruder (6738-6744); `nozzle_volume_type` defaulted if absent (6745-6749). | plate cfg | copy |
| 31 | 6750-6810 | `print->apply(model,new_print_config)`; `set_no_check_flag(false)`; `is_BBL_printer() = printer_model starts with "Bambu Lab"` (fallback: printer name) (6754-6770); `set_check_multi_filaments_compatibility(!allow_mix_temp=true)`; `validate(&warnings)` mapped to codes (§2.4) | no | copy |
| 32 | 6812-6816 | `print->empty()` gives **-50** | no | copy |
| 33 | 6822-6851 | `set_status_callback(default_status_callback)` (OS:403): collects warnings with `warning_step!=-1` | no | own callback |
| 34 | 6853-6856 | `Model::setExtruderParams(m_print_config /*pre-plate full cfg*/, filament_count)` and `Model::setPrintSpeedTable(m_print_config, print->config())` (L/Model.cpp:3127,3072). These are **static state used by auto-brim width (L/Brim.cpp:154)**. Must run before process. | no | copy |
| 35 | 6878 | `print->process(&time_using_cache)` | no | `print.process()` |
| 36 | 6887-6895 | multi-extruder: write maps back to the plate (3MF only) | yes | skip |
| 37 | 6898-6902 | `get_conflict_string()` non-empty gives **-101** | no | copy |
| 38 | 6906-6939 | Warnings collected so far: NON_CRITICAL recorded (-100 only with `--strict`); CRITICAL of type SlicingEmptyGcodeLayers/SlicingGcodeOverlap gives -100 (unless `--no-check`). In this branch only `SlicingNeedSupportOn` (NON_CRITICAL, L/PrintObject.cpp:989) can occur before export. | no | copy |
| 39 | 6941-6957 | `outfile = outdir+"/plate_1.gcode"`; `print_fff->export_gcode(outfile, gcode_result, nullptr)`. **No thumbnail callback, so the CLI G-code has no thumbnail blocks.** | no | copy (optional cb) |
| 40 | 6960-6970 | `gcode_result->gcode_check_result.error_code != 0` gives **-102** | no | copy |
| 41 | 7028-7034 | any `std::exception` in process/export gives **-100** | no | copy |

**Bambu-specific ("is_bbl") paths:**
- `is_bbl_3mf` branches (1776-1945, 2542, 2549-2779, 2970, 3129, 4114, 4236, 4283, 5134) are all 3MF-only and never taken for STL.
- `Print::is_BBL_printer()` (6754-6770) changes G-code heavily: config block at the top, `; model label id:` list and M624 label ids = `ModelInstance::get_labeled_id()`, `; Z_HEIGHT:` tags, wipe tower Type1 (`Print::wipe_tower_type`, L/Print.hpp:1176), and `GCodeProcessor::s_IsBBLPrinter`.
- The `cli_config.json` machine limits apply to A1, A1 mini and A2L only.
- `printer_model_id` is used for 3MF export only.

### 1.2 GUI helpers to re-implement (code to copy)

```cpp
// src/slic3r/GUI/GUI_Utils.hpp:438-444
static int hex_digit_to_int(const char c) {
  return (c>='0'&&c<='9')?int(c-'0'):(c>='A'&&c<='F')?int(c-'A')+10:(c>='a'&&c<='f')?int(c-'a')+10:-1; }
// src/slic3r/GUI/BitmapCache.cpp:543-556 (BitmapCache::parse_color4)
static bool parse_color4(const std::string& s, unsigned char* rgba) {
  rgba[0]=rgba[1]=rgba[2]=0; rgba[3]=255;
  if ((s.size()!=7 && s.size()!=9) || s.front()!='#') return false;
  const char* c=s.data()+1;
  for (size_t i=0;i<s.size()/2;++i){int d1=hex_digit_to_int(*c++),d2=hex_digit_to_int(*c++); if(d1==-1||d2==-1)return false; rgba[i]=(unsigned char)(d1*16+d2);}
  return true; }
// src/slic3r/GUI/Plater.cpp:1034-1095: std::vector<int> get_min_flush_volumes(const DynamicPrintConfig&, size_t nozzle_id)
//   copy verbatim. It is pure config math and uses LongRectrationLevel::EnableFilament from L/PrintConfig.hpp:266.
// OS:590-649 load_default_gcodes_to_config(DynamicPrintConfig&, Preset::Type)   -- copy, logging removable
// OS:3060-3121 update_full_config lambda -- copy as a function; we only call it with update_all=true
```

### 1.3 Model construction (identical to the CLI)
- **Parity mode (default):** bake the UI 4×4 into the vertices (double math, cast to float, which is exactly what exporting a placed STL does). Write a binary STL: 80-byte header, uint32 count, 50 B/facet (normal may be 0; it is recomputed). Write it to `/tmp/in/<i>.stl`, then `load_stl(path, &model, obj.name.c_str())`. This uses the same repair path as the CLI, including `stl_facet_stats` tolerances and NaN-facet skipping (`deps_src/admesh/stlinit.cpp:153-300`).
- **Fast mode:** build an `stl_file` in memory:
  - set `stats.type=inmemory`, `number_of_facets=original_num_facets=n`, then `stl_allocate`;
  - fill `facet_start[i].vertex[0..2]`, skipping NaN facets, and call `stl_facet_stats(&stl,f,first)` for each;
  - set `stats.size=max-min` and `bounding_diameter=size.norm()`;
  - call `TriangleMesh m; m.from_stl(stl,true)` and `model.add_object(name,name,std::move(m))`.
- Keep the transform instead of baking it with `inst->set_transformation(Geometry::Transformation(T))` (Geometry.hpp:413). Output is equivalent but not byte-exact.
- Then call `model.add_default_instances(); for(o) o->ensure_on_bed();`.

### 1.4 libslic3r-only sequence (sketch of wasm/bridge/engine.cpp core)

```cpp
#include <libslic3r/libslic3r.h>
#include <libslic3r/Utils.hpp>          // CLI_* (Utils.hpp:26-77), set_resources_dir, set_temporary_dir, get_time_dhms
#include <libslic3r/Model.hpp>
#include <libslic3r/Print.hpp>
#include <libslic3r/PrintConfig.hpp>    // filament_options_with_variant, get_flush_volumes_matrix, get_extruder_variant_string
#include <libslic3r/Preset.hpp>         // BBL_JSON_KEY_*, Preset::TYPE_*, is_compatible_with_printer
#include <libslic3r/BuildVolume.hpp>
#include <libslic3r/ClipperUtils.hpp>   // Pointfs make_counter_clockwise(const Pointfs&)
#include <libslic3r/FlushVolCalc.hpp>
#include <libslic3r/Format/STL.hpp>
#include <libslic3r/GCode/GCodeProcessor.hpp>
using namespace Slic3r;

void engine_init() {                    // CLI::setup OS:7882-7986 equivalent
  set_resources_dir("/resources");      // MEMFS preload, see §6
  set_temporary_dir("/tmp");            // CLI: per_user_temp_dir (OS:1357-1364)
  set_logging_level(1);
}

struct P { DynamicPrintConfig cfg; std::string type, name, filament_id, from; };
static int load_preset(const std::string& json, const std::string& path, P& p) {    // OS:2210-2284
  write_file(path, json);
  std::map<std::string,std::string> kv; std::string reason;
  p.cfg.load_from_json(path, ForwardCompatibilitySubstitutionRule::Enable, kv, reason);
  if (!reason.empty()) return CLI_CONFIG_FILE_ERROR;                               // -5
  p.name = kv[BBL_JSON_KEY_NAME]; p.from = kv[BBL_JSON_KEY_FROM];
  if (p.from!="system" && p.from!="User" && p.from!="user") return CLI_CONFIG_FILE_ERROR;
  if (!kv.count(BBL_JSON_KEY_TYPE)) return CLI_CONFIG_FILE_ERROR;                  // CLI would probe via PresetBundle
  p.type = kv[BBL_JSON_KEY_TYPE];
  if (auto* i = p.cfg.option<ConfigOptionString>("inherits"); i && !i->value.empty()) return CLI_CONFIG_FILE_ERROR; // must be flattened
  if (p.type=="filament" && kv.count(BBL_JSON_KEY_FILAMENT_ID)) p.filament_id = kv[BBL_JSON_KEY_FILAMENT_ID];
  p.cfg.normalize_fdm();
  return 0;
}

int build_config(P& m, P& pr, std::vector<P>& fil, DynamicPrintConfig& cfg /*=m_print_config, starts empty*/,
                 DynamicPrintConfig& extra, int& n_ext) {
  const int filament_count = int(fil.size()), load_filament_count = filament_count;
  m.cfg.set("printer_settings_id", m.name, true);                                  // OS:2303
  pr.cfg.set("print_settings_id", pr.name, true);                                  // OS:2340
  auto new_print_compatible_printers = pr.cfg.option<ConfigOptionStrings>("compatible_printers", true)->values;
  std::string diff_proc; if (auto* d=pr.cfg.option<ConfigOptionStrings>("different_settings_to_system"); d && !d->values.empty()) diff_proc=d->values[0];
  if (!is_compatible_with_printer(pr.cfg, Preset::TYPE_PRINT, m.cfg, m.name)) return CLI_PROCESS_NOT_COMPATIBLE; // -17
  auto& diff = cfg.option<ConfigOptionStrings>("different_settings_to_system", true)->values;   // OS:3125-3131
  auto& inh  = cfg.option<ConfigOptionStrings>("inherits_group", true)->values;
  inh.resize(filament_count+2); diff.resize(filament_count+2); if(!diff_proc.empty()) diff[0]=diff_proc;
  diff[filament_count+1]=""; inh[filament_count+1]="";                             // system printer
  load_default_gcodes_to_config(m.cfg, Preset::TYPE_PRINTER);                      // OS:3162
  if (int r = update_full_config_all(cfg, m.cfg)) return r;                        // OS:3174
  apply_cli_safe_limits(cfg, m.cfg.opt_string("printer_model"));                   // OS:3180-3243 (A1/A1 mini/A2L)
  n_ext = cfg.option<ConfigOptionFloats>("nozzle_diameter")->values.size();        // OS:3258
  auto& pcp = cfg.option<ConfigOptionStrings>("print_compatible_printers", true)->values;   // OS:3267
  diff[0]=diff_proc; inh[0]=""; pcp=new_print_compatible_printers;                 // OS:3290-3304
  if (int r = update_full_config_all(cfg, pr.cfg)) return r;                       // OS:3326
  std::vector<NozzleVolumeType> new_nvt(n_ext, nvtStandard), cur_nvt(1, nvtStandard); // OS:3340-3363
  // ---- OS:3434-3683 COPY VERBATIM. Substitutions: up_config_to_date=false, skip_modified_gcodes=false,
  //      load_filaments_config[i]=fil[i].cfg, load_filaments_index[i]=i+1, load_filaments_name[i]=fil[i].name,
  //      load_filaments_id[i]=fil[i].filament_id, load_filaments_inherit[i]="",
  //      cli_different_settings(...) -> std::string(), record_exit_reson/flush_and_exit -> return CLI_CONFIG_FILE_ERROR.
  //      Effects: filament_self_index=[1..N], filament_extruder_variant (default "Direct Drive Standard"),
  //      filament_settings_id[i]=name, filament_ids[i]=filament_id, every vector key set_at(src,i,0)
  //      (filament_options_with_variant via set_with_restore_2(...,true)), scalars dropped except
  //      compatible_printers_condition -> compatible_machine_expression_group[i+1] (size N+2),
  //      compatible_prints_condition -> compatible_process_expression_group[i] (size N).
  // ---- OS:3685-3862 COPY. Substitutions: selected_filament_colors_option=nullptr, disable_wipe_tower_after_mapping=false,
  //      current_extruder_count=1, current_nozzle_volume_type=cur_nvt, new_extruder_count=n_ext,
  //      GUI::BitmapCache::parse_color4 -> parse_color4, GUI::get_min_flush_volumes -> get_min_flush_volumes,
  //      m_extra_config -> extra. Runs when filament_colour exists AND flush_volumes_matrix is absent (typical).
  //      Sets flush_volumes_matrix (N*N*n_ext), flush_multiplier ([1]*n_ext), nozzle_flush_dataset.
  //      REQUIRED for >1 filament: GCode::append_full_config throws SlicingError("Flush volumes matrix do not match
  //      to the correct size!") (L/GCode.cpp:7208) otherwise. filament_is_support.size()!=filament_colour.size() -> -5.
  extra.set_key_value("has_filament_switcher", new ConfigOptionBool(false));       // OS:1374-1380
  extra.set_key_value("enable_filament_dynamic_map", new ConfigOptionBool(false));
  extra.normalize_fdm();
  cfg.apply(extra, true); cfg.normalize_fdm();                                     // OS:3999, 4057
  // OS:4059-4073 mixed-slot check -> CLI_MIXED_FILAMENT_INVALID (-69)
  cfg.option<ConfigOptionEnum<PrinterTechnology>>("printer_technology", true)->value = ptFFF; // OS:4075
  FullPrintConfig fff; fff.apply(cfg, true); cfg.apply(fff, true);                 // OS:4079-4086
  if (!cfg.validate(true).empty()) return CLI_INVALID_VALUES_IN_3MF;               // -18
  cfg.option<ConfigOptionBool>("enable_wrapping_detection", true);                 // OS:4112
  return 0;
}

int slice_once(DynamicPrintConfig& cfg, DynamicPrintConfig& extra, int n_ext, int filament_count,
               Model& model, const std::string& printer_name, SliceOut& out) {
  Print print;                                   // == PartPlateList::init `new Print()` (PP:4858). Use a FRESH Print per job.
  print.set_plate_origin(Vec3d::Zero());         // PP:3328
  print.set_plate_index(0);                      // PP:3121
  DynamicPrintConfig plate_cfg;                  // PP:195
  plate_cfg.option<ConfigOptionEnum<FilamentMapMode>>("filament_map_mode", true)->value = fmmAutoForFlush;
  Pointfs shape = make_counter_clockwise(cfg.opt<ConfigOptionPoints>("printable_area")->values);   // OS:4277
  std::vector<Pointfs> ex_areas; std::vector<double> ex_h;                          // OS:4187-4192
  if (auto* o = cfg.opt<ConfigOptionPointsGroups>("extruder_printable_area")) ex_areas = o->values;
  if (auto* o = cfg.opt<ConfigOptionFloatsNullable>("extruder_printable_height")) ex_h = o->values;
  BuildVolume bv(shape, cfg.opt_float("printable_height"), ex_areas, ex_h);        // OS:6331
  if (model.update_print_volume_state(bv) == 0) return CLI_NO_SUITABLE_OBJECTS;    // -50
  for (auto* o : model.objects) for (auto* i : o->instances) {
    i->use_loaded_id_for_label = true;                                             // OS:6343
    if (i->print_volume_state == ModelInstancePVS_Partly_Outside) return CLI_OBJECTS_PARTLY_INSIDE; } // -52
  DynamicPrintConfig pc = cfg; pc.apply(plate_cfg); pc.apply(extra, true);         // OS:6688-6690
  if (n_ext > 1) { /* OS:6697-6735: extruder_ams_count + print.set_extruder_filament_info */ }
  auto& fm = pc.option<ConfigOptionInts>("filament_map", true)->values;            // OS:6738-6744
  if ((int)fm.size() < filament_count) fm.resize(filament_count, 1);
  if (n_ext == 1) for (int k = 0; k < filament_count; ++k) fm[k] = 1;
  if (!pc.has("nozzle_volume_type")) pc.option<ConfigOptionEnumsGeneric>("nozzle_volume_type", true)->values.resize(n_ext, nvtStandard);
  print.apply(model, pc);                                                          // OS:6750
  print.set_no_check_flag(false);
  const std::string pm = pc.opt_string("printer_model");
  print.is_BBL_printer() = !pm.empty() ? pm.compare(0,9,"Bambu Lab")==0 : printer_name.compare(0,9,"Bambu Lab")==0;
  print.set_check_multi_filaments_compatibility(true);
  std::vector<StringObjectException> vw;
  StringObjectException err = print.validate(&vw);                                 // OS:6773
  if (!err.string.empty()) return map_validate(err);                               // §2.4
  if (print.empty()) return CLI_NO_SUITABLE_OBJECTS;
  print.set_status_callback(on_status);                                            // §2.1
  Model::setExtruderParams(cfg, filament_count);                                   // pre-plate cfg, as CLI (OS:6855)
  Model::setPrintSpeedTable(cfg, print.config());
  try {
    print.process();                                                               // OS:6878
    if (!print.get_conflict_string().empty()) return CLI_GCODE_PATH_CONFLICTS;     // -101
    // OS:6906-6939 warning policy (strict / critical overlap -> -100)
    GCodeProcessorResult res;
    print.export_gcode("/tmp/out/plate_1.gcode", &res, thumbs ? thumb_cb : nullptr); // OS:6957
    if (res.gcode_check_result.error_code) return CLI_GCODE_PATH_IN_UNPRINTABLE_AREA; // -102 (file still written)
    collect(print, res, out);                                                      // §3
  } catch (const CanceledException&) { return CANCELED; }
    catch (const std::bad_alloc&)   { return 2; }
    catch (const std::exception&)   { return CLI_SLICING_ERROR; }                  // -100, keep ex.what()
  return 0;
}
```

Also:
- Pass **no thumbnail callback** for byte parity; the CLI passes nullptr.
- To add thumbnails: before slicing, call `GCodeThumbnails::make_and_check_thumbnail_list(pc)` (L/GCode/Thumbnails.hpp:41) to get the sizes and formats, have JS render them, decode each PNG with `png::decode_colored_png` (L/PNGReadWrite), and return `ThumbnailData{w,h,RGBA}`. Rows must be **bottom-to-top** because `compress_thumbnail_*` flips (L/GCode/Thumbnails.cpp:55,109). The callback is synchronous, so render up front. Thumbnails are emitted only for non-BBL printers (L/GCode.cpp:3209-3237).

### 1.5 Optional GUI-parity wipe-tower clamp (keep OFF for CLI parity)
Do this after a first `print.apply`:
1. `ids = print.extruders(true)` (0-based).
2. `layer_h` = min over objects of (object config `layer_height` override, else global).
3. `max_h` = max over instances of `object->instance_convex_hull_bounding_box(i,true).size().z()`.
4. `fp = estimate_wipe_tower_footprint(pc, resolve_wipe_tower_type(pc), ids, layer_h, max_h)` (L/GCode/WipeTowerEstimate.hpp:26-45).
5. Copy PP:3050-3083: brim/outline margin, WIPE_TOWER_MARGIN=1, WIPE_TOWER_AUTO_MARGIN=15 (L/libslic3r.h:95,98), and the tol=5 clamp. Use `plate_width/depth = int(BoundingBoxf(printable_area).size())`.
6. `set_at` `wipe_tower_x/y[0]`, then apply again.

---
## 2. Status, progress, cancel, exceptions, exit codes

### 2.1 Status API (L/PrintBase.hpp:435-488, L/PrintBase.cpp:111-140)
`print.set_status_callback(std::function<void(const PrintBase::SlicingStatus&)>)`.

`SlicingStatus { int percent; std::string text; unsigned flags; ObjectID warning_object_id; int warning_step; SlicingNotificationType message_type; WarningLevel warning_level; }`
- **Progress:** `warning_step == -1`.
- **Warnings:** `warning_step != -1` with non-empty `text`. `set_done` sends an **empty-text** warning status to clear stale warnings (L/PrintBase.hpp:604); ignore those.
- `SlicingNotificationType` (L/PrintBase.hpp:59-67): Default 0, ReplaceInitEmptyLayers, NeedSupportOn, EmptyGcodeLayers, GcodeOverlap, **SlicingExclusionVolumeToolpath**.
- `WarningLevel`: NON_CRITICAL or CRITICAL.

Percent sequence emitted (not monotonic, so clamp with max()):

| % | Message | Where |
|---|---|---|
| 5 | "Slicing mesh" | PrintObjectSlice.cpp:829 |
| 15 | walls | PrintObject.cpp:482 |
| 25 | infill regions | PrintObject.cpp:585 |
| 35 | infill toolpath | PrintObject.cpp:818 |
| 40 | Z contouring | PrintObject.cpp:879,911 |
| 71 | Detect overhangs | PrintObject.cpp:942 |
| 50 | support necessity / support | PrintObject.cpp:972,1002 |
| 55-70 | tree support | TreeSupport.cpp:1728-1764,2747; TreeSupport3D.cpp:3575,3633 |
| 70 | "Generating skirt & brim" | Print.cpp:3120 |
| 75 | Optimizing toolpath | PrintObject.cpp:1035-1071 |
| 80 | "Generating G-code" | Print.cpp:3443 |
| 80 | "Generating G-code: layer N" per layer | GCode.cpp:4427,4530 |

Suggested UI mapping: load 0-3, `max(prev,p)`, 99 after export, 100 when done.

Warnings emitted:

| Type / level | Message | Where | When |
|---|---|---|---|
| NeedSupportOn, NON_CRITICAL | "It seems object %s has …" | PrintObject.cpp:989 | during process |
| CRITICAL | XY-compensation vs painting | PrintObjectSlice.cpp:1223,1239 | during process |
| EmptyGcodeLayers, CRITICAL | empty layers | GCode.cpp:2318 | export |
| CRITICAL | "Your print is very close to the priming regions…" | GCode.cpp:4098 | export |
| CRITICAL | invalid toolchange | GCodeProcessor.cpp:1436 | export |
| **SlicingExclusionVolumeToolpath, CRITICAL** | "A G-code move intersects an exclusion volume for extruder %1%. This may cause a printer collision." (+ unknown-Z line note) | GCode.cpp:2679-2695 | export; map to class `exclusion_volume_path` |

Also report `validate()` warnings (the `vw` vector, e.g. "%1% is too close to others…"), `GCodeProcessorResult::warnings` (level/msg/error_code/params), and `res.exclusion_volume_*` flags (GCodeProcessor.hpp:272-282).

### 2.2 Cancellation
- `print.cancel()` sets `m_cancel_status=CANCELED_BY_USER` (atomic).
- The worker polls `throw_if_canceled()` (PrintBase.hpp:544) in every step and in TBB loops, then **throws `CanceledException`** (PrintBase.hpp:40, `what()`="Background processing has been canceled"). GCode export polls too (GCode.cpp:4274, thumbnails).
- `restart()` resets; the constructor already calls it.
- `set_cancel_callback` is only used by `invalidate_*` inside apply to stop a running background process; the CLI never sets it (default no-op).
- **Wasm:** ST: terminate the worker. MT: export a pointer to a `std::atomic<int>` in shared wasm memory. The page sets it with `Atomics.store`. A 10-20 ms watcher `std::thread` and the status callback check it and call `print.cancel()`. The slicing thread itself is blocked and cannot receive postMessage.

### 2.3 Exceptions (L/Exception.hpp)
All derive from `Slic3r::Exception : std::runtime_error`:
- `CriticalException` → `RuntimeError` / `LogicError` (→ `InvalidArgument`, `OutOfRange`) / `IOError` / `ExportError`.
- `PlaceholderParserError : RuntimeError` (bad custom G-code macros).
- `SlicingError(msg, objectId)` (objectId = `PrintObject::id().id` → match against `print.objects()`).
- `SlicingErrors` (vector).
- Plus `CanceledException` (std::exception) and `std::bad_alloc`.

SlicingError texts in FFF code:
- GCode.cpp:2271 "One object has an empty first layer…"
- GCode.cpp:3332/3348 "No object can be printed. It may be too small."
- GCode.cpp:7208 "Flush volumes matrix do not match…"
- Print.cpp:1440 compacted tower clearance
- Print.cpp:3102 "The print is empty…"
- Print.cpp:3360 per-object skirts
- Print.cpp:5003 "Prime Tower is partially outside…"
- Print.cpp:5007 "Prime Tower is too close to an exclusion area…"
- PrintObject.cpp:997 "Levitating objects cannot be printed without supports."
- PrintObjectSlice.cpp:874 "No layers were detected…"

Export also throws `RuntimeError` on file open/rename (GCode.cpp:2584,2724) and `ExportError` on a bad `thumbnails` value (GCode.cpp:3230).

### 2.4 Validation (no exception: `StringObjectException validate(...)`, Print.cpp:1812)
`{string, object (ObjectBase*: ModelInstance*, ModelObject* or PrintObject* → dynamic_cast for the name), opt_key, type, is_warning, params}`.

Type is set only for:

| StringExceptionType | Set at | CLI code |
|---|---|---|
| STRING_EXCEPT_FILAMENTS_DIFFERENT_TEMP | Print.cpp:1850-1858 (`check_multi_filament_valid`) | **-62** |
| STRING_EXCEPT_OBJECT_COLLISION_IN_SEQ_PRINT | Print.cpp:1874 (`sequential_print_clearance_valid`, 756) | **-63** |
| STRING_EXCEPT_OBJECT_COLLISION_IN_LAYER_PRINT | Print.cpp:1883 `layered_print_cleareance_valid` (1446) and 1895 `compacted_wipe_tower_clearance_valid` (1290) | **-64** |
| STRING_EXCEPT_FILAMENT_NOT_MATCH_BED_TYPE | Print.cpp:2356-2362 "Plate %d: %s does not support filament %s" (Bambu Lab or `support_multi_bed_types` only) | **-61** |
| anything else | - | **-51** |

`-64` messages from `layered_print_cleareance_valid`:
- "<name> is too close to exclusion area, there may be collisions when printing." (legacy keep-out)
- "<name> intersects an exclusion volume for extruder %2%." / "…for every available extruder." (Bambu auto mapping)
- "<name> is too close to clumping detection area…"
- "Prime Tower is too close to an exclusion area, and collisions will be caused."
- "Prime Tower is partially outside the printable area…"

Other plain `-51` strings: Print.cpp:1834, 1863, 1869, 1919-1934, 1966-2079, 2111-2330 (listed in source).

The CLI mapping is at OS:6781-6803. `STRING_EXCEPT_LAYER_HEIGHT_EXCEEDS_LIMIT` is downgraded to a warning only with `--no-check`. With `no_check` false, `result.json` gets the generic `cli_errors` text (OS:131-180) and stderr gets `err.string`; the engine should return `err.string` untranslated.

### 2.5 Full CLI code map for this path

| Code | Condition | Where (OS) |
|---|---|---|
| -5 | bad or duplicate preset / type / update_full_config failure | 2287-2475, 3172, 3514-3664, 3760-3764 |
| -17 | process not compatible | 2961-2965 |
| -18 | `cfg.validate` | 4103-4110 |
| -69 | mixed filament invalid | 4066-4072, 6477-6484 |
| -50 | nothing inside / print empty | 6335-6339, 6812-6816 |
| -52 | partly outside | 6380-6385 |
| -59 | `--mtcpp` triangle limit | - |
| -66 / -68 | multi-extruder mapping | 6488-6680 |
| -51 / -61 / -62 / -63 / -64 | validate | §2.4 |
| -100 | exception in process/export | 7028-7034 |
| -100 | strict NON_CRITICAL warning | 6913-6923 |
| -100 | CRITICAL EmptyGcodeLayers/GcodeOverlap seen before export | 6926-6935 |
| -101 | conflict string | 6898-6902 |
| -102 | `gcode_check_result.error_code` | 6960-6970 |
| -14 | defined but never returned; bad_alloc ends up as -100. The spec's 2 = OOM is our own code. | - |

---
## 3. GCodeProcessorResult → UI arrays

**Structures** (L/GCode/GCodeProcessor.hpp):
- `EMoveType` (32-45): Noop, Retract, Unretract, Seam, Tool_change, Color_change, Pause_Print, Custom_GCode, Travel, Wipe, Extrude.
- `MoveVertex` (216-250): `gcode_id`, `type`, `extrusion_role` (ExtrusionRole u8), `extruder_id`, `cp_color_id`, `position` (Vec3f mm, **already includes plate offset + extruder offset**; start-G-code moves are drawn at first-layer height), `delta_extruder`, `feedrate` (mm/s), `actual_feedrate`, `width`, `height` (mm), `mm3_per_mm`, `travel_dist`, `fan_speed` (0-100 %), `temperature` (°C), `pressure_advance`, `acceleration`, `jerk`, `time[2]`, `layer_duration`, `layer_id`, `internal_only`, `object_label_id`, `print_z`.
  - `time[2]` = **per-move duration** in seconds, [0]=Normal, [1]=Stealth. It is not cumulative (GCodeProcessor.cpp:505).
  - `layer_duration`: **never set; it holds the layer counter**, so don't use it.
  - `layer_id` = 0-based `max(1,m_layer_id)-1`, nondecreasing in file order, also for by-object.
  - `internal_only` = arc tessellation (G2/G3 split, :5955-6100) and "actual speed" split points (:7686-7704, which get time=0 and are inserted before the original move).
  - `print_z` is set **only from `; Z_HEIGHT:`**, which Bambu printers alone emit (GCode.cpp:5692). It is 0 for the M1, so don't use it.
- `GCodeProcessorResult` (206-360): `moves`, `print_statistics` (`PrintEstimatedStatistics`, 67-138), `initial_layer_time`, `spiral_vase_mode`, `filament_densities`/`diameters`/`costs`, `extruder_colors`, `warnings`, `gcode_check_result`, `conflict_result`, `exclusion_volume_*`, `label_object_enabled`, `layer_filaments`, `filament_change_count_map`.
- `PrintEstimatedStatistics`:
  - `modes[Normal|Stealth]{time, prepare_time, custom_gcode_times}`
  - volumes in mm³: `model_volumes_per_extruder`, `wipe_tower_volumes_per_extruder`, `support_volumes_per_extruder`, `total_volumes_per_extruder`
  - `flush_per_filament`
  - `used_filaments_per_role` (ExtrusionRole → {meters, grams}, :2553-2570; good for the per-role parity check)
  - `total_filament_changes`, `total_extruder_changes`, `total_travel_distance`, `total_travel_moves`, `total_seam_gap_distance`, …

**Role table:** index = `ExtrusionRole` value 0..19 (L/ExtrusionEntity.hpp:20-43); name = `ExtrusionEntity::role_to_string(r)` (ExtrusionEntity.cpp:583-609). The names match `;TYPE:`:
`["Undefined","Inner wall","Outer wall","Overhang wall","Sparse infill","Internal solid infill","Top surface","Bottom surface","Ironing","Bridge","Internal Bridge","Gap infill","Skirt","Brim","Support","Support interface","Support transition","Prime tower","Custom","Multiple"]`.

**Builder** (same segmentation as libvgcode's convert, LibVGCodeWrapper.cpp:191-266):
```cpp
const size_t N = size_t(PrintEstimatedStatistics::ETimeMode::Normal);
double t = 0; uint32_t L = 0; for (auto& m : r.moves) L = std::max(L, m.layer_id + 1);
layerZ.assign(L, 0.f); std::vector<uint32_t> eCnt(L), tCnt(L);
for (size_t i = 0; i < r.moves.size(); ++i) {
  const auto& c = r.moves[i]; t += c.time[N];                 // cumulative time at the END of move i
  if (i == 0) continue; const auto& p = r.moves[i-1];
  if (c.type == EMoveType::Extrude) {
    if ((c.position - p.position).squaredNorm() == 0.f) continue;
    push6(ext.pos, p.position, c.position); ext.role.push_back(uint8_t(c.extrusion_role));
    ext.width.push_back(c.width); ext.height.push_back(c.height); ext.feed.push_back(c.feedrate);
    ext.fan.push_back(uint8_t(std::lround(std::clamp(c.fan_speed,0.f,100.f)))); ext.temp.push_back(uint16_t(std::lround(c.temperature)));
    ext.time.push_back(float(t)); ++eCnt[c.layer_id];
    if (c.extrusion_role != erCustom) layerZ[c.layer_id] = c.position.z();   // = libvgcode Layers::update (Layers.cpp:20-42)
  } else if (c.type == EMoveType::Travel) { push6(trv.pos, p.position, c.position); ++tCnt[c.layer_id]; }
}   // layerStart = exclusive prefix sums of eCnt/tCnt (L+1 entries); moves are already layer-ordered
```
Optionally merge collinear `internal_only` split points with identical attributes. They multiply segment count about 2-3× and memory is ~24 B/segment for positions alone. Arc points are also `internal_only`, so merge only collinear ones.

**Stats:**

| Field | Source |
|---|---|
| printTimeSeconds | `r.print_statistics.modes[N].time` |
| printTimeText | `get_time_dhms(that)` (Utils.hpp:558) = `print.print_statistics().estimated_normal_print_time`; the G-code line `; estimated printing time (normal mode) = …` uses the same value (GCodeProcessor.cpp:1156-1172) |
| firstLayerTimeText | For the G-code `; estimated first layer printing time (normal mode)` line, use `get_time_dhms(modes[N].prepare_time)`. **That value is the machine start-G-code time** (prepare_stage, :5236). The real first-layer time is `r.initial_layer_time` (:3836). |
| filamentMm | `print.print_statistics().total_used_filament` (filled by `DoExport::update_print_estimated_stats`, GCode.cpp:2396-2436, after export) |
| filamentCm3 | `total_extruded_volume/1000` |
| filamentG | `total_weight` |
| filamentCost | `total_cost` (includes `time_cost`) |
| layers | L |
| maxZ | max over `print.objects()` of `layers().back()->print_z` (header `; max_z_height:`, GCode.cpp:3171-3177) |

---
## 4. Exclusion-volume API (placement check without slicing)

**Types and functions** (L/PrintConfig.hpp:2323-2356; implementation PrintConfig.cpp:12950-13420):
```cpp
struct BedExcludeRegion { enum class Purpose { MaterialKeepout, CollisionVolume };
  Polygon polygon;  // SCALED (scale_()), bed coords, CCW
  double z_min{0}, z_max{0}; Purpose purpose{MaterialKeepout}; bool has_z_range{false};
  bool is_collision_volume() const; };
enum class BedExcludeVolumeMode { Shared=0, ToolheadOffset, PerExtruder };                 // PrintConfig.hpp:535
std::vector<std::vector<BedExcludeRegion>> get_bed_excluded_regions_by_extruder(const DynamicPrintConfig&); // :13252
std::vector<std::vector<BedExcludeRegion>> get_bed_excluded_regions_by_extruder(const PrintConfig&);        // :13285
std::vector<BedExcludeRegion> get_bed_excluded_regions(const DynamicPrintConfig&[, size_t extruder_id]);    // :13310-13330 (flattened)
int  bed_exclusion_extruder_for_filament(size_t filament_id0, const std::vector<int>& filament_map,
       FilamentMapMode, bool is_bambu, bool automatic_map_resolved, size_t extruder_count);            // :13228 (-1 = unresolved)
bool has_bed_exclude_volumes(const DynamicPrintConfig&);  BedExcludeVolumeMode active_bed_exclude_volume_mode(const DynamicPrintConfig&); // :13358,13376
bool is_valid_bed_exclude_volumes_string(const std::string&, double printable_height);
// L/Model.hpp:1369-1370, Model.cpp:3613-3727
bool ModelInstance::intersects_bed_exclude_region (const BedExcludeRegion&, indexed_triangle_set* intersection_mesh = nullptr) const;
bool ModelInstance::intersects_bed_exclude_regions(const std::vector<BedExcludeRegion>&, indexed_triangle_set* = nullptr) const;
ModelInstanceEPrintVolumeState ModelInstance::calc_print_volume_state(const BuildVolume&) const;     // Model.cpp:3833
Polygon ModelInstance::convex_hull_2d();                                                             // Model.cpp:3403
```

**Config keys read:**
- `printable_height` (clamps z)
- `bed_exclude_area` (legacy points, becomes a MaterialKeepout 0..h)
- `bed_exclude_volumes`: `"zmin..zmax;x0xy0,x1xy1,…|…"` split on `|` or newline (CollisionVolume). The M1 profile on this branch uses `bed_exclude_volumes` (resources/profiles/Muon3D/machine/fdm_common_muon_m1.json:137).
- `bed_exclude_volume_mode`, `extruder_bed_exclude_volumes`, `extruder_offset`, `nozzle_diameter`, `master_extruder_id`.

The machine preset alone (after `load_from_json`) is enough. Regions are bed-relative, so add the plate origin, which is 0.

**`intersects_bed_exclude_region` semantics:**
- The footprint is triangulated.
- Each model triangle (volume matrix × instance matrix) is z-prefiltered, bbox-tested, then clipped against the prism; a hit needs 3D area > 1e-8. Flush side contact does not count.
- If there is no surface hit, a ray test catches a prism fully enclosed by the solid.
- Without an output mesh it returns on the first hit. With `&its` it collects the clipped fragments in bed coordinates: `its.vertices` as Vec3f and `its.indices`. Those are the red pieces.
- `intersects_bed_exclude_regions` first rejects with the 2D convex hull.

**checkPlacement recipe** (mirrors `Print::validate` colliding_bed_exclusion Print.cpp:92-150, GLVolumeCollection 3DScene.cpp:1370-1470, PartPlate::check_outside PP:3439-3519):
```cpp
auto groups = get_bed_excluded_regions_by_extruder(cfg); auto mode = active_bed_exclude_volume_mode(cfg);
BuildVolume bv(make_counter_clockwise(printable_area), printable_height, ex_areas, ex_h);
for (ModelObject* o : model.objects) for (int k = 0; k < o->instances.size(); ++k) { ModelInstance* inst = o->instances[k];
  bool inside = inst->calc_print_volume_state(bv) == ModelInstancePVS_Inside;           // what the CLI uses for -50/-52
  Polygon hull = inst->convex_hull_2d(); BoundingBoxf3 bb = o->instance_convex_hull_bounding_box(k);
  std::set<size_t> exts = {0};  // PerExtruder/ToolheadOffset: {bed_exclusion_extruder_for_filament(f0, filament_map, mode_map, is_bbl, true, groups.size())} for each filament the object prints
  for (size_t e = 0; e < groups.size(); ++e) for (size_t r = 0; r < groups[e].size(); ++r) { const auto& R = groups[e][r];
    if (!R.is_collision_volume() && e > 0) continue;                  // legacy keep-out is shared: check once
    if (R.is_collision_volume() && (mode == BedExcludeVolumeMode::Shared ? e > 0 : !exts.count(e))) continue;
    if (intersection(Polygons{R.polygon}, Polygons{hull}).empty()) continue;           // PP:3485
    if (bb.max.z() < R.z_min || bb.min.z() > R.z_max) continue;                          // PP:3488
    indexed_triangle_set its; if (inst->intersects_bed_exclude_region(R, &its)) hits.push_back({e, r, soup(its)}); } }
```
**Performance:**
- Keep a **persistent Model** in the worker (one ModelObject+volume per UI object) and on each move only call `inst->set_transformation(...)`.
- `ModelVolume::get_convex_hull()` (qhull, the costly part) is cached per volume. The 2D hull is cached per transform; `convex_hull_2d` recomputes from that cache.
- Region lists can be cached per machine config.

The GUI never calls `PartPlate::check_outside` on the CLI path (`m_plater` is null there, PP:3464). Its logic is:
- `instance_convex_hull_bounding_box` inside `get_build_volume()` (PP:4148: shape bbox ± `BuildVolume::SceneEpsilon`, z 0..printable_height);
- sinking objects use `calc_print_volume_state`;
- the legacy area is checked through `intersects_bed_exclude_region`.

---
## 5. libslic3r build (src/libslic3r/CMakeLists.txt, 753 lines)

**Sources:**
- `lisbslic3r_sources` (lines 28-305) has **221 .cpp**: root 112, GCode 27, Fill 21, SLA 14, Arachne 13, Format 12, Geometry 8, Support 6, Feature 3, TextureToColor 2, Algorithm 2, Shape 1.
- Conditional: `CAD/*` 8 files if SLIC3R_CAD, `MacUtils.mm` + `Format/ModelIO.mm` on Apple, `OpenVDBUtils.cpp` if `TARGET OpenVDB::openvdb`.
- Separate `libslic3r_cgal` STATIC (lines 367-373): `CutSurface.cpp IntersectionPoints.cpp MeshBoolean.cpp TryCatchSignal.cpp Triangulation.cpp`.
- **Do not glob:** these files are on disk but not built: `ExPolygonCollection.cpp`, `JumpPointSearch.cpp`, `GCodeSender.cpp`, `TryCatchSignalSEH.cpp` (MSVC include).
- Parse the list out of the upstream CMakeLists instead. Strip `#` comments first, because `#GCodeSender.cpp` and `#SLA/SupportTreeIGL.cpp` would otherwise match:
  `file(READ …) → string(REGEX REPLACE "#[^\n]*" "" …) → string(REGEX MATCH "set\\(lisbslic3r_sources([^)]*)\\)" …) → string(REGEX MATCHALL "[A-Za-z0-9_/]+\\.cpp" …)`.

**Compile definitions:**
- PUBLIC `USE_TBB`, `TBB_USE_CAPTURED_EXCEPTION=0` (line 403); PRIVATE `SLIC3R_CONSOLE_LOG` (RelWithDebInfo + option); WIN32 PUBLIC `WIN32_LEAN_AND_MEAN= NOMINMAX`.
- Top level: C++17 (CMakeLists.txt:476), `NDEBUG`, `-fsigned-char` (:410), `-DSLIC3R_GUI` only with GUI (we: off), `BOOST_LOG_DYN_LINK` unless static (we: static, so don't define), `SLIC3R_PROFILE` → Shiny (off).
- `libslic3r_version.h` from `.in`: SLIC3R_APP_NAME "OrcaSlicer", SoftFever_VERSION "2.5.0-dev" (version.inc). **This appears in the G-code header line "; generated by OrcaSlicer 2.5.0-dev on …" (utils.cpp:1305)**, so it must match. Also `ORCA_CHECK_GCODE_PLACEHOLDERS 0`, `BBL_INTERNAL_TESTING 0`.
- libnest2d PUBLIC: `LIBNEST2D_THREADING_tbb LIBNEST2D_STATIC LIBNEST2D_OPTIMIZER_nlopt LIBNEST2D_GEOMETRIES_libslic3r`.
- CGAL: `-frounding-math` is moved to `libslic3r_cgal` only (378-391). For wasm add `CGAL_ALWAYS_ROUND_TO_NEAREST`, and probably `CGAL_DO_NOT_USE_MPZF` (32-bit target, as the MSVC-32 branch at :399).

**Include dirs:**
- PRIVATE `src/libslic3r`, `src/libslic3r/TextureToColor`; PUBLIC build dir; SYSTEM PUBLIC expat, OpenCASCADE.
- Global: `src/` (LIBDIR), `src/libigl`, build `src/dev-utils/platform`.
- `deps_src/` arrives through admesh's PUBLIC `..` (deps_src/admesh/CMakeLists.txt:14-18). It provides `imgui/imstb_truetype.h`, `Shiny/Shiny.h` (GCode.cpp:74, GCodeReader.cpp:14, PrintObject.cpp:48; empty macros without SLIC3R_PROFILE), `nanosvg/`, `nlohmann/`, `fast_float/`.
- CGAL headers are also needed by `Geometry/VoronoiUtilsCgal.cpp` in libslic3r itself, not just libslic3r_cgal.

**Link targets (lines 452-506):**
- PUBLIC: `Eigen3::Eigen admesh libigl libnest2d miniz opencv_world assimp::assimp` (+`SLVS::slvs` if CAD).
- PRIVATE: `${CMAKE_DL_LIBS} ${EXPAT_LIBRARIES} ${OCCT_LIBS}(26 TK*) boost_libs cereal::cereal clipper Clipper2 draco::draco glu-libtess JPEG::JPEG libslic3r_cgal mcut noise::noise PNG::PNG qhull qoi semver TBB::tbb TBB::tbbmalloc ZLIB::ZLIB OpenSSL::Crypto`; non-WIN32 `${FREETYPE_LIBRARIES}` + `fontconfig` (non-Apple); WIN32 `Psapi.lib bcrypt.lib`; `OpenVDB::openvdb` if target; `Shiny` if profile.
- `libslic3r_cgal` PRIVATE: `CGAL admesh libigl mcut boost_libs`.
- libnest2d PUBLIC: `NLopt::nlopt TBB::tbb Boost::boost`.
- **Keep for wasm:**
  - Eigen 5.0.1
  - admesh, libigl, libnest2d + NLopt 2.5.0
  - miniz
  - Boost 1.84 compiled: filesystem, nowide, log, log_setup, locale, regex, iostreams(zlib), thread, date_time, chrono, atomic, system; beast/uuid/property_tree/spirit are header-only
  - cereal 1.3.0
  - clipper, Clipper2, glu-libtess, qhull (deps_src), qoi, semver, expat (deps_src bundled), mcut
  - CGAL 5.6.3 (+GMP 6.2.1/MPFR 4.2.2)
  - libnoise 1.0 (noise::noise; FuzzySkin Perlin)
  - PNG 1.6.35 (or the emscripten port), ZLIB 1.2.13
  - **libjpeg-turbo 3.0.1** (GCode/Thumbnails.cpp:82 uses `JCS_EXT_RGBA`; Emscripten's `-sUSE_LIBJPEG` is IJG and fails)
  - TBB 2021.5 pinned, so ≥2021.11 or a serial shim
- **Drop:** opencv_world, assimp, OCCT, draco, OpenSSL (md5 shim), freetype/fontconfig, OpenVDB, SLVS, CMAKE_DL_LIBS. There are no CURL, boost::asio (GCodeSender only), Python or pybind11 users inside libslic3r. The plugin hook `Print::s_slicing_pipeline_hook_fn` stays null (Print.cpp:63, set only by src/slic3r/plugin).

**Desktop-dependency map (grep of `#include`):**

| Dependency | Files |
|---|---|
| OCCT | Format/STEP.cpp + **Format/STEP.hpp included by Model.hpp:26**, Format/svg.cpp, Shape/TextShape.cpp, CAD/* |
| OpenCV | ObjColorUtils.hpp/.cpp, TexturePainting.cpp, TextureToColor/TextureToColor.hpp/.cpp (+ColorUtils.cpp) |
| assimp | Format/AssimpImport.cpp |
| draco | Format/DRC.cpp |
| OpenVDB | OpenVDBUtils.cpp/.hpp, SLA/Hollowing.cpp, CSGMesh/VoxelizeCSGMesh.hpp (unused); TreeSupport3D.cpp only if `!TREE_SUPPORT_ORGANIC_NUDGE_NEW` (it is defined 1 at :44) |
| OpenSSL | **Utils.hpp:19 `<openssl/md5.h>` (included almost everywhere)**, utils.cpp:1717 (`bbl_calc_md5`), Format/bbs_3mf.cpp:6521 |
| boost::asio | GCodeSender.hpp/.cpp (not built) |
| SLVS | CAD/SketchSolver.cpp |
| Platform | **Platform.cpp:92 `static_assert(false,"Unknown platform detected")`** for anything not WIN32/Apple/`__linux__`/OpenBSD, which includes Emscripten |
| guarded Windows/Apple code | BlacklistedLibraryCheck.cpp, Emboss.cpp:825, utils.cpp:25/1373/1588 (fine) |

**Exclusion list** (remove from the parsed list):
- `Format/STEP.cpp`, `Format/svg.cpp`, `Shape/TextShape.cpp`, `Format/AssimpImport.cpp`, `Format/DRC.cpp`
- `ObjColorUtils.cpp`, `TexturePainting.cpp`, `TextureToColor/TextureToColor.cpp`, `TextureToColor/ColorUtils.cpp`
- `SLA/Hollowing.cpp`, `SLAPrint.cpp`, `SLAPrintSteps.cpp`, `Format/SL1.cpp`
- `Platform.cpp`, `pchheader.cpp`

Optional extras (compile time only; nothing in FFF references them): `SLA/{Clustering,ConcaveHull,Pad,RasterBase,RasterToPolygons,Rotfinder,SpatIndex,SupportPointGenerator,SupportTree,SupportTreeBuilder,SupportTreeBuildsteps}.cpp`. Keep `SLA/IndexedMesh.cpp` (used by ContourZ.cpp, FaceDetector.cpp, PrintObject.cpp, Layer.hpp) and `SLA/SupportTreeMesher.cpp` (`sla::cylinder` for DrainHole::to_mesh).

**Link libslic3r as a STATIC archive** (not an OBJECT library, no whole-archive). Unreferenced objects are then not pulled in, so stubs are needed only for symbols referenced from objects that do get pulled.

**Symbols referenced by kept code from excluded files (stubs required):**
- `Model.cpp`: `Step::Step(std::string, ImportStepProgressFn, StepIsUtf8Fn)`, `Step::~Step()`, `Step::load()`, `Step::mesh(Model*, bool&, bool, double, double)` (Model.cpp:196-247). Also provide `Step(fs::path,…)`, `get_triangle_num[_tbb]`, `clean_mesh_data`, `update_process`, `load_step`, `StepPreProcessor::{preprocess,isUtf8File,isUtf8,isGBK,preNum}` for safety.
- `Model.cpp`: `bool load_svg(const char*, Model*, std::string&)` (:398), `bool load_drc(const char*, Model*, const char*)` (:402), `bool load_assimp_textured_model(const std::string&, TexturedMesh&, std::string*)` (:387). Plus `load_drc(const char*, TriangleMesh*)` and the 3 `store_drc` overloads (unreferenced; stub anyway). AppConfig.cpp only uses the `DRC_BITS_DEFAULT_STR` macro.
- `AABBMesh.cpp:243`, `SLA/IndexedMesh.cpp`, 3mf/bbs_3mf: `sla::DrainHole::{operator==, is_inside, get_intersections, to_mesh}`. Copy SLA/Hollowing.cpp:151-279 verbatim. Add `InteriorDeleter::operator()`, `get_mesh(Interior&)` ×2, `generate_interior`→nullptr, `hollow_mesh` ×2 / `remove_inside_triangles` / `cut_drainholes` as no-ops, `get_distance`→+inf (define `struct Interior{indexed_triangle_set mesh;}` in the stub).
- `Platform`: `detect_platform, platform, platform_flavor, platform_os_type, platform_architecture, platform_to_string, platform_flavor_to_string`. Copy Platform.cpp with an `#elif defined(__EMSCRIPTEN__)` → Linux/GenericLinux branch.
- **No references at all** to: TexturePainting functions (texture_to_painting, decode_texture_to_pixels, …), ObjColorUtils (QuantKMeans/obj_color_deal_algo), TextShape (init_occt_fonts/load_text_shape), SLAPrint, SL1.

**Stub headers:**
- `wasm/stubs/include/openssl/md5.h`: `MD5_CTX`, `MD5_Init/MD5_Update/MD5_Final`, `MD5_DIGEST_LENGTH` (16), plus a small md5.c.
- `wasm/stubs/include/{XCAFDoc_DocumentTool.hxx, XCAFApp_Application.hxx, XCAFDoc_ShapeTool.hxx, Message_ProgressIndicator.hxx}`, all including one `occt_min.hxx` that provides:
  - `<iostream> <iomanip> <functional> <string> <vector> <memory>` (STEP.hpp's inline `Show` uses `std::setprecision` with no include of its own)
  - `typedef bool Standard_Boolean; typedef double Standard_Real;`
  - `namespace opencascade{template<class T>class handle{…};}` and `#define Handle(C) opencascade::handle<C>`
  - `class TopoDS_Shape{}; class TDocStd_Document{}; class XCAFDoc_ShapeTool{};`
  - `class XCAFApp_Application{public: static Handle(XCAFApp_Application) GetApplication(){return {};}};`
  - `class Message_ProgressScope{};`
  - `class Message_ProgressIndicator{public: virtual ~Message_ProgressIndicator()=default; virtual Standard_Boolean UserBreak(){return false;} virtual void Show(const Message_ProgressScope&, const Standard_Boolean){} Standard_Real GetPosition() const {return 0;}};`
  - Quote-includes from `Format/` fall through to `-I wasm/stubs/include`. (STEP.hpp itself cannot be shadowed: Model.hpp includes it with quotes relative to src/libslic3r, which is searched first; clang `-ivfsoverlay` is the alternative.)

**Other compile hazards to expect:**
- `utils.cpp` instantiates `boost::log` `asynchronous_sink` and `attrs::current_thread_id` (lines 190-191, 406-430). An ST Boost built with `BOOST_LOG_NO_THREADS` will not compile. Build Boost.Log with threads even for ST (the pthread stubs exist), or patch.
- `Thread.cpp` uses `pthread_setname_np` (non-Apple branch).
- `miniz_extension.cpp:54-58` uses `fopen64` only with `_LARGEFILE64_SOURCE`.

---
## 6. Runtime resource files read by kept libslic3r code (preload to MEMFS `/resources`, after `set_resources_dir`)

| File | Reader | Needed |
|---|---|---|
| `resources/info/nozzle_info.json` (6 KB dir) | `Print::get_hrc_by_nozzle_type` Print.cpp:3957-3988, called from GCodeProcessor.cpp:7819 during export | **Yes.** The built-in fallback lacks `"E3D": 55`. |
| `resources/info/nozzle_incompatibles.json` | `Print::get_incompatible_filaments_by_nozzle` Print.cpp:3990-4029 | GUI-only callers; preload per spec (small) |
| `resources/flush/flush_data_standard.txt`, `flush_data_dual_standard.txt`, `flush_data_dual_highflow.txt` (20 KB) | `GenericFlushPredictor` FlushVolPredictor.cpp:315-331, called from `FlushVolCalculator` FlushVolCalc.cpp:51 in our flush-matrix step (OS:3842) | **Yes** for ≥2 filaments (dataset = `nozzle_flush_dataset`) |
| `resources/filament_mixing/standard_color_recipes.json` (264 KB) | ColorDecomposeRecipe.cpp:139 (static load) | only for mixed filaments |
| `resources/profiles/BBL/cli_config.json` | CLI-only machine_limits clamp OS:3186-3243 | only for A1 / A1 mini / A2L parity; alternatively embed the table |

Not read by the slicing path: `resources/info/filament_info.json` (GUI), `profiles/**` (PresetBundle; only needed to flatten presets in tests), `fonts/` (TextShape), `images/`, `shapes/`, `handy_models/`, `profiles/BBL/machine_full|process_full` (3MF paths). Temp and output files go through MEMFS: `/tmp/out/plate_1.gcode.tmp` → `.postprocess` → rename (GCode.cpp:2575-2729).

