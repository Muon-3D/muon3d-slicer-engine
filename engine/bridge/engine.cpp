// JavaScript API of the engine module (the Emscripten factory createOrcaEngine), used by
// web/src/engine/worker.ts and engine/test. Everything Orca-specific happens in the other bridge
// files; this one converts between JS values and the plain C++ types of job.hpp.
//
//   version()                      -> { orcaVersion, orcaCommit }
//   slice(machineJson, processJson, filamentJsons[], objects[], toolpaths, onProgress, onWarning)
//                                  -> SliceOutput minus timings.total's worker share, or { error }
//   check(machineJson, processJson, filamentJsons[], objects[])
//                                  -> CheckOutput or { error }
//   requestCancel()                   makes a running slice stop at Orca's next cancellation point
//   setLogLevel(level)                Orca/Boost.Log verbosity: 0 off, 1 error (default) … 5 trace
//
// `objects` is [{ name, positions: Float32Array }]; presets are JSON text. Large arrays cross the
// boundary as one typed-array copy each way, never as JSON. Every returned typed array owns a
// fresh ArrayBuffer (not a view of the wasm heap), so the worker can transfer it without copying.
//
// Errors never escape as exceptions: they come back as { error: { code, message, objects? } }
// with the codes of protocol.ts EngineError; running out of memory is { code: 2 }, on every
// thread (see ensure_initialised). A wasm trap or abort() does escape; the worker reports that as
// code 1 (or 2 for out of memory) and the engine instance is gone.
#include "job.hpp"
#include "model_input.hpp"
#include "placement.hpp"
#include "slice_job.hpp"

#include <libslic3r/libslic3r.h> // also brings libslic3r_version.h (SoftFever_VERSION)
#include <libslic3r/Utils.hpp>

#include <boost/log/core.hpp>
#include <boost/log/expressions.hpp>
#include <boost/log/trivial.hpp>

#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#ifdef __EMSCRIPTEN_PTHREADS__
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <tbb/global_control.h>
#endif

#include <atomic>
#include <cstdio>
#include <mutex>
#include <new>
#include <string>
#include <vector>

// Set by the build (engine/CMakeLists.txt): the Orca commit the engine was built from, and where
// the runtime resource files (resources/info, flush, …) are in the virtual file system.
#ifndef ORCA_ENGINE_COMMIT
#define ORCA_ENGINE_COMMIT "unknown"
#endif
#ifndef ORCA_ENGINE_RESOURCES_DIR
#define ORCA_ENGINE_RESOURCES_DIR "/resources"
#endif

using emscripten::val;

