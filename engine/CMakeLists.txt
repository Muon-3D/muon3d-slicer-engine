# Muon3D browser slicing engine: OrcaSlicer's libslic3r built out of tree with Emscripten, plus the
# embind bridge (engine/bridge), as engine-<variant>.mjs + engine-<variant>.wasm.
#
# Configure (Git Bash, emsdk environment; see scripts/build.sh, which does all of this):
#   emcmake cmake -C $ORCA_WASM_ROOT/prefix-<v>/share/orcawasm/initial-cache.cmake -G Ninja \
#       -S engine -B $ORCA_WASM_ROOT/build-<v> -DORCA_SRC=$ORCA_WASM_ROOT/orca -DENGINE_VARIANT=<st|mt>
#
# Nothing under ORCA_SRC is modified: its source list is read from Orca's own CMakeLists, desktop-only
# sources are left out or replaced by engine/stubs, missing headers come from engine/shims, and the few
# wasm32 defects in Orca's code are fixed in patched copies generated in the build tree. PATCHES.md
# lists all of it.
cmake_minimum_required(VERSION 3.24)
project(orca_engine LANGUAGES C CXX)

if (NOT EMSCRIPTEN)
    message(FATAL_ERROR "The engine is built with Emscripten: configure it through emcmake (see the header "
                        "of this file or scripts/build.sh).")
endif ()

