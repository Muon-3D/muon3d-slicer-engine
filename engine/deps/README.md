# Third-party dependencies for the wasm engine

These scripts build every third-party library that OrcaSlicer's `libslic3r` needs, compiled with
Emscripten 6.0.10 into one install prefix per engine variant:

| Prefix | Variant | Contents |
|---|---|---|
| `$ORCA_WASM_ROOT/prefix-st` | single-threaded | Boost, Eigen, cereal, CGAL, NLopt, libnoise, Qhull, libjpeg-turbo |
| `$ORCA_WASM_ROOT/prefix-mt` | pthreads | the same, plus oneTBB 2021.12 (`libtbb.a`, `libtbbmalloc.a`) |

The prefixes, the sources and the build trees are large (about 250 MB per prefix, 170 MB of
archives), so they stay under `ORCA_WASM_ROOT` (default `~/OrcaWasm`). Only the scripts, the hashes
and the smoke test are kept in this folder.

```
fetch-deps.sh      downloads, hash-checks and extracts the sources into $ORCA_WASM_ROOT/deps-src
SHA256SUMS         expected sha256 of every archive (the single source of truth for fetch-deps.sh)
build-deps.sh      builds one prefix (VARIANT=st|mt): configure, build, install, hand-off file, smoke test
smoke/             a wasm program that links the whole prefix, run under node by the 'verify' step
```

## Reproducing

