// Smoke test for an OrcaWasm dependency prefix (see CMakeLists.txt). Exit code 0 + "SMOKE OK" = pass.
// Every check exercises something the engine relies on; the comments say what and why.
#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <csetjmp>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <boost/filesystem.hpp>
#include <boost/iostreams/device/array.hpp>
#include <boost/iostreams/stream.hpp>
#include <boost/locale.hpp>
#include <boost/log/sinks/async_frontend.hpp>   // Orca 2.5 utils.cpp includes it; #errors without threads
#include <boost/log/trivial.hpp>
#include <boost/multiprecision/cpp_int.hpp>
#include <boost/nowide/fstream.hpp>
#include <boost/polygon/voronoi.hpp>
#include <boost/program_options.hpp>
#include <boost/thread.hpp>

#include <CGAL/Exact_predicates_exact_constructions_kernel.h>
#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <Eigen/Geometry>
#include <cereal/archives/binary.hpp>
#include <cereal/types/vector.hpp>
#include <libnoise/noise.h>
#include <libqhullcpp/Qhull.h>
#include <nlopt.h>
#include <png.h>
#include <zlib.h>
#include <jpeglib.h>   // libjpeg-turbo from the prefix, not the IJG port
#include <jerror.h>

#include <emscripten/stack.h>

#ifdef SMOKE_MT
#include <oneapi/tbb/global_control.h>
#include <oneapi/tbb/scalable_allocator.h>
#include <tbb/blocked_range.h>
#include <tbb/parallel_for.h>
#include <tbb/parallel_pipeline.h>
#include <tbb/task_arena.h>
#endif

#ifndef CGAL_ALWAYS_ROUND_TO_NEAREST
#error "CGAL_ALWAYS_ROUND_TO_NEAREST must reach every TU (initial-cache.cmake CMAKE_CXX_FLAGS)"
#endif
#if !defined(CGAL_DISABLE_GMP) || defined(CGAL_USE_GMP)
#error "CGAL must be GMP-free (CGAL_DISABLE_GMP from initial-cache.cmake)"
#endif
#ifndef JCS_EXTENSIONS
#error "jpeglib.h is not libjpeg-turbo's (GCode/Thumbnails.cpp needs JCS_EXT_RGBA)"
#endif

static int g_failures = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); ++g_failures; } } while (0)
#define STEP(name) std::printf("-- %s\n", name)

static double parabola(unsigned, const double *x, double *, void *) { return (x[0] - 3.) * (x[0] - 3.) + 1.; }

// --- setjmp/longjmp helpers ---------------------------------------------------------------------------
// TOOLCHAIN PROPERTY (Emscripten 6.0.10, -fwasm-exceptions + -sSUPPORT_LONGJMP=wasm, legacy EH and exnref
// alike): a longjmp is a wasm exception, and the C++ cleanup pads of the function that called setjmp catch
// it too. Destructors of objects that are live at the longjmp-able call therefore RUN during the longjmp,
// and then again when the scope ends (double destruction, e.g. a double free). Keep every setjmp in a
// function whose locals are trivially destructible -- the C-style pattern libpng/libjpeg expect anyway.
// longjmp_cleanup_probe() below reports the behaviour so a toolchain change gets noticed.
static std::jmp_buf g_jb;
[[noreturn]] __attribute__((noinline)) static void jump_back() { std::longjmp(g_jb, 7); }
__attribute__((noinline)) static int sjlj_roundtrip()
{
    int r = setjmp(g_jb);
    if (r == 0) jump_back();
    return r;
}