set(ENGINE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
list(PREPEND CMAKE_MODULE_PATH "${ENGINE_DIR}/cmake")

# --- Options ---------------------------------------------------------------------------------------------------
set(ORCA_SRC "" CACHE PATH "OrcaSlicer source tree (e.g. $ORCA_WASM_ROOT/orca)")
set(ENGINE_VARIANT "st" CACHE STRING "Engine variant: st (single-threaded) or mt (pthreads + oneTBB)")
set_property(CACHE ENGINE_VARIANT PROPERTY STRINGS st mt)
option(ENGINE_PCH "Build libslic3r with Orca's pchheader.hpp precompiled and force-included, as Orca does (OFF is untested)" ON)
set(ENGINE_EXTRA_LINK_OPTIONS "" CACHE STRING "Additional emcc link options for the engine module (;-list)")

if (NOT EXISTS "${ORCA_SRC}/src/libslic3r/CMakeLists.txt")
    message(FATAL_ERROR "ORCA_SRC='${ORCA_SRC}' is not an OrcaSlicer source tree. Pass -DORCA_SRC=<path>.")
endif ()
if (NOT ENGINE_VARIANT MATCHES "^(st|mt)$")
    message(FATAL_ERROR "ENGINE_VARIANT must be st or mt, got '${ENGINE_VARIANT}'.")
endif ()
list(APPEND CMAKE_MODULE_PATH "${ORCA_SRC}/cmake/modules")   # Orca's FindNLopt, Findlibnoise, ...

# --- Toolchain contract with the dependency prefix ------------------------------------------------------------
# Every translation unit must be compiled with the flags the prefix was built with (wasm exceptions,
# wasm setjmp/longjmp, -pthread for mt, BOOST_HAS_PTHREADS for st), which the prefix's initial cache puts
# into CMAKE_C_FLAGS / CMAKE_CXX_FLAGS. Refuse to configure without them rather than fail at link time.
if (NOT DEFINED ORCAWASM_VARIANT)
    message(FATAL_ERROR "Configure with the dependency prefix's initial cache: "
                        "-C <prefix-${ENGINE_VARIANT}>/share/orcawasm/initial-cache.cmake")
endif ()
if (NOT ORCAWASM_VARIANT STREQUAL ENGINE_VARIANT)
    message(FATAL_ERROR "ENGINE_VARIANT=${ENGINE_VARIANT} but the initial cache is for the "
                        "'${ORCAWASM_VARIANT}' dependency prefix.")
endif ()
foreach (flag -fwasm-exceptions -sSUPPORT_LONGJMP=wasm)
    string(FIND " ${CMAKE_CXX_FLAGS} " " ${flag} " pos)
    if (pos EQUAL -1)
        message(FATAL_ERROR "CMAKE_CXX_FLAGS lacks ${flag}; configure with the prefix's initial cache.")
    endif ()
endforeach ()
string(FIND " ${CMAKE_CXX_FLAGS} " " -pthread " has_pthread)
if (ENGINE_VARIANT STREQUAL "mt" AND has_pthread EQUAL -1)
    message(FATAL_ERROR "The mt variant needs -pthread in CMAKE_CXX_FLAGS (from the mt initial cache).")
elseif (ENGINE_VARIANT STREQUAL "st" AND NOT has_pthread EQUAL -1)
    message(FATAL_ERROR "The st variant must not be compiled with -pthread.")
endif ()
if (ENGINE_VARIANT STREQUAL "st" AND NOT CMAKE_CXX_FLAGS MATCHES "-DBOOST_HAS_PTHREADS")
    # Without it <boost/thread.hpp> refuses to compile and Boost.Log's ABI would not match the prefix.
    message(FATAL_ERROR "The st variant needs -DBOOST_HAS_PTHREADS in CMAKE_CXX_FLAGS (from the st initial cache).")
endif ()

# --- Compile settings shared by everything (Orca's top-level CMakeLists, non-GUI Release build) --------------
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif ()

add_compile_options(-fsigned-char)
add_compile_definitions(
    "BBL_RELEASE_TO_PUBLIC=$<CONFIG:Release>"
    "$<$<CONFIG:Release>:WXINSPECTOR_DISABLE>"
    "$<IF:$<CONFIG:Debug>,DEBUG,NDEBUG>"
    # Orca defines these globally, so libslic3r sees them too.
    wxUSE_UNICODE _UNICODE UNICODE WXINTL_NO_GETTEXT_MACRO wxNO_UNSAFE_WXSTRING_CONV)
# Not defined, as in a build without GUI and CAD: SLIC3R_GUI, SLIC3R_CAD (only AppConfig's defaults
# look at it), SLIC3R_PROFILE. SLIC3R_DESKTOP_INTEGRATION is defined by Orca's desktop builds but
# nothing in libslic3r reads it.

# wasm-specific defines, normally part of CMAKE_CXX_FLAGS from the initial cache; added here if not.
#  CGAL_ALWAYS_ROUND_TO_NEAREST: wasm cannot switch FPU rounding modes (musl's fesetround is a no-op), so
#    CGAL's interval arithmetic would be silently unsound; this makes CGAL round with nextafter instead.
#  CGAL_DISABLE_GMP: exact arithmetic from Boost.Multiprecision, no GMP/MPFR in the browser.
if (NOT CMAKE_CXX_FLAGS MATCHES "-DCGAL_ALWAYS_ROUND_TO_NEAREST")
    add_compile_definitions(CGAL_ALWAYS_ROUND_TO_NEAREST)
endif ()
if (CGAL_DISABLE_GMP AND NOT CMAKE_CXX_FLAGS MATCHES "-DCGAL_DISABLE_GMP")
    add_compile_definitions(CGAL_DISABLE_GMP)
endif ()

# Warnings: Orca's -Wall with its list of disabled categories. Orca also passes -Werror; the engine does
# not, because a newer clang targeting wasm32 finds new things to warn about in code we must not edit.
add_compile_options(
    "$<$<COMPILE_LANGUAGE:CXX>:-Wall>"
    -Wno-reorder -Wno-sign-compare -Wno-misleading-indentation -Wno-switch -Wno-unused-function
    -Wno-unused-variable -Wno-unused-but-set-variable -Wno-unused-label -Wno-unused-local-typedefs
    -Wno-deprecated-declarations -Wno-ignored-attributes)

# Orca's global include directories: src/ (for <libslic3r/...>, bundled headers). src/libigl no longer
# exists in Orca; libigl comes from deps_src.
include_directories(SYSTEM "${ORCA_SRC}/src")

# Reproducible output: wherever the compiler records a path (__FILE__ in throw sites and logging), this
# machine's folders appear under fixed names, so the engine's bytes do not depend on where this repository,
# the Orca checkout or the build tree sit. The dependency prefix's flags (initial cache) map ORCA_WASM_ROOT
# and the Emscripten cache the same way; the longest matching prefix wins.
add_compile_options(
    "-ffile-prefix-map=${ENGINE_DIR}=/engine"
    "-ffile-prefix-map=${ORCA_SRC}=/orca"
    "-ffile-prefix-map=${CMAKE_BINARY_DIR}=/build")

# --- Targets ---------------------------------------------------------------------------------------------------
include(Dependencies)
include(Libslic3r)
include(Engine)