namespace {

std::atomic<bool> g_cancel_requested{false};

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

void set_log_level(int level)
{
    namespace logging = boost::log;
    auto core = logging::core::get();
    if (level <= 0) {
        core->set_logging_enabled(false);
        return;
    }
    core->set_logging_enabled(true);
    // Orca's --debug scale (utils.cpp level_to_boost). Orca's own set_logging_level() forces
    // "info" for -dev versions, which floods the console and slows slicing, so it is bypassed.
    static const logging::trivial::severity_level levels[] = {logging::trivial::fatal, logging::trivial::error, logging::trivial::warning,
                                                              logging::trivial::info, logging::trivial::debug, logging::trivial::trace};
    core->set_filter(logging::trivial::severity >= levels[std::min(level, 5)]);
}

void ensure_initialised()
{
    static bool initialised = false;
    if (initialised)
        return;
    initialised = true;

    // A failed operator new must throw std::bad_alloc, which the API functions below report as
    // code 2. Emscripten's mimalloc (the mt build's malloc) is compiled as C: with no new-handler
    // installed its operator new calls abort() ("cannot throw in plain C", alloc.c
    // mi_try_new_handler), which kills the instance with a bare "unreachable" (or "unwind" on a TBB
    // thread). With one, mi_new calls it, and TBB hands the exception to the thread that started
    // the parallel loop. libc++'s operator new (st, dlmalloc) calls it too; throwing bad_alloc from
    // it is what that one does without a handler.
    std::set_new_handler([] { throw std::bad_alloc(); });

    Slic3r::set_resources_dir(ORCA_ENGINE_RESOURCES_DIR);
    Slic3r::set_temporary_dir("/tmp");
    set_log_level(1);
    // Without these, Orca silently falls back to built-in defaults (e.g. nozzle hardness).
    if (std::FILE *probe = std::fopen(ORCA_ENGINE_RESOURCES_DIR "/info/nozzle_info.json", "rb"))
        std::fclose(probe);
    else
        std::fprintf(stderr, "orca-engine: %s/info/nozzle_info.json is missing; Orca's resource files were not packaged.\n",
                     ORCA_ENGINE_RESOURCES_DIR);
#ifdef __EMSCRIPTEN_PTHREADS__
    // oneTBB gives its workers 2 MiB stacks on wasm32 and does not use Emscripten's default;
    // Arachne/CGAL recursion needs more, and wasm has no guard page to catch an overflow.
    static tbb::global_control tbb_stack_size(tbb::global_control::thread_stack_size, 8 * 1024 * 1024);
#endif
}

// ---------------------------------------------------------------------------------------------
// JS -> C++
// ---------------------------------------------------------------------------------------------

std::vector<std::string> strings_from_js(const val &array)
{
    std::vector<std::string> out;
    const unsigned           length = array["length"].as<unsigned>();
    out.reserve(length);
    for (unsigned i = 0; i < length; ++i)
        out.push_back(array[i].as<std::string>());
    return out;
}

std::vector<muon::MeshInput> meshes_from_js(const val &objects)
{
    std::vector<muon::MeshInput> out;
    const unsigned               length = objects["length"].as<unsigned>();
    out.reserve(length);
    for (unsigned i = 0; i < length; ++i) {
        const val object = objects[i];
        muon::MeshInput mesh;
        mesh.name = object["name"].as<std::string>();
        // One TypedArray.set into wasm memory.
        mesh.positions = emscripten::convertJSArrayToNumberVector<float>(object["positions"]);
        out.push_back(std::move(mesh));
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// C++ -> JS
// ---------------------------------------------------------------------------------------------

template<typename T> val typed_array(const char *type, const std::vector<T> &data)
{
    val array = val::global(type).new_(data.size());
    if (!data.empty())
        array.call<void>("set", val(emscripten::typed_memory_view(data.size(), data.data())));
    return array;
}

val strings_to_js(const std::vector<std::string> &strings)
{
    val array = val::array();
    for (const std::string &s : strings)
        array.call<void>("push", s);
    return array;
}

val numbers_to_js(const std::vector<double> &numbers)
{
    val array = val::array();
    for (double n : numbers)
        array.call<void>("push", n);
    return array;
}

val optional_number(const std::optional<double> &value) { return value ? val(*value) : val::null(); }
val optional_string(const std::optional<std::string> &value) { return value ? val(*value) : val::null(); }

// Orca ends some messages with a newline (e.g. validate()'s exclusion-volume error).
std::string trimmed(const std::string &text)
{
    const size_t end = text.find_last_not_of(" \t\r\n");
    return end == std::string::npos ? std::string() : text.substr(0, end + 1);
}

val error_to_js(const muon::EngineError &error)
{
    val out = val::object();
    out.set("code", error.code);
    out.set("message", trimmed(error.message));
    if (!error.objects.empty())
        out.set("objects", strings_to_js(error.objects));
    return out;
}

val failure_to_js(const muon::EngineError &error)
{
    val out = val::object();
    out.set("error", error_to_js(error));
    return out;
}

val warning_to_js(const muon::EngineWarning &warning)
{
    val out = val::object();
    out.set("kind", warning.kind);
    out.set("message", trimmed(warning.message));
    if (!warning.objects.empty())
        out.set("objects", strings_to_js(warning.objects));
    return out;
}

val stats_to_js(const muon::GcodeStats &stats)
{
    val out = val::object();
    out.set("printTimeSeconds", optional_number(stats.print_time_seconds));
    out.set("printTimeText", optional_string(stats.print_time_text));
    out.set("firstLayerTimeText", optional_string(stats.first_layer_time_text));
    out.set("filamentMm", optional_number(stats.filament_mm));
    out.set("filamentCm3", optional_number(stats.filament_cm3));
    out.set("filamentG", optional_number(stats.filament_g));
    out.set("filamentCost", optional_number(stats.filament_cost));
    out.set("layers", optional_number(stats.layers));
    out.set("maxZ", optional_number(stats.max_z));
    return out;
}

val vec3_to_js(const float *v)
{
    val out = val::array();
    for (int i = 0; i < 3; ++i)
        out.call<void>("push", double(v[i]));
    return out;
}

// web/src/gcode/parse.ts ParsedGcode
val toolpaths_to_js(const muon::ToolpathData &t)
{
    val extrusions = val::object();
    extrusions.set("positions", typed_array("Float32Array", t.extrusion_positions));
    extrusions.set("layerStart", typed_array("Uint32Array", t.extrusion_layer_start));
    extrusions.set("count", double(t.extrusion_count()));
    extrusions.set("roleIndex", typed_array("Uint8Array", t.extrusion_role));
    extrusions.set("width", typed_array("Uint8Array", t.extrusion_width));
    extrusions.set("height", typed_array("Uint8Array", t.extrusion_height));

    val travels = val::object();
    travels.set("positions", typed_array("Float32Array", t.travel_positions));
    travels.set("layerStart", typed_array("Uint32Array", t.travel_layer_start));
    travels.set("count", double(t.travel_count()));

    val out = val::object();
    out.set("layerCount", double(t.layer_count()));
    out.set("layerZ", typed_array("Float32Array", t.layer_z));
    out.set("extrusions", extrusions);
    out.set("travels", travels);
    out.set("roles", strings_to_js(t.roles));
    out.set("roleLength", numbers_to_js(t.role_length));
    out.set("lineWidth", optional_number(t.line_width));
    if (t.has_bounds) {
        val bounds = val::object();
        bounds.set("min", vec3_to_js(t.bounds_min));
        bounds.set("max", vec3_to_js(t.bounds_max));
        out.set("bounds", bounds);
    } else {
        out.set("bounds", val::null());
    }
    return out;
}

// protocol.ts ToolpathExtras
val extras_to_js(const muon::ToolpathData &t)
{
    val out = val::object();
    out.set("feedrate", typed_array("Float32Array", t.feedrate));
    out.set("fanSpeed", typed_array("Uint8Array", t.fan_speed));
    out.set("temperature", typed_array("Uint16Array", t.temperature));
    out.set("time", typed_array("Float32Array", t.time));
    out.set("height", typed_array("Float32Array", t.height));
    return out;
}

// The G-code stays in JS memory end to end: MEMFS keeps file contents in JS typed arrays, and
// FS.readFile returns a fresh copy. Reading it through C++ would grow the wasm heap by the size of
// the file for the rest of the session (wasm memory never shrinks).
EM_JS(emscripten::EM_VAL, orca_engine_read_file, (const char *path), {
    return Emval.toHandle(FS.readFile(UTF8ToString(path)));
});

val read_file(const std::string &path) { return val::take_ownership(orca_engine_read_file(path.c_str())); }

// ---------------------------------------------------------------------------------------------
// Progress and warnings -> JS callbacks
// ---------------------------------------------------------------------------------------------

// JS can only be called on the thread that owns the module (the worker's). In the multi-threaded
// build Orca reports some progress from TBB threads; those reports are queued and handed to the
// owning thread, which runs them when it next waits (Emscripten processes proxied calls while a
// thread blocks on a futex) or when it reports something itself. Progress is throttled to one
// message per percent step, or every 100 ms while the message changes.
class JsReporter final : public muon::JobReporter {
public:
    JsReporter(val on_progress, val on_warning)
        : m_on_progress(std::move(on_progress)), m_on_warning(std::move(on_warning)),
          m_has_progress(m_on_progress.typeOf().as<std::string>() == "function"),
          m_has_warning(m_on_warning.typeOf().as<std::string>() == "function")
    {
        s_active = this;
    }
    ~JsReporter() override { s_active = nullptr; }

    void progress(int percent, const std::string &message) override
    {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_percent          = percent;
            m_message          = message;
            m_progress_pending = true;
        }
        deliver();
    }

    void warning(const muon::EngineWarning &warning) override
    {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_warnings.push_back(warning);
        }
        deliver();
    }

    bool cancel_requested() override { return g_cancel_requested.load(std::memory_order_relaxed); }

    // Owning thread only. `force` sends pending progress even inside the throttle window.
    void flush(bool force = false)
    {
        std::vector<muon::EngineWarning> warnings;
        bool                             send_progress = false;
        int                              percent       = 0;
        std::string                      message;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_flush_scheduled = false;
            warnings.swap(m_warnings);
            if (m_progress_pending) {
                const double now = emscripten_get_now();
                if (force || m_percent != m_sent_percent || now - m_sent_at >= 100.0) {
                    send_progress      = true;
                    percent            = m_percent;
                    message            = m_message;
                    m_progress_pending = false;
                    m_sent_percent     = m_percent;
                    m_sent_at          = now;
                }
            }
        }
        if (m_has_warning)
            for (const muon::EngineWarning &warning : warnings)
                m_on_warning(warning_to_js(warning));
        if (send_progress && m_has_progress)
            m_on_progress(percent, message);
    }

private:
    void deliver()
    {
#ifdef __EMSCRIPTEN_PTHREADS__
        if (!emscripten_is_main_runtime_thread()) {
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (m_flush_scheduled)
                    return;
                m_flush_scheduled = true;
            }
            emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), &JsReporter::flush_active, nullptr);
            return;
        }