Git Bash on Windows, with Emscripten 6.0.10 in `$ORCA_WASM_ROOT/emsdk`, CMake 3.31 in
`C:/Program Files/CMake/bin` and Ninja on PATH. The script sets up the emsdk environment itself (it
puts the emsdk and the Program Files CMake ahead of Strawberry Perl's tools), so nothing needs sourcing
first.

```bash
bash engine/deps/fetch-deps.sh                                    # idempotent; about 170 MB of downloads
VARIANT=st JOBS=12 bash "$PWD/engine/deps/build-deps.sh"         # the two variants can run at the same time
VARIANT=mt JOBS=12 bash "$PWD/engine/deps/build-deps.sh"
VARIANT=mt bash "$PWD/engine/deps/build-deps.sh" tbb verify      # run selected steps only
```

- **Steps:** `ports boost eigen cereal cgal nlopt libnoise qhull jpeg tbb gmp mpfr handoff verify`.
- **Stamps:** each step is stamped with a hash of the emcc version, the common flags and that step's
  own recipe (the text of its `step_*` function), so a re-run rebuilds only what changed. Delete
  `prefix-<v>/.stamps` to force a rebuild.
- **Overridable paths:** `ORCA_WASM_ROOT`, `ORCA_SRC` (read only; used only by the optional GMP
  step), `JOBS` and `EM_CACHE`. `EM_CACHE` defaults to the emsdk's own cache, which must stay on the
  same drive as the build trees.
- **Run the script by an absolute path:** one concurrent launch that used a relative path failed with
  "No such file". The cause was not established; a file-sync lock is possible.

Each prefix records its own provenance in `prefix-<v>/share/orcawasm/`:
- `manifest.txt`: flags, versions, archive hashes and step timings
- `timings.log`: one line per step that did work

## Versions and hashes

| Package | Version | Pinned by | sha256 of the archive |
|---|---|---|---|
| Boost | 1.84.0 | Orca `deps/Boost/Boost.cmake` | `4d27e9efed0f6f152dc28db6430b9d3dfb40c0345da7342eaa5a987dde57bd95` |
| oneTBB (MT only) | 2021.12.0 | **bump** from Orca's 2021.5.0 (no wasm support) | `fe6ca052b5bdd2c6e0616b360c9b0dcbcc46e01bbd0aa8fd0517c17fc58931db` (GitHub tag archive, recorded here) |
| CGAL | 5.6.3 | Orca | `5d577acb4a9918ccb960491482da7a3838f8d363aff47e14d703f19fd84733d4` |
| Eigen | 5.0.1 | Orca | `0dbb1f9e3aaad66f352c03227d8c983f6f0b49e0b07e71a7300f4abcc01aee12` |
| cereal | 1.3.0 | Orca | `71642cb54658e98c8f07a0f0d08bf9766f1c3771496936f6014169d3726d9657` |
| NLopt | 2.5.0 | Orca | `c6dd7a5701fff8ad5ebb45a3dc8e757e61d52658de3918e38bab233e7fd3b4ae` |
| libnoise | 1.0 (SoftFever fork) | Orca | `96ffd6cc47898dd8147aab53d7d1b1911b507d9dbaecd5613ca2649468afd8b6` |
| Qhull | 8.0.2 | Orca (Linux/macOS pin; the reference Linux CLI uses it) | `a378e9a39e718e289102c20d45632f873bfdc58a7a5f924246ea4b176e185f1e` |
| libjpeg-turbo | 3.0.1 | Orca `deps/JPEG/JPEG.cmake` | `d6d99e693366bc03897677650e8b2dfa76b5d6c54e2c9e70c03f0af821b0a52f` |
| zlib | 1.3.2 | Emscripten port (sha512 in emsdk `tools/ports/zlib.py`) | not an archive of ours |
| libpng | 1.6.58 | Emscripten port, `libpng-legacysjlj` / `libpng-mt-legacysjlj` | not an archive of ours |
| GMP / MPFR (optional) | 6.2.1 / 4.2.2 | Orca | `eae9326b…4d7c` / `9ad62c7d…bb7b` (full values in `SHA256SUMS`) |

**Differences from Orca's pins:**
- oneTBB is bumped for wasm support.
- zlib and libpng are the Emscripten ports instead of Orca's 1.2.13 and 1.6.35.

Neither affects G-code: the CLI path writes no thumbnails, and PNG thumbnails are encoded by miniz
anyway. libpng is only used by PNGReadWrite and EdgeGrid's debug output.

## Patches and non-default options

**The one source patch** is in oneTBB, applied by `sed` to a copy in the build tree, so `deps-src`
stays pristine. The Emscripten block of `cmake/compilers/Clang.cmake` adds `-fexceptions`, which is
the JS exception model; the patch removes it, and `-fwasm-exceptions` comes from `CMAKE_CXX_FLAGS`.
The script aborts if the pattern stops matching.

**Options that differ from a plain build:**
- **Boost:**
  - `BOOST_CONTEXT_IMPLEMENTATION=ucontext`. Boost.Context cannot be excluded, because Boost.Log
    links asio, which links context. Its default fcontext would assemble i386 `.S` files.
  - `BOOST_LOCALE_ENABLE_POSIX=ON`. Boost enables POSIX only on Linux and Darwin; forcing it makes
    the default backend the same as in Orca's Linux build. ICU stays off, as in Orca.
  - `BOOST_LOG_WITHOUT_SYSLOG`/`_IPC`, iostreams without compression filters.
  - Excluded: contract, fiber, numpy, stacktrace, wave, test, cobalt, coroutine2, python, mpi,
    graph_parallel, property_map_parallel.
  - ST adds `-DBOOST_HAS_PTHREADS`, so that Boost.Thread and Boost.Log build with threads against
    Emscripten's pthread stubs. `BOOST_LOG_NO_THREADS` is not an option: Orca 2.5's `utils.cpp`
    includes `async_frontend.hpp`, which `#error`s under it.
- **libjpeg-turbo:** `WITH_JPEG8=ON` (as Orca's Linux build), `WITH_SIMD=OFF`, `WITH_TURBOJPEG=OFF`.
- **oneTBB:** tests off, `TBB_STRICT=OFF`, `TBBMALLOC_BUILD=ON`, `TBBMALLOC_PROXY_BUILD=OFF`, hwloc
  search off.
- **CGAL** is installed header-only. The GMP-free mode (Boost.Multiprecision exact types) is chosen
  by the consumer through `CGAL_DISABLE_GMP`, which the initial cache sets.

## Using a prefix (the engine build)

```bash
emcmake cmake -C $ORCA_WASM_ROOT/prefix-<v>/share/orcawasm/initial-cache.cmake -G Ninja -S <src> -B <build>
```

`initial-cache.cmake` carries the following:
- **The flags every library was compiled with.** The engine must use exactly these on every
  translation unit and on the final link, and append to them rather than replace them:
  - C: `-sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1 [-pthread]`
  - C++: `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1 [-pthread]`
    `[-DBOOST_HAS_PTHREADS]` (ST only) `-DCGAL_ALWAYS_ROUND_TO_NEAREST -DCGAL_DISABLE_GMP`. The two
    CGAL defines are engine-only; they are baked in so they cannot be forgotten.
  - Link: `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1 [-pthread]`
- **The find setup:**
  - `CMAKE_FIND_ROOT_PATH` and `CMAKE_PREFIX_PATH` are set to the prefix. Emscripten appends its
    sysroot and keeps the find modes at ONLY, so nothing leaks in from the host.
  - `CMP0167 NEW`, so `find_package(Boost)` uses BoostConfig.
  - `CGAL_DISABLE_GMP=ON`.
- **FindZLIB/FindPNG hints** that point at this variant's port archives in the Emscripten cache. The
  same ports are also available as `ORCAWASM_PORT_OPTIONS` (`-sUSE_ZLIB=1;-sUSE_LIBPNG=1`) for
  anyone who prefers interface targets.

**Never pass `-sUSE_LIBJPEG`.** JPEG must come from libjpeg-turbo in the prefix.
`GCode/Thumbnails.cpp:82` uses `JCS_EXT_RGBA`, which the IJG 9f port does not have.

The smoke test checks that Orca's own calls work unchanged against these prefixes, with Orca's
`cmake/modules` on the module path:

| Orca call | Result |
|---|---|
| `find_package(Boost 1.83.0 COMPONENTS system filesystem thread log log_setup locale regex chrono atomic date_time iostreams program_options nowide)` | found |
| `find_package(Eigen3 5.0.1)` | found |
| `find_package(TBB)` (MT) | found through Orca's FindTBB, which uses TBBConfig |
| `find_package(ZLIB)`, `find_package(PNG)` | found |
| `find_package(JPEG)` | `libjpeg.a`, version 80 |
| `find_package(cereal)` | target `cereal`, no namespace |
| `find_package(NLopt 1.4)` | found through Orca's FindNLopt |
| `find_package(libnoise)` | found through Orca's Findlibnoise, giving `noise::noise` |
| `find_package(CGAL)` | header-only |
| `find_package(Qhull 7.2)` | 8.0.2, giving `Qhull::qhullcpp` and `Qhull::qhullstatic_r` |

Link `Qhull::qhullstatic_r`, not `Qhull::qhull_r`, i.e. configure Orca's `deps_src/qhull` with
`SLIC3R_STATIC=ON`.

**Rebuilding the ports.** zlib and libpng live in the shared Emscripten cache, not in the prefix. After
`emcc --clear-cache`, re-run `build-deps.sh ports` (a few seconds).

## Prefix contents (static libraries)

| | ST | MT |
|---|---|---|
| Boost | atomic, chrono, container, context, coroutine, date_time, exception, filesystem, graph, iostreams, json, locale, log, log_setup, nowide, program_options, random, serialization, thread, timer, type_erasure, url, wserialization (all headers installed) | same |
| Others | `libnlopt.a`, `liblibnoise_static.a`, `libqhullcpp.a`, `libqhullstatic_r.a`, `libqhullstatic.a`, `libjpeg.a` | same, plus `libtbb.a`, `libtbbmalloc.a` |
| Header-only (with CMake packages) | Eigen 5.0.1, cereal 1.3.0, CGAL 5.6.3 | same |

**Other files in the prefixes:**
- `bin/`: `.js` stubs of qhull's and libjpeg-turbo's command-line tools. They are unused, but must
  stay, because `QhullTargets.cmake` checks that they exist.
- `share/man` and `share/doc`.

## Smoke test (`smoke/`), last run 2026-09-24, both variants: `SMOKE OK`

It is configured exactly like the engine (with `-C initial-cache.cmake`, using Orca's `find_package`
calls). It links the whole prefix and runs under node.

**Checks on both variants:**
- A C++ exception thrown inside `libboost_filesystem.a` is caught in the program (wasm EH across
  archives).
- wasm setjmp/longjmp works next to wasm EH.
- MEMFS works through Boost.Nowide and Boost.Filesystem.
- Boost.Log works, including the `async_frontend.hpp` include, and Boost.Thread primitives work.
- Boost.Locale:
  - the default backend is `posix`
  - `generate("")` works
  - `normalize` passes text through unchanged, which is what Orca's `normalize_utf8_nfc` gets
    without ICU
- Boost iostreams `array_source`, program_options, cpp_int and Polygon Voronoi work.
- CGAL exact predicates on the Epeck and Epick kernels, GMP-free: `CGAL_ALWAYS_ROUND_TO_NEAREST` and
  `CGAL_DISABLE_GMP` are asserted at compile time.
- Eigen, cereal, NLopt subplex, libnoise.
- Qhull: a cube hull, plus its error path (libqhull longjmp, then a C++ `QhullError`).
- zlib and libpng round trips, including libpng's longjmp error path.
- libjpeg-turbo:
  - compresses with `JCS_EXT_RGBA` and `jpeg_mem_dest`, exactly as `Thumbnails.cpp` does
  - decodes the result back
  - takes the error path through a longjmp from `error_exit`

**ST only:** `boost::thread` fails with `thread_resource_error`, as expected with the pthread stubs.

**MT only**, results on 24 cores:
- `max_concurrency` = 24.
- Orca's `name_tbb_thread_pool_threads_set_locale()` rendezvous (all tasks block until every one is
  running) finishes on 24 distinct threads, with a pool of `hardwareConcurrency+4` and
  `STRICT=2`.
- A `parallel_for` then runs on 24 threads.
- `global_control(thread_stack_size, 16 MiB)` reaches the workers: 16384 KiB measured with
  `emscripten_stack_get_base/end`.
- An exception thrown on a worker thread is rethrown in the caller.
- `scalable_allocator` works from many threads.
- `parallel_pipeline` and `task_arena(4)` work.
- `boost::thread` and `std::thread` work.
- `tbb::finalize` joins all workers.

## Timings

**Final clean build** (empty prefixes and build trees, sources already fetched). ST and MT built
concurrently with `JOBS=12` each on the 24-core machine, while other builds were running:

| Step | ST | MT |
|---|---|---|
| boost | 141 s | 138 s |
| cgal | 22 s | 22 s |
| nlopt | 30 s | 30 s |
| qhull | 23 s | 23 s |
| jpeg | 19 s | 19 s |
| tbb | – | 7 s |
| eigen, cereal, libnoise, ports | about 10 s together | about 10 s together |
| verify (smoke build + run) | 16 s | 17 s |
| **wall** | **261 s** | **267 s** |

- **Earlier clean build on a quieter machine:** 223 s and 233 s, with Boost at about 108 s.
- **Installing Boost's 14 764 headers on NTFS is roughly half of Boost's time.** A rebuild over an
  existing prefix, where the headers are already up to date, took 61 s.
- **Fetching:** re-verifying and extracting existing archives takes about 3 s. Downloading
  libjpeg-turbo took 3 s. A full first download was not timed here (it was done during the research
  phase).

## Toolchain facts the engine must know (found while testing)

1. **A longjmp runs C++ cleanups in the function that called setjmp**, with `-fwasm-exceptions` and
   wasm SjLj (reproduced with legacy EH and with exnref).
   - **Cause:** a longjmp is a wasm exception, and the cleanup pads of the function that called
     setjmp catch it. Objects that are live at the longjmp-able call are destroyed during the jump,
     then destroyed again when their scope ends. The smoke test hit a double free this way (found
     with ASan).
   - **Rule:** keep every `setjmp` in a function whose locals are trivially destructible, i.e. the
     C-style pattern libpng and libjpeg expect.
   - **Orca itself is safe:**
     - glu-libtess, libpng and libqhull only longjmp through C frames.
     - The `setjmp` function in `PNGReadWrite.cpp` holds raw pointers only.
     - `Qhull::runQhull` keeps a `std::string` live across its `setjmp`, but Orca's command
       (`"qhull Qt"`) fits in the small-string buffer, so the double destruction frees nothing.
   - **Watch for it:** the smoke test prints the behaviour
     (`longjmp runs cleanups of the setjmp caller: YES`), so a toolchain change shows up there.
2. **TBB workers start only while the main thread waits.**
   - **Cause:** under Emscripten, a new TBB worker needs the main thread to service its proxy queue
     before it runs. A main thread that is busy inside `parallel_for` just runs every task itself.
     Measured: 1 thread, even on 440 ms jobs, until the main thread had waited once; after that, all
     24 threads.
   - **Effect on Orca:** Orca's `Print::process` calls `name_tbb_thread_pool_threads_set_locale()`,
     whose rendezvous is exactly such a wait. It works with the pool at `hardwareConcurrency+4` and
     is how the workers come up (verified).
   - **What the engine should do:** call that function at init, or an equivalent warm-up, before
     measuring anything. The pool must cover `max_concurrency - 1` workers, otherwise that
     rendezvous deadlocks, which was OrcaWasm's bug.
3. **TBB 2021.12 gives wasm32 workers 2 MiB stacks.** A `tbb::global_control(thread_stack_size, …)`
   kept alive from engine init does reach them (verified: 16 MiB).
4. **No ucontext link risk:**
   - `libtbb.a` references no `getcontext`/`makecontext`/`swapcontext`.
   - `libboost_context.a` does, but only in objects nothing pulls in. Boost.Log carries
     `Boost::context`/`coroutine` into the link, and the smoke test links cleanly with them.
5. **oneTBB compiles with `-fPIC`** (its own Clang profile). wasm-ld links it into the static
   executable without trouble. I did not strip the flag, to keep the patch minimal.
6. **The MT link warns about `-pthread` + `ALLOW_MEMORY_GROWTH`.** The smoke test uses memory
   growth; the engine's memory policy is decided in the engine build.
7. **CMake pitfall, handled in the script:** an untyped `-DCMAKE_INSTALL_LIBDIR=lib` became
   `<cwd>/lib` in libjpeg-turbo, whose own GNUInstallDirs re-declares it as a PATH. The script now
   passes `:PATH`, and it runs sub-builds from the build tree.

## Where this differs from `research/deps-plan.md`

- **JPEG:** deps-plan planned the Emscripten libjpeg port (`-sUSE_LIBJPEG=1`). That port is IJG 9f,
  which lacks `JCS_EXT_RGBA` (checked in `Thumbnails.cpp`), so libjpeg-turbo 3.0.1 is built
  instead, as `research/headless-entry.md` said.
- **zlib and libpng:** these come through the stock find modules, via hints in the initial cache,
  rather than hand-made interface targets.
- **Boost.Locale:** deps-plan expected a "std/posix" backend. Boost's CMake actually disables POSIX
  on Emscripten, so it is forced on.
- **Flags:** the CGAL defines are now part of the initial cache's C++ flags, not a separate
  instruction.

## Not tested

- **GMP/MPFR (`WITH_GMP=1`):** the autotools path on Windows has never been run. It is not needed by
  default.
- **Browsers:** everything ran under node (emsdk's node 24.19). Neither browser (Chrome, Safari,
  Firefox) nor iPadOS has been tried with these libraries.
- **Other hardware:** TBB behaviour on machines with fewer cores, or with a pool smaller than
  `hardwareConcurrency+4`, has not been tried.
- **The engine link itself:** `-flto`, `-O3` and embind together with all of libslic3r have not
  been linked against these prefixes; that is the engine build's job.
