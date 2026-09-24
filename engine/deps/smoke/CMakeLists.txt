# Smoke test for an OrcaWasm dependency prefix ($ORCA_WASM_ROOT/prefix-<variant>). build-deps.sh (step
# "verify") configures it exactly the way the engine is configured:
#   emcmake cmake -C <prefix>/share/orcawasm/initial-cache.cmake -G Ninja -S engine/deps/smoke -B <build>
# and runs the result under node. It makes the same find_package() calls as Orca's CMakeLists (with Orca's
# own cmake/modules on the module path when ORCA_SRC is given), so a green run proves the find strategy,
# the flag consistency across every archive (wasm EH, wasm sjlj, pthreads), and the runtime behaviour the
# engine relies on. Nothing here is Orca code; it only links against the prefix.
cmake_minimum_required(VERSION 3.20)
project(orcawasm_smoke C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if (NOT ORCAWASM_VARIANT)
  message(FATAL_ERROR "Configure with -C <prefix>/share/orcawasm/initial-cache.cmake")
endif ()
set(ORCA_SRC "" CACHE PATH "OrcaSlicer source tree; its cmake/modules are used like Orca's CMakeLists does")
if (ORCA_SRC)
  list(APPEND CMAKE_MODULE_PATH "${ORCA_SRC}/cmake/modules")
endif ()

# --- The calls from Orca's CMakeLists.txt:777-942, src/CMakeLists.txt:12, src/libslic3r/CMakeLists.txt:568,625
# and deps_src/qhull/CMakeLists.txt:13, with the same package names and version floors.
set(SLIC3R_STATIC ON)
set(Boost_USE_STATIC_LIBS ON)
set(Boost_NO_SYSTEM_PATHS TRUE)
find_package(Boost 1.83.0 REQUIRED COMPONENTS
  system filesystem thread log log_setup locale regex chrono atomic date_time iostreams program_options nowide)
find_package(Eigen3 5.0.1 REQUIRED)
if (ORCAWASM_VARIANT STREQUAL "mt")
  set(TBB_STATIC 1)
  find_package(TBB REQUIRED)
endif ()
find_package(ZLIB REQUIRED)
find_package(PNG REQUIRED)
find_package(JPEG REQUIRED)
find_package(cereal REQUIRED)
find_package(NLopt 1.4 REQUIRED)
find_package(CGAL REQUIRED)              # CGAL_DISABLE_GMP comes from the initial cache
find_package(Qhull 7.2 REQUIRED)         # Orca: QUIET, falling back to its bundled copy; we want ours
if (ORCA_SRC)
  find_package(libnoise REQUIRED)        # Orca's Findlibnoise.cmake -> noise::noise
  set(_noise noise::noise)
else ()
  find_path(LIBNOISE_INCLUDE_DIR libnoise/noise.h REQUIRED)
  find_library(LIBNOISE_LIBRARY NAMES libnoise_static REQUIRED)  # file: liblibnoise_static.a
  add_library(noise_smoke INTERFACE)
  target_include_directories(noise_smoke INTERFACE ${LIBNOISE_INCLUDE_DIR})
  target_link_libraries(noise_smoke INTERFACE ${LIBNOISE_LIBRARY})
  set(_noise noise_smoke)
endif ()
if (TARGET cereal::cereal)
  set(_cereal cereal::cereal)
else ()
  set(_cereal cereal)
endif ()

message(STATUS "smoke: Boost ${Boost_VERSION} (${Boost_DIR}), Eigen3 ${Eigen3_VERSION}, CGAL ${CGAL_VERSION}, "
               "Qhull ${Qhull_VERSION}, JPEG ${JPEG_LIBRARIES}, PNG ${PNG_LIBRARIES}")

add_executable(smoke smoke.cpp)
target_compile_definitions(smoke PRIVATE
  SMOKE_VARIANT="${ORCAWASM_VARIANT}"
  $<$<STREQUAL:${ORCAWASM_VARIANT},mt>:SMOKE_MT>)
target_link_libraries(smoke PRIVATE
  Boost::boost Boost::filesystem Boost::thread Boost::log Boost::log_setup Boost::locale Boost::nowide
  Boost::iostreams Boost::program_options
  Eigen3::Eigen ${_cereal} NLopt::nlopt Qhull::qhullcpp Qhull::qhullstatic_r CGAL::CGAL ${_noise}
  JPEG::JPEG PNG::PNG ZLIB::ZLIB
  $<$<STREQUAL:${ORCAWASM_VARIANT},mt>:TBB::tbb>
  $<$<STREQUAL:${ORCAWASM_VARIANT},mt>:TBB::tbbmalloc>)
# --profiling-funcs keeps function names in stack traces; INITIAL_MEMORY must hold the 16 MB main stack
# (as the engine's will) plus static data.
target_link_options(smoke PRIVATE
  -sENVIRONMENT=node -sEXIT_RUNTIME=1 -sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=16MB
  -sASSERTIONS=1 --profiling-funcs)
if (ORCAWASM_VARIANT STREQUAL "mt")
  # TBB asks for ~hardwareConcurrency workers on first use; a pool smaller than its demand deadlocks a
  # blocked caller (Hiosdra/OrcaWasm's lesson). STRICT=2 turns pool exhaustion into an abort, not a hang.
  target_link_options(smoke PRIVATE
    "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency+4" -sPTHREAD_POOL_SIZE_STRICT=2
    -sDEFAULT_PTHREAD_STACK_SIZE=8MB)
endif ()
