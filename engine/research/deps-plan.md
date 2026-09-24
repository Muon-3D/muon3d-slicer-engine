# deps-plan

## Summary

I downloaded, hash-checked and extracted all 10 source archives into $ORCA_WASM_ROOT/deps-src/<name>-<version>/. Every archive Orca pins matched its hash; oneTBB 2021.12.0 is a version bump, so its hash is recorded rather than checked. I also wrote the build script $ORCA_WASM_ROOT/deps-src/build-deps.sh, which produces prefix-st and prefix-mt, plus a smoke-test project it uses. The script is only syntax-checked: nothing has been built or run under Emscripten. Emscripten 6.0.10 (clang 24) is fully installed and emcc runs from Git Bash.

Decisions:
- **Boost 1.84.0** (Orca's pin): build with Boost's own CMake, which is how Orca builds it too, instead of the b2 route in the spec. Boost.Context has to use its `ucontext` implementation. The single-threaded variant needs `-DBOOST_HAS_PTHREADS` everywhere, otherwise `<boost/thread.hpp>` refuses to compile.
- **oneTBB, multi-threaded variant only:** 2021.11.0 is the first release with WebAssembly support, but it fails with current Emscripten (it adds x86-only compiler flags). 2021.12.0 is the smallest bump that configures without patching. It still needs a one-line patch replacing `-fexceptions` with our exception flag.
- **oneTBB, single-threaded variant:** no library; a serial header shim stands in for it, as Hiosdra/OrcaWasm does.
- **CGAL 5.6.3 without GMP/MPFR:** Orca never includes gmp.h or mpfr.h. FFF slicing only uses CGAL for exact yes/no geometry tests (the Voronoi check behind Arachne walls), and those give the same answer with any exact number type. `CGAL_DISABLE_GMP=ON` makes CGAL use Boost.Multiprecision instead. `CGAL_ALWAYS_ROUND_TO_NEAREST` is required regardless.
- **Eigen 5.0.1 and cereal 1.3.0:** header-only installs.
- **NLopt 2.5.0, libnoise 1.0, Qhull 8.0.2:** small static builds. I picked Qhull 8.0.2 because the Linux CLI we compare against uses it.
- **zlib, libpng, libjpeg:** Emscripten's built-in versions, not Orca's pinned ones.
- **OpenSSL:** replaced by a small MD5 stub.
- **freetype, OCCT, OpenCV, assimp, draco, OpenVDB and the rest:** not needed.

Problems:
- nlopt's tarball contains a symlink that Windows tar can't create; I excluded that doc file.
- GMP/MPFR can't easily be built natively here (no m4, only Strawberry's native make). They're downloaded as a fallback only.
- Model.hpp includes Format/STEP.hpp, which includes OCCT headers. That has to be handled in the engine build stage (M2).

## Reusable

- $ORCA_WASM_ROOT/deps-src/fetch-deps.sh — idempotent fetch + SHA256 verify + extract of all 10 archives (bsdtar, strips top dir, nlopt symlink excluded); re-run safe
- $ORCA_WASM_ROOT/deps-src/build-deps.sh — build script outline (UNTESTED, not executed): VARIANT=st|mt, steps ports/boost/eigen/cereal/cgal/nlopt/libnoise/qhull/tbb/gmp/mpfr/handoff/verify, stamps keyed by emcc version+flags, writes prefix-<v>/share/orcawasm/initial-cache.cmake and manifest.txt
- $ORCA_WASM_ROOT/deps-src/smoke/CMakeLists.txt + smoke.cpp — smoke test making the engine's exact find_package calls; checks wasm EH across archives, sjlj, MEMFS, Boost.Log/Locale, CGAL GMP-free exact predicates, Eigen, cereal, NLopt subplex, Qhull (incl. its longjmp→exception error path), libnoise, ports, and MT TBB workers/tbbmalloc/exception propagation
- $ORCA_WASM_ROOT/deps-src/SHA256SUMS — hashes of every downloaded archive (oneTBB 2021.12.0 zip: fe6ca052b5bdd2c6e0616b360c9b0dcbcc46e01bbd0aa8fd0517c17fc58931db)
- $ORCA_WASM_ROOT/deps-src/<name>-<version>/ — extracted pristine sources: boost-1.84.0, oneTBB-2021.12.0, CGAL-5.6.3, eigen-5.0.1, cereal-1.3.0, nlopt-2.5.0, libnoise-1.0, qhull-8.0.2, gmp-6.2.1, mpfr-4.2.2
- $ORCA_WASM_ROOT/ref/OrcaWasm/wasm/shims/{tbb,oneapi} — starting point for the ST serial TBB shim (must keep TBB_VERSION_MAJOR 2021 in version.h)
- $ORCA_WASM_ROOT/ref/OrcaWasm/patches/onetbb/wasm-exceptions.cmake — same -fexceptions removal as the sed in build-deps.sh step_tbb
- $ORCA_WASM_ROOT/orca/cmake/modules/Findlibnoise.cmake, FindNLopt.cmake — Orca's find modules usable via CMAKE_MODULE_PATH for the engine
- Oneliner: oneTBB patch — sed -i 's/^\(  set(TBB_COMMON_COMPILE_FLAGS \${TBB_COMMON_COMPILE_FLAGS}\) -fexceptions)/  # orcawasm: -fexceptions removed/' cmake/compilers/Clang.cmake (verified on a copy)
- Engine flag set: C: -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1 [-pthread]; C++: -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1 [-pthread] [ST: -DBOOST_HAS_PTHREADS] -DCGAL_ALWAYS_ROUND_TO_NEAREST; link adds -sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1