static int g_probe_dtors = 0;
struct ProbeDtor { ~ProbeDtor() { ++g_probe_dtors; } };
// Returns how often a destructor of an object live at the longjmp-able call has run by the time setjmp
// returns the second time (0 natively; 1 with wasm SjLj + wasm EH).
static std::jmp_buf g_probe_jb;
[[noreturn]] __attribute__((noinline)) static void probe_jump() { std::longjmp(g_probe_jb, 1); }
__attribute__((noinline)) static int longjmp_cleanup_probe()
{
    g_probe_dtors = 0;
    int seen = -1;
    {
        ProbeDtor live;
        if (setjmp(g_probe_jb) == 0) probe_jump();
        seen = g_probe_dtors;
    }
    return seen;
}

// libjpeg error manager that longjmps instead of exit() (wasm sjlj through a C library).
struct JpegErr { jpeg_error_mgr pub; std::jmp_buf jb; };
static void jpeg_error_exit_jump(j_common_ptr cinfo) { std::longjmp(reinterpret_cast<JpegErr *>(cinfo->err)->jb, 1); }

// Decodes the first row of a JPEG as RGBA. setjmp lives here, with trivially destructible locals only.
__attribute__((noinline)) static bool jpeg_decode_first_row(const unsigned char *data, size_t size, unsigned *w,
                                                            unsigned *h, unsigned char *row, size_t row_cap)
{
    jpeg_decompress_struct d;
    JpegErr je;
    d.err = jpeg_std_error(&je.pub);
    je.pub.error_exit = jpeg_error_exit_jump;
    bool ok = false;
    if (setjmp(je.jb) == 0) {
        jpeg_create_decompress(&d);
        jpeg_mem_src(&d, data, (unsigned long)size);
        jpeg_read_header(&d, TRUE);
        d.out_color_space = JCS_EXT_RGBA;
        jpeg_start_decompress(&d);
        *w = d.output_width;
        *h = d.output_height;
        if (size_t(d.output_width) * 4 <= row_cap) {
            unsigned char *rp = row;
            jpeg_read_scanlines(&d, &rp, 1);
            ok = true;
        }
        jpeg_abort_decompress(&d);
    }
    jpeg_destroy_decompress(&d);
    return ok;
}

// The JPEG path of Orca's GCode/Thumbnails.cpp (compress_thumbnail_jpg): RGBA rows, JCS_EXT_RGBA, jpeg_mem_dest.
static std::vector<unsigned char> compress_rgba_jpeg(const std::vector<unsigned char> &rgba, unsigned w, unsigned h)
{
    std::vector<unsigned char *> rows;
    for (unsigned y = 0; y < h; ++y) rows.push_back(const_cast<unsigned char *>(&rgba[y * w * 4]));
    std::vector<unsigned char> buf(rgba.size() + 1024);
    unsigned char *out = buf.data();
    unsigned long out_size = buf.size();
    jpeg_error_mgr err;
    jpeg_compress_struct info;
    info.err = jpeg_std_error(&err);
    jpeg_create_compress(&info);
    jpeg_mem_dest(&info, &out, &out_size);
    info.image_width = w;
    info.image_height = h;
    info.input_components = 4;
    info.in_color_space = JCS_EXT_RGBA;
    jpeg_set_defaults(&info);
    jpeg_set_quality(&info, 85, TRUE);
    jpeg_start_compress(&info, TRUE);
    jpeg_write_scanlines(&info, rows.data(), h);
    jpeg_finish_compress(&info);
    jpeg_destroy_compress(&info);
    return std::vector<unsigned char>(out, out + out_size);
}