#endif
        flush();
    }

    // Runs on the owning thread; the job may have finished by then.
    static void flush_active(void *)
    {
        if (s_active != nullptr)
            s_active->flush();
    }

    static JsReporter *s_active; // owning thread only

    val        m_on_progress;
    val        m_on_warning;
    const bool m_has_progress;
    const bool m_has_warning;

    std::mutex                       m_mutex;
    bool                             m_flush_scheduled  = false;
    bool                             m_progress_pending = false;
    int                              m_percent          = 0;
    std::string                      m_message;
    int                              m_sent_percent = -1;
    double                           m_sent_at      = -1e9;
    std::vector<muon::EngineWarning> m_warnings;
};

JsReporter *JsReporter::s_active = nullptr;

muon::PlacementChecker &placement_checker()
{
    static muon::PlacementChecker checker;
    return checker;
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

val js_version()
{
    val out = val::object();
    out.set("orcaVersion", std::string(SoftFever_VERSION));
    out.set("orcaCommit", std::string(ORCA_ENGINE_COMMIT));
    return out;
}

val js_slice(const std::string &machine_json, const std::string &process_json, const val &filaments, const val &objects, bool want_toolpaths,
             const val &on_progress, const val &on_warning)
{
    ensure_initialised();
    g_cancel_requested = false;
    JsReporter reporter(on_progress, on_warning);
    try {
        muon::SliceRequest request;
        request.machine_json   = machine_json;
        request.process_json   = process_json;
        request.filament_jsons = strings_from_js(filaments);
        request.objects        = meshes_from_js(objects);
        request.want_toolpaths = want_toolpaths;

        muon::SliceResult result = muon::run_slice(std::move(request), reporter);
        muon::JobDirGuard job_dir(result.job_dir);

        val timings = val::object();
        timings.set("load", result.timings.load_ms);
        timings.set("slice", result.timings.slice_ms);
        timings.set("export", result.timings.export_ms);
        timings.set("total", result.timings.total_ms);

        val warnings = val::array();
        for (const muon::EngineWarning &warning : result.warnings)
            warnings.call<void>("push", warning_to_js(warning));

        val out = val::object();
        out.set("gcode", read_file(result.gcode_path));
        out.set("stats", stats_to_js(result.stats));
        if (result.toolpaths) {
            out.set("toolpaths", toolpaths_to_js(*result.toolpaths));
            out.set("toolpathExtras", extras_to_js(*result.toolpaths));
        } else {
            out.set("toolpaths", val::null());
            out.set("toolpathExtras", val::null());
        }
        out.set("warnings", warnings);
        out.set("timings", timings);
        // Everything reported must reach the worker before it posts the result.
        reporter.flush(true);
        return out;
    } catch (const muon::JobFailure &failure) {
        reporter.flush(true);
        return failure_to_js(failure.error());
    } catch (const std::bad_alloc &) {
        return failure_to_js({muon::ENGINE_OUT_OF_MEMORY, "The slicing engine ran out of memory.", {}});
    } catch (const std::exception &ex) {
        return failure_to_js({muon::ENGINE_INTERNAL_ERROR, std::string("Internal engine error: ") + ex.what(), {}});
    } catch (...) {
        return failure_to_js({muon::ENGINE_INTERNAL_ERROR, "Internal engine error.", {}});
    }
}

val js_check(const std::string &machine_json, const std::string &process_json, const val &filaments, const val &objects)
{
    ensure_initialised();
    try {
        muon::CheckRequest request;
        request.machine_json   = machine_json;
        request.process_json   = process_json;
        request.filament_jsons = strings_from_js(filaments);
        request.objects        = meshes_from_js(objects);

        const std::vector<muon::CheckedObject> results = placement_checker().check(std::move(request));

        val list = val::array();
        for (const muon::CheckedObject &object : results) {
            val hits = val::array();
            for (const muon::ExclusionHit &hit : object.exclusion_hits) {
                val entry = val::object();
                entry.set("extruder", hit.extruder);
                entry.set("regionIndex", hit.region_index);
                entry.set("triangles", typed_array("Float32Array", hit.triangles));
                hits.call<void>("push", entry);
            }
            val entry = val::object();
            entry.set("name", object.name);
            entry.set("inside", object.inside);
            entry.set("exclusionHits", hits);
            list.call<void>("push", entry);
        }
        val out = val::object();
        out.set("objects", list);
        return out;
    } catch (const muon::JobFailure &failure) {
        return failure_to_js(failure.error());
    } catch (const std::bad_alloc &) {
        placement_checker().clear();
        return failure_to_js({muon::ENGINE_OUT_OF_MEMORY, "The slicing engine ran out of memory.", {}});
    } catch (const std::exception &ex) {
        return failure_to_js({muon::ENGINE_INTERNAL_ERROR, std::string("Internal engine error: ") + ex.what(), {}});
    } catch (...) {
        return failure_to_js({muon::ENGINE_INTERNAL_ERROR, "Internal engine error.", {}});
    }
}

void js_request_cancel() { g_cancel_requested = true; }

void js_set_log_level(int level)
{
    ensure_initialised();
    set_log_level(level);
}

} // namespace

EMSCRIPTEN_BINDINGS(orca_engine)
{
    emscripten::function("version", &js_version);
    emscripten::function("slice", &js_slice);
    emscripten::function("check", &js_check);
    emscripten::function("requestCancel", &js_request_cancel);
    emscripten::function("setLogLevel", &js_set_log_level);
}