## Risks

- The build script and smoke test are only syntax-checked; nothing has been built yet. The first real run may need edits, most likely in Boost's CMake under Emscripten (Boost.Context with ucontext, Boost.Locale backend detection, Boost.Log options).
- Boost.Context can't be excluded, because asio's CMake target links Boost::context and Boost::coroutine and Boost.Log depends on asio. If the ucontext build still fails, remove those two lines from a copy of libs/asio/CMakeLists.txt, or fall back to b2, which is untested on a Windows host.
- Single-threaded builds must define BOOST_HAS_PTHREADS in every C++ translation unit: Boost's build, libslic3r and the bridge. Leaving it out anywhere either breaks `<boost/thread.hpp>` or produces mismatched Boost.Log symbols at link time.
- CGAL_ALWAYS_ROUND_TO_NEAREST must be defined on every file that includes CGAL. Without it, CGAL's interval filters give wrong answers silently on wasm (no crash), and they fall back to exact arithmetic more often, which is slower.
- The GMP-free CGAL build (Boost.Multiprecision) matches GMP exactly for predicates, which is all FFF slicing uses. It is slower on the rare exact fallbacks. If parity tests ever implicate CGAL constructions (MeshBoolean or cut, not used when slicing), GMP/MPFR must be built; the native Windows recipe is fragile, so build them on Linux with the same emsdk and copy them in.
- oneTBB 2021.12 gives worker threads 2 MiB stacks on wasm32, versus 4 MiB native, and TBB sets that size itself, so DEFAULT_PTHREAD_STACK_SIZE doesn't reach its workers. The engine must set tbb::global_control(thread_stack_size, 8–16 MiB), or deep CGAL/Arachne recursion can silently corrupt memory (wasm has no guard pages).
- Multi-threaded: the Emscripten thread pool must cover TBB's full demand (PTHREAD_POOL_SIZE=navigator.hardwareConcurrency+4 with STRICT=2), or a blocked caller deadlocks. OrcaWasm also found that capping TBB with global_control deadlocks nested parallelism.
- oneTBB compiles in resumable tasks on Emscripten because `__linux__` isn't defined, and those need getcontext/makecontext/swapcontext, which Emscripten doesn't implement. OrcaWasm's evidence suggests they aren't linked, but if the final link reports them undefined, rebuild TBB with -D__TBB_RESUMABLE_TASKS_USE_THREADS=1.
- The Emscripten zlib/libpng/libjpeg versions differ from Orca's pins, so embedded thumbnail bytes may differ from the native CLI's; the G-code toolpaths are unaffected. If byte-identical thumbnails matter, build Orca's pinned zlib 1.2.13, libpng 1.6.35 and libjpeg-turbo 3.0.1 with emcmake.
- The wasm exception encoding is pinned to the legacy form (WASM_LEGACY_EXCEPTIONS=1) for older iPadOS. Changing it later means rebuilding every dependency and the Emscripten libpng variant.
- Machine environment traps: emcmake silently picks 'MinGW Makefiles' unless -G Ninja is given (Strawberry's mingw32-make is on PATH), and Strawberry's cmake 3.29, gcc and gmake are also on PATH. The script pins Ninja and puts Program Files CMake first on PATH.
- Not a dependency, but it blocks the engine build (M2): Model.hpp includes Format/STEP.hpp, which includes OCCT headers, and a quoted include can't be shadowed with -I. It needs stub OCCT headers or clang -ivfsoverlay to keep src/ untouched.
- mcut defaults to building with a std::thread pool (MCUT_BUILD_WITH_COMPUTE_HELPER_THREADPOOL=ON). Set it OFF in the engine CMake, at least for the single-threaded variant.
- oneTBB 2021.12.0 is fetched from a GitHub tag archive with no upstream pin. Its hash is recorded in SHA256SUMS, but GitHub archive bytes could in principle change; the build container should pin that hash.

## Details

# Dependency acquisition plan: libslic3r → Emscripten 6.0.10, native Windows

## 0. Verified toolchain facts (this machine)
- `$ORCA_WASM_ROOT/emsdk`: install complete. `emcc 6.0.10 (d6c521a7f0…)`, `clang 24.0.0git`. Launchers are `.exe` (`emcc.exe`, `emcmake.exe`, `embuilder.exe`), so Git Bash runs them directly. Bundled node is `emsdk/node/24.19.0_64bit/node.exe` (no `bin/` folder); bundled python is `emsdk/python/3.13.3_64bit`.
- Clang defaults: C17 (`__STDC_VERSION__ 201710L`) and C++17. Old C deps such as NLopt 2.5 and qhull won't hit C23 errors.
- Emscripten defaults (`src/settings.js`):
  - `WASM_LEGACY_EXCEPTIONS=true` (legacy wasm EH, supported by Safari 15.2+).
  - `SUPPORT_LONGJMP=true`, which resolves to `wasm` only when the TU is compiled with `-fwasm-exceptions` and to `emscripten` (JS) otherwise. So C files must pass `-sSUPPORT_LONGJMP=wasm` explicitly or they won't link with wasm-EH objects. This matters for qhull and libpng, which use setjmp.
- Mixing `-fwasm-exceptions` with a TU's own `-fno-exceptions` is accepted by emcc (`emcc.py` ~465-512). `-fexceptions` selects the JS exception model.
- Emscripten ports in 6.0.10:
  - zlib 1.3.2
  - libpng 1.6.58, with variants `libpng-legacysjlj` and `libpng-mt-legacysjlj`
  - libjpeg 9f
- `Emscripten.cmake:35-37` sets `CMAKE_SYSTEM_PROCESSOR=x86`. This is what breaks x86-feature detection in TBB 2021.11 and Boost.Context.
- **Gotcha:** `emcmake` without `-G` picks "MinGW Makefiles" because Strawberry's `mingw32-make` is on PATH. Always pass `-G Ninja`. Strawberry also puts cmake 3.29 on PATH (after Program Files cmake 3.31) plus gcc 13.2 and `gmake` 4.4.1. There is no make or m4 in Git Bash.

## 1. Dependency inventory (orca `deps/CMakeLists.txt` + `deps/*/*.cmake`, cross-checked with `src/libslic3r/CMakeLists.txt:681-712`, `CMakeLists.txt:777-942`, and the actual `#include`s)

| Dep | Orca pin | URL / SHA256 (from Orca's cmake file) | Needed for FFF libslic3r? | Plan |
|---|---|---|---|---|
| Boost | 1.84.0 | github boostorg/boost releases `boost-1.84.0.tar.gz` / 4d27e9ef…bd95 | **yes** | Boost CMake via emcmake |
| oneTBB | 2021.5.0 | oneTBB v2021.5.0.zip / 83ea786c…bb47 | **yes** (see note 1) | MT: **2021.12.0**; ST: serial header shim |
| CGAL | 5.6.3 | CGAL-5.6.3.zip / 5d577acb…33d4 | **yes** (see note 2) | header install, `CGAL_DISABLE_GMP=ON` |
| GMP | 6.2.1 | SoftFever mirror gmp-6.2.1.tar.bz2 / eae9326b…d7c | only through CGAL | skip (fallback downloaded) |
| MPFR | 4.2.2 | ftp.gnu.org mpfr-4.2.2.tar.bz2 / 9ad62c7d…bb7b | only through CGAL | skip (fallback downloaded) |
| Eigen | 5.0.1 | gitlab eigen-5.0.1.zip / 0dbb1f9e…ee12 | **yes** (`find_package(Eigen3 5.0.1)`) | header install |
| cereal | 1.3.0 | v1.3.0.zip / 71642cb5…9657 | **yes** (Config.cpp and others) | header install |
| NLopt | 2.5.0 | v2.5.0.tar.gz / c6dd7a57…b3d4ae | **yes** (libnest2d/Arrange) | static, C only |
| libnoise | 1.0 | SoftFever/Orca-deps-libnoise 1.0.zip / 96ffd6cc…d6 | **yes** (FuzzySkin.cpp:16) | static |
| Qhull | 8.0.2 | qhull v8.0.2.zip / a378e9a3…1e | **yes** (see note 3) | static |
| EXPAT | in-tree `deps/EXPAT/expat` + `deps_src/expat` | – | yes (3MF/AMF reading) | compile `deps_src/expat` in the engine CMake |
| ZLIB | 1.2.13 | madler v1.2.13.zip / c2856951…f4ff | yes (PNG) | port `-sUSE_ZLIB=1` (1.3.2) |
| PNG | 1.6.35 | glennrp v1.6.35.zip / 3d22d46c…247f | yes (PNGReadWrite, EdgeGrid, thumbnails) | port `-sUSE_LIBPNG=1` (1.6.58, legacysjlj) |
| JPEG | libjpeg-turbo 3.0.1 | 3.0.1.zip / d6d99e69…52f | yes (GCode/Thumbnails.cpp JPG) | port `-sUSE_LIBJPEG=1` (IJG 9f) |
| OpenSSL | 1.1.1w | OpenSSL_1_1_1w.tar.gz / 2130E8C2…8C41 | MD5 only (see note 4) | stub header |
| FREETYPE | 2.12.1 | efe71fd4… | **no** (0 includes; only linked for OCCT) | drop |
| OCCT | V7_6_0 | 28334f0e… | no (see note 5) | drop + header stubs |
| OpenCV | 4.6.0 | 1ec1cba6… | no (ObjColorUtils, TexturePainting, TextureToColor) | drop |
| assimp, Draco 1.5.7 | – / 27b72ba2… | no (Format/AssimpImport.cpp, Format/DRC.cpp) | drop |
| OpenVDB (tamasmeszaros a68fd58d / f353e7b9…), Blosc (dcb48bf4…), OpenEXR 2.5.5 (0307a3d7…) | | no (see note 6) | drop |
| CURL 7.75.0, wxWidgets 3.3.2, GLEW, GLFW 3.4, OpenCSG 1.4.2, FFMPEG n7.0.3, python3, wxInspector, SLVS (CAD), NanoSVG dep | | no | drop |

Notes on the table:
1. oneTBB: libslic3r uses parallel_for, parallel_pipeline (GCode.cpp) and scalable_allocator (Point.hpp:61).
2. CGAL: Geometry/Voronoi.cpp:172 → VoronoiUtilsCgal (Epeck predicates), plus MeshBoolean.
3. Qhull: TriangleMesh.cpp:14 includes `libqhullcpp`.
4. OpenSSL: MD5_CTX/Init/Update/Final in utils.cpp:1714 (`bbl_calc_md5`) and Format/bbs_3mf.cpp.
5. OCCT: Model.hpp:26 → Format/STEP.hpp:3-8 includes XCAFDoc/Message headers.
6. OpenVDB: the TreeSupport3D.cpp use is compiled out by `TREE_SUPPORT_ORGANIC_NUDGE_NEW`; the rest is SLA/CSG only.

**Bundled `deps_src/`, compiled inside the engine CMake:**
- admesh, clipper, Clipper2 1.5.2, glu-libtess, miniz, qoi, semver, expat
- libnest2d, which links NLopt::nlopt, TBB::tbb and Boost (`deps_src/libnest2d/CMakeLists.txt`)
- mcut: set `MCUT_BUILD_WITH_COMPUTE_HELPER_THREADPOOL=OFF`; it defaults to ON and spawns std::threads
- header-only: libigl, agg (SupportMaterial.cpp:21 `SUPPORT_USE_AGG_RASTERIZER`, so normal supports need it), nanosvg, nlohmann, fast_float, earcut, ankerl (Arachne)
- Shiny: header only; GCode.cpp includes `<Shiny/Shiny.h>` unconditionally

Not needed from deps_src: hidapi, imgui (only Emboss.cpp), imguizmo, md4c, mdns, minilzo, stb_dxt, hints, pybind11.

**GMP question answered:** there is no `#include <gmp.h>` or `<mpfr.h>` in `src/libslic3r` or `deps_src`. The only grep hits are comments in Thread.hpp:52 and OpenVDBUtils.hpp:7.
- CGAL 5.6.3 `Installation/internal/enable_third_party_libraries.h`: `CGAL_DISABLE_GMP` → `CGAL_NO_GMP` → undefines `CGAL_USE_GMP`/`CGAL_USE_MPFR`.
- `Number_types/internal/Exact_type_selector.h:143-150`: with Boost > 1.79 and `CGAL_USE_BOOST_MP` (auto-defined on non-MSVC, `boost_mp.h:35`), the backend is `BOOST_BACKEND`: Rational = `cpp_rational`, Integer = `cpp_int`, Ring_for_float = `CGAL::cpp_float`.
- CMake: `CGAL_SetupCGALDependencies.cmake:36,85` skips GMP and adds `CGAL_DISABLE_GMP=1` to `CGAL::CGAL`.
- The FFF path only evaluates exact *predicates*, so results are identical to GMP.
- **Independently required:** `CGAL_ALWAYS_ROUND_TO_NEAREST`. On wasm, CGAL's `FPU.h:462-475` falls back to `fesetround`, which cannot switch to upward rounding, so interval filters would be silently unsound. `FPU.h:349` uses `nextafter` instead.

## 2. Build recipes (all in `$ORCA_WASM_ROOT/deps-src/build-deps.sh`; `VARIANT=st|mt`)

Common to every step:
```
emcmake cmake -S <src> -B $ORCA_WASM_ROOT/build-deps/<v>/<dep> -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=$ORCA_WASM_ROOT/prefix-<v> -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_FIND_ROOT_PATH=$ORCA_WASM_ROOT/prefix-<v> -DCMAKE_PREFIX_PATH=$ORCA_WASM_ROOT/prefix-<v> \
  -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CXXFLAGS" -DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS" \
  -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5
```

Flags:
- Shared pieces: `SJLJ="-sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1"`, `EH="-fwasm-exceptions $SJLJ"`.
- ST: `CFLAGS=$SJLJ`, `CXXFLAGS="$EH -DBOOST_HAS_PTHREADS"`, `LDFLAGS=$EH`.
- MT: add `-pthread` to all three and do **not** define `BOOST_HAS_PTHREADS`; with `-pthread`, Boost detects pthreads itself.
- No `-flto` and no `-msimd128` in deps. wasm-ld can still LTO-link the engine against plain objects. Keeping SIMD off keeps Eigen scalar for parity.

**Why `BOOST_HAS_PTHREADS` in ST (verified):**
- Without `-pthread`, the sysroot's `unistd.h:261-265` sets `_POSIX_THREADS -1` (no `_REENTRANT`).
- Boost's `posix_features.hpp:45` then doesn't define `BOOST_HAS_PTHREADS`, and `suffix.hpp:281-285` undefines `BOOST_HAS_THREADS`.
- `boost/thread/detail/platform.hpp` then hits `#error "Sorry, no boost threads are available"` and `requires_threads.hpp` errors too. libslic3r includes `<boost/thread.hpp>` (Thread.hpp:7, PrintConfig.cpp:26).
- With the define, Boost.Thread and Boost.Log build against Emscripten's pthread stubs, and Boost.Log uses the same v2s_mt_posix ABI in ST and MT. That avoids OrcaWasm's v2s_st/`BOOST_LOG_NO_THREADS` mismatch.

**Per dependency:**
- **ports** (first): `embuilder build zlib libjpeg libpng-legacysjlj` (ST) or `… libpng-mt-legacysjlj` (MT). The engine gets them with `-sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1` on compile and link, via INTERFACE targets for ZLIB::ZLIB, PNG::PNG and JPEG::JPEG. Don't `find_library` them.
- **Boost 1.84.0 (Boost CMake):** `-DBOOST_EXCLUDE_LIBRARIES="contract;fiber;numpy;stacktrace;wave;test;cobalt;coroutine2;python;mpi;graph_parallel;property_map_parallel" -DBOOST_ENABLE_MPI=OFF -DBOOST_ENABLE_PYTHON=OFF -DBUILD_TESTING=OFF -DBOOST_INSTALL_LAYOUT=system -DBOOST_CONTEXT_IMPLEMENTATION=ucontext -DBOOST_LOCALE_ENABLE_ICU=OFF -DBOOST_IOSTREAMS_ENABLE_{ZLIB,BZIP2,LZMA,ZSTD}=OFF -DBOOST_LOG_WITHOUT_SYSLOG=ON -DBOOST_LOG_WITHOUT_IPC=ON`
  - context can't be excluded: `libs/asio/CMakeLists.txt:20-21` links `Boost::context` and `Boost::coroutine`, and Boost.Log depends on asio. Its fcontext default would assemble i386 .S files. ucontext compiles against the sysroot's `ucontext.h`; its functions are never linked.
  - Fallback: drop the two lines from a copy of the asio CMakeLists and exclude context and coroutine.
  - Components produced match Orca's `find_package(Boost … system filesystem thread log log_setup locale regex chrono atomic date_time iostreams program_options nowide)`. regex, system and date_time are header-only in 1.84. Only filesystem, thread, log, locale, nowide, chrono and atomic carry code libslic3r uses.
  - The locale backend is std/posix plus musl iconv, so `boost::locale::normalize` (utils.cpp:1256) is a no-op, as in Orca's ICU-off Linux build.
  - b2 `toolset=emscripten` is the documented fallback: `bootstrap.bat gcc` with Strawberry, then `b2 headers`. Untested on a Windows host.
- **Eigen 5.0.1:** `-DBUILD_TESTING=OFF -DEIGEN_BUILD_TESTING=OFF -DEIGEN_BUILD_BLAS=OFF -DEIGEN_BUILD_LAPACK=OFF -DEIGEN_BUILD_DOC=OFF -DEIGEN_BUILD_DEMOS=OFF -DEIGEN_BUILD_PKGCONFIG=OFF -DEIGEN_BUILD_CMAKE_PACKAGE=ON`. Installs `share/eigen3/cmake/Eigen3Config.cmake`.
- **cereal 1.3.0:** `-DJUST_INSTALL_CEREAL=ON -DSKIP_PERFORMANCE_COMPARISON=ON -DBUILD_TESTS=OFF -DBUILD_SANDBOX=OFF -DBUILD_DOC=OFF`. Installs `share/cmake/cereal/cereal-config.cmake` with target `cereal`, no namespace.
- **CGAL 5.6.3:** plain install to `lib/cmake/CGAL`. The consumer sets `CGAL_DISABLE_GMP=ON` and `add_compile_definitions(CGAL_ALWAYS_ROUND_TO_NEAREST)`. Optional for ST: `CGAL_HAS_NO_THREADS`.
- **NLopt 2.5.0:** `--target nlopt` (test/ is always added by 2.5.0) with `-DNLOPT_CXX=OFF -DNLOPT_PYTHON=OFF -DNLOPT_OCTAVE=OFF -DNLOPT_MATLAB=OFF -DNLOPT_GUILE=OFF -DNLOPT_SWIG=OFF -DNLOPT_LINK_PYTHON=OFF`. `BUILD_SHARED_LIBS` defaults to ON in NLopt, so the OFF matters. Produces `NLopt::nlopt`.
- **libnoise 1.0:** defaults. Produces `lib/liblibnoise_static.a` and `include/libnoise/**`; found through Orca's `cmake/modules/Findlibnoise.cmake`.
- **Qhull 8.0.2:** `-DBUILD_STATIC_LIBS=ON -DBUILD_SHARED_LIBS=OFF -DLINK_APPS_SHARED=OFF -DINCLUDE_INSTALL_DIR=include`.
  - Exports `Qhull::qhullcpp` and `Qhull::qhullstatic_r` with `AnyNewerVersion`, so `deps_src/qhull`'s `find_package(Qhull 7.2)` uses it.
  - qhull's C code uses setjmp, hence `SJLJ` in the C flags.
- **oneTBB 2021.12.0 (MT only):** copy the source, then patch `cmake/compilers/Clang.cmake:17` (dry-run tested):
  `sed -i 's/^\(  set(TBB_COMMON_COMPILE_FLAGS \${TBB_COMMON_COMPILE_FLAGS}\) -fexceptions)/  # orcawasm: …/'`
  Then configure with `-DTBB_TEST=OFF -DTBB_EXAMPLES=OFF -DTBB_STRICT=OFF -DTBB_ENABLE_IPO=OFF -DTBB4PY_BUILD=OFF -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON -DTBBMALLOC_BUILD=ON -DTBBMALLOC_PROXY_BUILD=OFF`. Produces `lib/cmake/TBB/TBBConfig.cmake`.
  - Why 2021.12.0: 2021.11.0 (upstream 7cee225 "Enable WASM", #1006) adds `-mrtm/-mwaitpkg` whenever CMAKE_SYSTEM_PROCESSOR matches x86, which fails on current Emscripten. 8259efb (#1271) fixed that and first shipped in 2021.12.0 (2024-04-12), together with `EMSCRIPTEN_WITHOUT_PTHREAD` (fabaaa6).
  - v2022.0.0 adds d6ade50 (`emscripten_stack_get_base`), which also makes the Emscripten default worker stack 64 KiB. Avoid that version, or set the stack size explicitly.
- **ST TBB:** header shim covering exactly what libslic3r includes:
  - `tbb/` headers: parallel_for (35×), blocked_range, spin_mutex, parallel_reduce, task_group, version (must define `TBB_VERSION_MAJOR 2021`, otherwise GCode.cpp:66 and utils.cpp:88 take the legacy `pipeline.h` / `task_scheduler_init.h` branch), task_arena, parallel_for_each, concurrent_vector, concurrent_unordered_set/map, blocked_range2d, tbb.h, parallel_pipeline (make_filter, flow_control, filter_mode), global_control
  - `oneapi/tbb/` headers: scalable_allocator (map to std::allocator), spin_mutex, parallel_for, concurrent_vector, blocked_range
  - Starting point: `$ORCA_WASM_ROOT/ref/OrcaWasm/wasm/shims/{tbb,oneapi}`.
- **GMP 6.2.1 + MPFR 4.2.2, optional (`WITH_GMP=1`):**
  - Copy the source, apply `orca/deps/GMP/0001-GMP_GCC15.patch`, then `M4=m4 CC_FOR_BUILD=/c/Strawberry/c/bin/gcc.exe emconfigure sh ./configure --host=wasm32-unknown-emscripten --build=x86_64-w64-mingw32 --disable-assembly --disable-shared --enable-static --disable-cxx`, then `emmake gmake`. `M4=m4` works because GMP's configure accepts a preset `$M4` (configure:25569) and `--disable-assembly` never runs m4.
  - MPFR uses its shipped configure without autoreconf.
  - Untested and fragile: a native gmake running an MSYS sh. The reliable fallback is to build the two `.a` files in any Linux box with emsdk 6.0.10 and copy them into the prefix.

**Order:** ports → boost → eigen → cereal → cgal → nlopt → libnoise → qhull → tbb (MT) → [gmp → mpfr] → handoff → verify. The script keeps per-step stamps keyed by the emcc version and a flags hash. ST and MT are independent and can build in parallel.

## 3. find_package / CMAKE_FIND_ROOT_PATH (verified empirically)
`Emscripten.cmake:227` appends its sysroot to `CMAKE_FIND_ROOT_PATH`, and `:255-262` sets INCLUDE, LIBRARY and PACKAGE modes to ONLY. I ran a configure-only test (`project(t NONE)`) in a scratch folder:
- `-DCMAKE_PREFIX_PATH=<pfx>` alone found nothing (the path is re-rooted under the sysroot).
- `-DCMAKE_FIND_ROOT_PATH=<pfx>`, with or without `CMAKE_PREFIX_PATH`, found the package config, `find_path` and `find_library`, and stays in ONLY mode, so no host library can leak in.

Use both, and **don't** use OrcaWasm's `MODE_*=BOTH` override. The script writes `prefix-<v>/share/orcawasm/initial-cache.cmake` with the flags, root path, prefix path, `CMAKE_POLICY_DEFAULT_CMP0167 NEW` and `CGAL_DISABLE_GMP`. The engine configures with `emcmake cmake -C <that file> -G Ninja …` so its flags are identical to the deps'.

## 4. Engine flags to carry forward
- Compile and link: `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1`, plus `-pthread` for MT.
- Defines: `-DCGAL_ALWAYS_ROUND_TO_NEAREST`, plus `-DBOOST_HAS_PTHREADS` for ST.
- Link: `-sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1`.
- MT:
  - The pool must cover TBB's demand: `-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency+4 -sPTHREAD_POOL_SIZE_STRICT=2`. OrcaWasm found both a smaller pool and capping TBB with global_control deadlock.
  - TBB 2021.12 gives its workers **2 MiB** stacks on wasm32 (`src/tbb/misc.h:61`, versus 4 MiB native) and passes that size to pthread explicitly, so `DEFAULT_PTHREAD_STACK_SIZE` does not apply to them. Keep a `tbb::global_control(thread_stack_size, 8–16 MiB)` alive from engine init; Arachne/CGAL recursion runs inside TBB tasks.

## 5. Downloaded paths (all extracted with the top folder stripped; `.extracted` marker holds URL and hash)
Archives are in `$ORCA_WASM_ROOT/deps-src/_archives/`; the hash list is `$ORCA_WASM_ROOT/deps-src/SHA256SUMS`.

| Path | Hash |
|---|---|
| $ORCA_WASM_ROOT/deps-src/boost-1.84.0 | 4d27e9ef… ✔ pinned |
| $ORCA_WASM_ROOT/deps-src/oneTBB-2021.12.0 | fe6ca052b5bdd2c6e0616b360c9b0dcbcc46e01bbd0aa8fd0517c17fc58931db (recorded, not pinned upstream) |
| $ORCA_WASM_ROOT/deps-src/CGAL-5.6.3 | 5d577acb… ✔ |
| $ORCA_WASM_ROOT/deps-src/eigen-5.0.1 | 0dbb1f9e… ✔ |
| $ORCA_WASM_ROOT/deps-src/cereal-1.3.0 | 71642cb5… ✔ |
| $ORCA_WASM_ROOT/deps-src/nlopt-2.5.0 | c6dd7a57… ✔ |
| $ORCA_WASM_ROOT/deps-src/libnoise-1.0 | 96ffd6cc… ✔ |
| $ORCA_WASM_ROOT/deps-src/qhull-8.0.2 | a378e9a3… ✔ |
| $ORCA_WASM_ROOT/deps-src/gmp-6.2.1 | eae9326b… ✔ (downloaded from ftp.gnu.org; same file as Orca's SoftFever mirror) |
| $ORCA_WASM_ROOT/deps-src/mpfr-4.2.2 | 9ad62c7d… ✔ |

zlib, libpng and libjpeg are fetched by `embuilder`, pinned by sha512 in `emsdk/upstream/emscripten/tools/ports/*.py`.

## 6. Problems hit
- `nlopt-v2.5.0.tar.gz` contains a symlink (`doc/nlopt-mkdocs-theme/img/favicon.png`) that Windows bsdtar can't create. `fetch-deps.sh` now excludes that file; it is documentation only.
- GMP/MPFR need autotools, m4 and make, none of which exist in Git Bash. That is why the GMP-free CGAL route is the default.
- Parity notes:
  - The ports differ from Orca's pins (zlib 1.3.2 vs 1.2.13, libpng 1.6.58 vs 1.6.35, IJG jpeg 9f vs libjpeg-turbo 3.0.1). Only thumbnail bytes inside the G-code can differ.
  - Qhull 8.0.2 matches the Linux reference; Orca's MSVC build uses the bundled 7.2.

## 7. Found in passing, relevant to M2
- `Model.hpp:26` → `Format/STEP.hpp` includes OCCT headers. A quoted include resolves next to the including file first, so `-I` can't shadow it. Options: stub OCCT headers, or clang `-ivfsoverlay` (which keeps `src/` untouched).
- `TreeSupport3D.cpp` doesn't need OpenVDB (`#ifndef TREE_SUPPORT_ORGANIC_NUDGE_NEW`).
- `Format/bbs_3mf.cpp:9008` starts a `boost::thread` during 3MF export. It can't work in ST; relevant to M5.
- The OpenSSL stub only needs `MD5_CTX`, `MD5_Init`, `MD5_Update` and `MD5_Final`. Wrap `boost/uuid/detail/md5.hpp` (Boost 1.84 API, as AppConfig.cpp:687-700 does).
- `$ORCA_WASM_ROOT` is not a git repo yet. Commit `deps-src/*.sh`, `smoke/` and `SHA256SUMS`, and gitignore `deps-src/*/` and `_archives/`.