int main()
{
    STEP("wasm EH across archives");
    // A C++ exception thrown inside libboost_filesystem.a is caught here.
    bool caught = false;
    try { boost::filesystem::file_size("/definitely/not/here"); }
    catch (const boost::filesystem::filesystem_error &) { caught = true; }
    CHECK(caught);

    STEP("wasm setjmp/longjmp next to wasm EH");
    CHECK(sjlj_roundtrip() == 7);
    const int probe = longjmp_cleanup_probe();
    std::printf("   longjmp runs cleanups of the setjmp caller: %s (see the note above longjmp_cleanup_probe)\n",
                probe == 0 ? "no" : "YES");

    STEP("MEMFS via Boost.Nowide + Boost.Filesystem");
    { boost::nowide::ofstream f("/tmp/smoke.txt"); f << "ok"; }
    CHECK(boost::filesystem::file_size("/tmp/smoke.txt") == 2);
    boost::filesystem::create_directories("/tmp/a/b");
    CHECK(boost::filesystem::is_directory("/tmp/a/b"));

    STEP("Boost.Log, Boost.Thread primitives, Boost.Locale, Boost.Iostreams, Boost.ProgramOptions");
    BOOST_LOG_TRIVIAL(info) << "boost.log ok";
    boost::mutex m;
    { boost::lock_guard<boost::mutex> lk(m); }
    {
        // Same backend set as Orca's Linux build (ICU off): posix is the default, std + iconv next to it.
        const auto backends = boost::locale::localization_backend_manager::global().get_all_backends();
        CHECK(!backends.empty() && backends.front() == "posix");
        std::locale loc = boost::locale::generator().generate("en_US.UTF-8");
        CHECK(std::use_facet<boost::locale::info>(loc).utf8());
        // utils.cpp normalize_utf8_nfc(): generate("") + normalize (a pass-through without ICU).
        std::locale sys = boost::locale::generator().generate("");
        CHECK(boost::locale::normalize(std::string("Benchy \xC3\xA9"), boost::locale::norm_nfc, sys) == "Benchy \xC3\xA9");
    }
    {
        const char blob[] = "12 34";
        boost::iostreams::stream<boost::iostreams::array_source> in(blob, sizeof(blob) - 1);
        int a = 0, b = 0;
        in >> a >> b;
        CHECK(a == 12 && b == 34);
    }
    {
        namespace po = boost::program_options;
        po::options_description desc;
        desc.add_options()("layer", po::value<double>());
        const char *argv[] = {"smoke", "--layer=0.2"};
        po::variables_map vm;
        po::store(po::parse_command_line(2, argv, desc), vm);
        CHECK(std::abs(vm["layer"].as<double>() - 0.2) < 1e-12);
    }

    STEP("CGAL GMP-free exact predicates, Boost.Multiprecision, Boost.Polygon Voronoi");
    {
        using K = CGAL::Exact_predicates_exact_constructions_kernel;
        // Exact zero forces the exact fallback of the filtered predicate.
        CHECK(CGAL::orientation(K::Point_2(0, 0), K::Point_2(1, 1), K::Point_2(3, 3)) == CGAL::COLLINEAR);
        CHECK(CGAL::orientation(K::Point_2(0.5, 0.5), K::Point_2(12, 12), K::Point_2(24, 24.000000000000004)) == CGAL::LEFT_TURN);
        using Ki = CGAL::Exact_predicates_inexact_constructions_kernel;
        CHECK(CGAL::orientation(Ki::Point_2(0.1, 0.1), Ki::Point_2(0.2, 0.2), Ki::Point_2(0.3, 0.3)) == CGAL::orientation(
            K::Point_2(0.1, 0.1), K::Point_2(0.2, 0.2), K::Point_2(0.3, 0.3)));
        boost::multiprecision::cpp_int big = 1;
        for (int i = 0; i < 100; ++i) big *= 3;
        CHECK(big % 1000 == 1);   // 3^100 = ...001
        std::vector<boost::polygon::point_data<int>> pts{{0, 0}, {10, 0}, {0, 10}, {10, 10}, {5, 5}};
        boost::polygon::voronoi_diagram<double> vd;
        boost::polygon::construct_voronoi(pts.begin(), pts.end(), &vd);
        CHECK(vd.cells().size() == 5);
    }

    STEP("Eigen, cereal, NLopt, Qhull, libnoise");
    {
        Eigen::Isometry3d T = Eigen::Isometry3d::Identity();
        T.translate(Eigen::Vector3d(1, 2, 3));
        CHECK((T * Eigen::Vector3d::Zero()).isApprox(Eigen::Vector3d(1, 2, 3)));

        std::vector<int> in{1, 2, 3}, out;
        std::stringstream ss;
        { cereal::BinaryOutputArchive oa(ss); oa(in); }
        { cereal::BinaryInputArchive ia(ss); ia(out); }
        CHECK(in == out);

        nlopt_opt opt = nlopt_create(NLOPT_LN_SBPLX, 1);   // subplex: what libnest2d uses
        nlopt_set_min_objective(opt, parabola, nullptr);
        nlopt_set_xtol_rel(opt, 1e-10);
        double x = 0., fx = 0.;
        nlopt_optimize(opt, &x, &fx);
        nlopt_destroy(opt);
        CHECK(std::abs(x - 3.) < 1e-4);

        // Cube hull (what TriangleMesh::convex_hull_3d does), then qhull's error path:
        // libqhull_r longjmps, qhullcpp turns it into a C++ QhullError.
        orgQhull::Qhull qh;
        std::vector<double> pts{0,0,0, 1,0,0, 0,1,0, 1,1,0, 0,0,1, 1,0,1, 0,1,1, 1,1,1, .5,.5,.5};
        qh.runQhull("", 3, 9, pts.data(), "Qt");
        CHECK(qh.facetCount() == 12);
        bool qerr = false;
        try { orgQhull::Qhull q2; std::vector<double> two{0,0,0, 1,1,1}; q2.runQhull("", 3, 2, two.data(), ""); }
        catch (const std::exception &) { qerr = true; }
        CHECK(qerr);

        noise::module::Perlin perlin;   // FuzzySkin
        double v = perlin.GetValue(0.1, 0.2, 0.3);
        CHECK(v > -2. && v < 2.);
    }

    STEP("zlib + libpng ports (round trip and libpng's longjmp error path)");
    {
        std::string text(4096, 'x');
        uLongf clen = compressBound(text.size());
        std::vector<Bytef> comp(clen);
        CHECK(compress(comp.data(), &clen, reinterpret_cast<const Bytef *>(text.data()), text.size()) == Z_OK);
        std::string back(text.size(), '\0');
        uLongf blen = back.size();
        CHECK(uncompress(reinterpret_cast<Bytef *>(&back[0]), &blen, comp.data(), clen) == Z_OK && back == text);

        const unsigned char rgba[16] = {255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,128};
        png_image img{}; img.version = PNG_IMAGE_VERSION; img.width = 2; img.height = 2; img.format = PNG_FORMAT_RGBA;
        png_alloc_size_t psize = 0;
        CHECK(png_image_write_to_memory(&img, nullptr, &psize, 0, rgba, 0, nullptr) && psize > 0);
        std::vector<unsigned char> png(psize);
        CHECK(png_image_write_to_memory(&img, png.data(), &psize, 0, rgba, 0, nullptr));
        png_image rd{}; rd.version = PNG_IMAGE_VERSION;
        CHECK(png_image_begin_read_from_memory(&rd, png.data(), psize));
        rd.format = PNG_FORMAT_RGBA;
        unsigned char px[16] = {};
        CHECK(png_image_finish_read(&rd, nullptr, px, 0, nullptr) && std::memcmp(px, rgba, 16) == 0);
        png_image bad{}; bad.version = PNG_IMAGE_VERSION;
        const unsigned char junk[64] = {0x89, 'P', 'N', 'G', 1, 2, 3};
        CHECK(!png_image_begin_read_from_memory(&bad, junk, sizeof(junk)));   // png_error -> longjmp inside libpng
        png_image_free(&bad);
    }

    STEP("libjpeg-turbo: JCS_EXT_RGBA + jpeg_mem_dest (Thumbnails.cpp), decode back, error path");
    {
        const unsigned w = 32, h = 16;
        std::vector<unsigned char> rgba(w * h * 4);
        for (unsigned i = 0; i < w * h; ++i) { rgba[i*4] = 200; rgba[i*4+1] = 30; rgba[i*4+2] = 90; rgba[i*4+3] = 255; }
        std::vector<unsigned char> jpg = compress_rgba_jpeg(rgba, w, h);
        CHECK(jpg.size() > 100 && jpg[0] == 0xFF && jpg[1] == 0xD8 && jpg[jpg.size()-2] == 0xFF && jpg.back() == 0xD9);

        unsigned dw = 0, dh = 0;
        unsigned char row[w * 4];
        CHECK(jpeg_decode_first_row(jpg.data(), jpg.size(), &dw, &dh, row, sizeof(row)));
        CHECK(dw == w && dh == h);
        CHECK(std::abs(int(row[0]) - 200) < 8 && std::abs(int(row[1]) - 30) < 8 && std::abs(int(row[2]) - 90) < 8);
        // A truncated stream: libjpeg reports it through error_exit -> longjmp back into the helper.
        const unsigned char junk[32] = {0xFF, 0xD8, 0x00};
        CHECK(!jpeg_decode_first_row(junk, sizeof(junk), &dw, &dh, row, sizeof(row)));
    }

#ifndef SMOKE_MT
    STEP("ST: thread creation is refused (Emscripten pthread stubs)");
    {
        bool refused = false;
        try { boost::thread t([] {}); t.join(); } catch (const boost::thread_resource_error &) { refused = true; }
        std::printf("   boost::thread in ST: %s\n", refused ? "thread_resource_error (expected)" : "started?!");
        CHECK(refused);
    }
#else
    STEP("MT: oneTBB workers, stack size, exceptions from workers, tbbmalloc, parallel_pipeline");
    // Holding a scheduler handle lets us join TBB's workers before the runtime exits (tbb::finalize below);
    // otherwise they are still running when EXIT_RUNTIME tears the pthreads down.
    tbb::task_scheduler_handle scheduler{tbb::attach{}};
    {
        // The engine keeps such a global_control alive: TBB 2021.12 gives its wasm32 workers 2 MiB stacks
        // (src/tbb/misc.h) and sets the size itself, so DEFAULT_PTHREAD_STACK_SIZE does not reach them.
        const size_t want_stack = 16u << 20;
        tbb::global_control stack_ctl(tbb::global_control::thread_stack_size, want_stack);
        const int conc = tbb::this_task_arena::max_concurrency();
        std::printf("   hardware_concurrency=%u  tbb max_concurrency=%d\n", std::thread::hardware_concurrency(), conc);
        CHECK(conc > 1);
        const std::thread::id main_id = std::this_thread::get_id();

        // Rendezvous of max_concurrency tasks, exactly like Orca's name_tbb_thread_pool_threads_set_locale()
        // (Thread.cpp, run by Print::process): every task blocks until all are running at once. Under
        // Emscripten a new TBB worker needs the main thread to service its proxy queue before it can run,
        // which only happens while the main thread waits (here: in cv.wait). A busy main thread simply runs
        // every task itself, so without such a warm-up the workers never join. This is also the pattern that
        // deadlocked Hiosdra/OrcaWasm when the pthread pool was smaller than TBB's concurrency.
        {
            size_t running = 0;
            std::condition_variable cv;
            std::mutex cv_m;
            std::set<std::thread::id> rendezvous_ids;
            tbb::parallel_for(tbb::blocked_range<size_t>(0, size_t(conc), 1), [&](const tbb::blocked_range<size_t> &) {
                std::unique_lock<std::mutex> lk(cv_m);
                rendezvous_ids.insert(std::this_thread::get_id());
                if (++running == size_t(conc)) { lk.unlock(); cv.notify_all(); }
                else cv.wait(lk, [&] { return running == size_t(conc); });
            });
            std::printf("   rendezvous of %d tasks: %zu distinct threads\n", conc, rendezvous_ids.size());
            CHECK(rendezvous_ids.size() == size_t(conc));
        }

        std::mutex mx;
        std::set<std::thread::id> ids;
        size_t min_worker_stack = SIZE_MAX;
        std::atomic<long long> sum{0};
        tbb::parallel_for(tbb::blocked_range<int>(0, 200000, 64), [&](const tbb::blocked_range<int> &rg) {
            long long local = 0;
            for (int i = rg.begin(); i < rg.end(); ++i) local += i;
            sum += local;
            volatile double burn = 0;                       // enough work per chunk for every worker to get some
            for (int k = 0; k < 20000; ++k) burn = burn + std::sqrt(double(k));
            std::lock_guard<std::mutex> lk(mx);
            ids.insert(std::this_thread::get_id());
            if (std::this_thread::get_id() != main_id)
                min_worker_stack = std::min(min_worker_stack, size_t(emscripten_stack_get_base() - emscripten_stack_get_end()));
        });
        CHECK(sum == 200000LL * 199999LL / 2);
        std::printf("   distinct threads used by parallel_for: %zu, smallest worker stack: %zu KiB\n",
                    ids.size(), min_worker_stack == SIZE_MAX ? size_t(0) : min_worker_stack >> 10);
        CHECK(ids.size() > 1);
        CHECK(min_worker_stack != SIZE_MAX && min_worker_stack >= want_stack - (64u << 10));

        // An exception thrown on a worker thread is rethrown to the caller with its exact type, as natively.
        bool worker_threw = false;
        try {
            tbb::parallel_for(0, 1 << 20, [&](int) {
                volatile double burn = 0;
                for (int k = 0; k < 2000; ++k) burn = burn + k;
                if (std::this_thread::get_id() != main_id) throw std::runtime_error("from worker");
            });
        } catch (const std::runtime_error &e) { worker_threw = std::strcmp(e.what(), "from worker") == 0; }
        CHECK(worker_threw);

        // tbbmalloc from many threads (Orca's Points use tbb::scalable_allocator).
        std::atomic<size_t> total{0};
        tbb::parallel_for(0, 256, [&](int i) {
            std::vector<double, tbb::scalable_allocator<double>> v(size_t(1000 + i), 1.0);
            total += v.size();
        });
        CHECK(total == 256u * 1000u + 255u * 256u / 2u);

        // parallel_pipeline, as in GCode.cpp's layer export.
        int next = 0; long long piped = 0;
        tbb::parallel_pipeline(size_t(conc),
            tbb::make_filter<void, int>(tbb::filter_mode::serial_in_order, [&](tbb::flow_control &fc) {
                if (next == 1000) { fc.stop(); return 0; } return next++; }) &
            tbb::make_filter<int, long long>(tbb::filter_mode::parallel, [](int i) { return 2LL * i; }) &
            tbb::make_filter<long long, void>(tbb::filter_mode::serial_in_order, [&](long long v) { piped += v; }));
        CHECK(piped == 999000LL);

        // An explicit arena: the way to cap concurrency without deadlocking nested parallelism
        // (Hiosdra/OrcaWasm's global_control deadlock).
        tbb::task_arena arena(4);
        int arena_conc = 0;
        arena.execute([&] { arena_conc = tbb::this_task_arena::max_concurrency(); });
        CHECK(arena_conc == 4);

        // Plain boost::thread / std::thread work too.
        std::atomic<int> ran{0};
        boost::thread bt([&] { ++ran; });
        std::thread st([&] { ++ran; });
        bt.join(); st.join();
        CHECK(ran == 2);
    }
    CHECK(tbb::finalize(scheduler, std::nothrow));   // all workers joined, no arena or observer left behind
#endif

    if (g_failures) { std::printf("SMOKE FAILED (%s): %d check(s)\n", SMOKE_VARIANT, g_failures); return 1; }
    std::printf("SMOKE OK (%s)\n", SMOKE_VARIANT);
    return 0;
}
