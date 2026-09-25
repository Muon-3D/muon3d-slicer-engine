# The engine module: the bridge (engine/bridge/*.cpp, embind API) linked with libslic3r into an ES6
# module factory engine-<variant>.mjs plus engine-<variant>.wasm.

# Runtime resource files libslic3r reads through resources_dir() on the slicing path, embedded into the
# module's MEMFS under /resources (the bridge calls set_resources_dir("/resources")). Globs pick up files
# Orca adds to those directories.
#  info/nozzle_info.json             Print::get_hrc_by_nozzle_type, from GCodeProcessor during export
#  info/nozzle_incompatibles.json    Print::get_incompatible_filaments_by_nozzle
#  flush/*.txt                       GenericFlushPredictor: flush volumes for 2+ filaments
#  filament_mixing/*.json            ColorDecomposeRecipe (mixed filaments)
#  profiles/BBL/cli_config.json      the CLI's machine-limit clamp for Bambu Lab A1 / A1 mini / A2L
set(ENGINE_RESOURCE_PATTERNS
    info/nozzle_info.json
    info/nozzle_incompatibles.json
    flush/*.txt
    filament_mixing/*.json
    profiles/BBL/cli_config.json
)
set(ENGINE_RESOURCE_FILES)
foreach (pattern IN LISTS ENGINE_RESOURCE_PATTERNS)
    file(GLOB matches CONFIGURE_DEPENDS RELATIVE "${ORCA_SRC}/resources" "${ORCA_SRC}/resources/${pattern}")
    if (NOT matches)
        message(FATAL_ERROR "No runtime resource matches ${ORCA_SRC}/resources/${pattern}.")
    endif ()
    list(APPEND ENGINE_RESOURCE_FILES ${matches})
endforeach ()

file(GLOB ENGINE_BRIDGE_SOURCES CONFIGURE_DEPENDS "${ENGINE_DIR}/bridge/*.cpp")
if (NOT ENGINE_BRIDGE_SOURCES)
    message(WARNING "No bridge sources in ${ENGINE_DIR}/bridge/*.cpp: the orca_engine target is not "
                    "defined. libslic3r can still be built (target libslic3r).")
    return()
endif ()

# The Orca commit the engine reports (version() -> the worker's `ready` message; the manifest carries
# the same value). scripts/build.sh passes -DORCA_COMMIT so both come from one place; otherwise ask git.
# "-dirty" marks uncommitted changes in the Orca sources that go into the engine. A value passed with -D
# applies to that configure run only (it is dropped from the cache), so a later plain configure, or an
# automatic re-run, asks git again instead of reusing a stale commit.
set(engine_orca_commit "${ORCA_COMMIT}")
unset(ORCA_COMMIT CACHE)
if (NOT engine_orca_commit)
    execute_process(COMMAND git -C "${ORCA_SRC}" rev-parse HEAD
                    OUTPUT_VARIABLE engine_orca_commit OUTPUT_STRIP_TRAILING_WHITESPACE
                    RESULT_VARIABLE git_result ERROR_QUIET)
    if (NOT git_result EQUAL 0 OR NOT engine_orca_commit)
        set(engine_orca_commit "unknown")
    else ()
        execute_process(COMMAND git -C "${ORCA_SRC}" status --porcelain --untracked-files=no
                                -- src deps_src resources version.inc
                        OUTPUT_VARIABLE git_dirty OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
        if (git_dirty)
            string(APPEND engine_orca_commit "-dirty")
        endif ()
    endif ()
endif ()
message(STATUS "Engine reports Orca commit ${engine_orca_commit}")

add_executable(orca_engine ${ENGINE_BRIDGE_SOURCES})
target_include_directories(orca_engine PRIVATE "${ENGINE_DIR}/bridge")
target_compile_definitions(orca_engine PRIVATE
    "ORCA_ENGINE_COMMIT=\"${engine_orca_commit}\""
    "ORCA_ENGINE_RESOURCES_DIR=\"/resources\"")   # where ENGINE_RESOURCE_FILES are embedded, below
# The bridge also uses Boost (filesystem) directly, not only through libslic3r.
target_link_libraries(orca_engine PRIVATE libslic3r boost_libs)
set_target_properties(orca_engine PROPERTIES
    OUTPUT_NAME "engine-${ENGINE_VARIANT}"
    SUFFIX ".mjs"                                      # Emscripten emits engine-<v>.mjs + engine-<v>.wasm
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out")

set(ENGINE_LINK_OPTIONS
    # ES6 module factory: `const Module = await createOrcaEngine({...})`.
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createOrcaEngine
    -sENVIRONMENT=web,worker,node                      # browsers' workers + Node for the test suite
    -lembind
    # FS stays reachable from JS (the worker reads the G-code file from MEMFS without another copy).
    # wasmMemory: the heap's WebAssembly.Memory, so JS can read its size (wasmMemory.buffer.byteLength,
    # valid up to the full 4 GB) after a job or a crash. Wasm memory never shrinks, and the mt build's
    # grows with every job (mimalloc keeps per-thread pages), so the worker's owner replaces an engine
    # whose heap has grown large.
    -sEXPORTED_RUNTIME_METHODS=FS,wasmMemory
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=256MB
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=16MB                                  # Orca gives its threads 16 MB stacks; deep recursion
                                                       # in Arachne / CGAL has no guard page in wasm
    --emit-symbol-map                                  # engine-<v>.mjs.symbols, to decode crash stacks
)
if (ENGINE_VARIANT STREQUAL "mt")
    list(APPEND ENGINE_LINK_OPTIONS
        -pthread
        # Per-thread heaps; dlmalloc has one global lock (a Benchy takes ~6 s with it, as long as st). The
        # price: the heap grows by ~100-150 MB per Benchy at 24 threads and never shrinks. Measured 2026-09-25,
        # none of mimalloc's own remedies bounds that: mi_collect(true) after each job, page_reclaim_on_free
        # = 1, page_full_retain = 0, arena_reserve 4 MiB or 256 MiB, arena_max_object_size 1 GiB. So the
        # client caps the threads and replaces an engine whose heap has grown (wasmMemory above).
        -sMALLOC=mimalloc
        # Workers are started up front: a thread blocked in slicing cannot wait for a new Worker to be
        # created, and TBB may use every hardware thread plus the callers. STRICT=2 makes running out an
        # error instead of a deadlock.
        "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency+4"
        -sPTHREAD_POOL_SIZE_STRICT=2
        -sDEFAULT_PTHREAD_STACK_SIZE=8MB
        # Growable memory with threads makes JS re-check the heap views on every access; where the
        # browser has resizable ArrayBuffers (detected at runtime) that overhead goes away.
        -sGROWABLE_ARRAYBUFFERS=1)
else ()
    list(APPEND ENGINE_LINK_OPTIONS -sMALLOC=dlmalloc)
endif ()

# The resources are embedded as Orca's git blobs hold them, with LF line ends, from copies in the build
# tree: a Windows checkout (core.autocrlf) has CRLF files, and the engine's bytes must not depend on how
# Orca was checked out. cmake/copy-lf.mjs runs on Emscripten's node (the cross-compiling emulator
# Emscripten.cmake sets) and rewrites a copy only when its content changes; editing a resource re-runs
# the configure step.
if (NOT CMAKE_CROSSCOMPILING_EMULATOR)
    message(FATAL_ERROR "No node (CMAKE_CROSSCOMPILING_EMULATOR): configure through emcmake.")
endif ()
execute_process(
    COMMAND ${CMAKE_CROSSCOMPILING_EMULATOR} "${ENGINE_DIR}/cmake/copy-lf.mjs"
            "${ORCA_SRC}/resources" "${CMAKE_BINARY_DIR}/resources" ${ENGINE_RESOURCE_FILES}
    RESULT_VARIABLE copy_result)
if (NOT copy_result EQUAL 0)
    message(FATAL_ERROR "Copying the engine's resources into ${CMAKE_BINARY_DIR}/resources failed.")
endif ()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ENGINE_DIR}/cmake/copy-lf.mjs")
set(resource_deps)
foreach (resource IN LISTS ENGINE_RESOURCE_FILES)
    set(copy "${CMAKE_BINARY_DIR}/resources/${resource}")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ORCA_SRC}/resources/${resource}")
    list(APPEND ENGINE_LINK_OPTIONS "SHELL:--embed-file \"${copy}@/resources/${resource}\"")
    list(APPEND resource_deps "${copy}")
endforeach ()

target_link_options(orca_engine PRIVATE ${ENGINE_LINK_OPTIONS} ${ENGINE_EXTRA_LINK_OPTIONS})
set_property(TARGET orca_engine APPEND PROPERTY LINK_DEPENDS ${resource_deps})
