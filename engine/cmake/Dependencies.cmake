# Third-party dependencies of libslic3r for the browser engine.
#
# Two sources, mirroring Orca's own build:
#  * the dependency prefix built by engine/deps/build-deps.sh (Boost, Eigen, CGAL, cereal, NLopt,
#    libnoise, Qhull, libjpeg-turbo, oneTBB for mt) plus Emscripten's zlib/libpng ports. The prefix's
#    initial-cache.cmake (cmake -C) makes plain find_package() calls find them;
#  * the libraries bundled in Orca's deps_src/, added from Orca's own CMakeLists files.
# Target names are Orca's, so its deps_src CMakeLists link unchanged.

# --- Helpers Orca's CMake code expects from its top-level CMakeLists ---------------------------------------
# deps_src/qhull calls slic3r_remap_configs() when SLIC3R_STATIC is set. Orca's version only matters for
# MSVC multi-config builds; here it has nothing to do.
function(slic3r_remap_configs targets from_Cfg to_Cfg)
endfunction()

# Orca's orcaslicer_silence_third_party_warnings(): bundled libraries compile with -w.
function(engine_silence_warnings)
    foreach (target IN LISTS ARGN)
        get_target_property(type ${target} TYPE)
        if (NOT type STREQUAL "INTERFACE_LIBRARY")
            target_compile_options(${target} PRIVATE -w)
        endif ()
    endforeach ()
endfunction()

# --- Threads (mcut asks for it) ------------------------------------------------------------------------------
find_package(Threads REQUIRED)

# --- Boost 1.84 -----------------------------------------------------------------------------------------------
# Same components and interface targets as Orca's top-level CMakeLists (boost_headeronly, boost_libs).
set(Boost_USE_STATIC_LIBS ON)
set(Boost_NO_SYSTEM_PATHS TRUE)
find_package(Boost 1.83.0 REQUIRED COMPONENTS
    system filesystem thread log log_setup locale regex chrono atomic date_time iostreams program_options nowide)
add_library(boost_headeronly INTERFACE)
add_library(boost_libs INTERFACE)
target_include_directories(boost_headeronly SYSTEM INTERFACE ${Boost_INCLUDE_DIRS})
target_link_libraries(boost_libs INTERFACE boost_headeronly ${Boost_LIBRARIES})
if (NOT TARGET Boost::boost)   # libnest2d links Boost::boost; BoostConfig normally provides it
    add_library(Boost::boost ALIAS boost_headeronly)
endif ()

# --- Header-only packages and small libraries from the prefix -------------------------------------------------
find_package(Eigen3 5.0.1 REQUIRED)

find_package(cereal REQUIRED)
if (NOT TARGET cereal::cereal)
    add_library(cereal::cereal ALIAS cereal)
endif ()

find_package(NLopt 1.4 REQUIRED)     # Orca's FindNLopt -> NLopt::nlopt (libnest2d)
find_package(libnoise REQUIRED)      # Orca's Findlibnoise -> noise::noise (Feature/FuzzySkin)

# CGAL: header-only. CGAL_DISABLE_GMP (set by the initial cache) selects Boost.Multiprecision for exact
# arithmetic; CGAL's config resets policies, so CMP0167 is passed as a default, as Orca does.
cmake_policy(PUSH)
set(CMAKE_POLICY_DEFAULT_CMP0167 NEW)
set(CGAL_DO_NOT_WARN_ABOUT_CMAKE_BUILD_TYPE ON CACHE BOOL "" FORCE)
find_package(CGAL REQUIRED)
unset(CMAKE_POLICY_DEFAULT_CMP0167)
cmake_policy(POP)

# --- Image libraries --------------------------------------------------------------------------------------------
# zlib and libpng are Emscripten ports (the initial cache points FindZLIB/FindPNG at the built archives).
# JPEG is libjpeg-turbo from the prefix: GCode/Thumbnails.cpp needs its JCS_EXT_RGBA, which the
# Emscripten libjpeg port (IJG 9f) lacks.
find_package(ZLIB REQUIRED)
find_package(PNG REQUIRED)
find_package(JPEG REQUIRED)

# --- oneTBB ------------------------------------------------------------------------------------------------------
if (ENGINE_VARIANT STREQUAL "mt")
    find_package(TBB 2021 CONFIG REQUIRED COMPONENTS tbb tbbmalloc)
else ()
    # Single-threaded: the serial header shim stands in for oneTBB (see shims/tbb-serial/README.md).
    add_library(engine_tbb_serial INTERFACE)
    target_include_directories(engine_tbb_serial SYSTEM INTERFACE "${ENGINE_DIR}/shims/tbb-serial")
    add_library(engine_tbbmalloc_serial INTERFACE)
    add_library(TBB::tbb ALIAS engine_tbb_serial)
    add_library(TBB::tbbmalloc ALIAS engine_tbbmalloc_serial)
endif ()

# --- Libraries bundled in Orca's deps_src/ ----------------------------------------------------------------------
# Only what libslic3r needs; Orca's deps_src/CMakeLists.txt also adds GUI-only ones (imgui, hidapi, ...).
# Shiny is header-only for us: GCode.cpp includes <Shiny/Shiny.h>, whose macros are empty unless
# SLIC3R_PROFILE is defined, and Orca links the Shiny library only in that case.
# mcut: no helper thread pool. The single-threaded engine cannot start threads, and the pool is not
# needed for slicing (mcut is only used by mesh booleans and cuts).
set(MCUT_BUILD_WITH_COMPUTE_HELPER_THREADPOOL OFF CACHE BOOL "" FORCE)
set(MCUT_BUILD_AS_SHARED_LIB OFF CACHE BOOL "" FORCE)
set(MCUT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(MCUT_BUILD_TUTORIALS OFF CACHE BOOL "" FORCE)
# deps_src/qhull uses Qhull 8.0.2 from the prefix (find_package(Qhull 7.2) accepts newer versions),
# linked statically as in Orca's SLIC3R_STATIC builds.
set(SLIC3R_STATIC ON)

set(ENGINE_DEPS_SRC_HEADER_ONLY agg ankerl earcut fast_float nanosvg nlohmann libigl)
set(ENGINE_DEPS_SRC_LIBRARIES admesh clipper clipper2 expat glu-libtess libnest2d mcut miniz qhull qoi semver)
foreach (dir IN LISTS ENGINE_DEPS_SRC_HEADER_ONLY ENGINE_DEPS_SRC_LIBRARIES)
    add_subdirectory("${ORCA_SRC}/deps_src/${dir}" "${CMAKE_BINARY_DIR}/deps_src/${dir}")
endforeach ()
engine_silence_warnings(admesh clipper Clipper2 expat glu-libtess libnest2d mcut miniz_static qoi semver)

# Orca's top-level CMakeLists falls back to the bundled expat the same way when no system expat exists.
set(EXPAT_INCLUDE_DIRS "${ORCA_SRC}/deps_src/expat")
set(EXPAT_LIBRARIES expat)
