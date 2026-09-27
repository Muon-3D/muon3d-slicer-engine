#include "model_input.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/ClipperUtils.hpp>
#include <libslic3r/Format/STL.hpp>
#include <libslic3r/Utils.hpp>

#include <boost/filesystem.hpp>
#include <boost/nowide/cstdio.hpp>

#ifdef __EMSCRIPTEN__
#include <emscripten/heap.h>
#endif

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cfloat>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <new>
#include <optional>
#include <set>
#include <stdexcept>

using namespace Slic3r;

namespace muon {

std::string make_job_dir(const std::string &kind)
{
    static std::atomic<unsigned> counter{0};
    const std::string dir = "/tmp/orca-engine/" + kind + "-" + std::to_string(++counter);
    boost::system::error_code ec;
    boost::filesystem::remove_all(dir, ec);
    boost::filesystem::create_directories(dir, ec);
    if (ec)
        throw JobFailure(ENGINE_INTERNAL_ERROR, "Could not create " + dir + " in the engine's virtual file system: " + ec.message());
    return dir;
}

void remove_job_dir(const std::string &dir) noexcept
{
    boost::system::error_code ec;
    boost::filesystem::remove_all(dir, ec);
}

namespace {

struct FileCloser {
    void operator()(std::FILE *f) const { std::fclose(f); }
};

void put_u32(unsigned char *out, uint32_t v)
{
    out[0] = uint8_t(v);
    out[1] = uint8_t(v >> 8);
    out[2] = uint8_t(v >> 16);
    out[3] = uint8_t(v >> 24);
}

void put_f32(unsigned char *out, float v)
{
    uint32_t bits;
    std::memcpy(&bits, &v, sizeof bits);
    put_u32(out, bits);
}

// Triangles admesh can keep: finite coordinates and a non-zero area. When there are none, load_stl
// fails with an unhelpful std::length_error ("vector") or Orca later finds nothing to slice.
size_t count_usable_triangles(const std::vector<float> &positions)
{
    size_t usable = 0;
    for (size_t t = 0; t + 9 <= positions.size(); t += 9) {
        const float *p = positions.data() + t;
        if (!std::all_of(p, p + 9, [](float v) { return std::isfinite(v); }))
            continue;
        const double ux = double(p[3]) - p[0], uy = double(p[4]) - p[1], uz = double(p[5]) - p[2];
        const double vx = double(p[6]) - p[0], vy = double(p[7]) - p[1], vz = double(p[8]) - p[2];
        if (uy * vz - uz * vy != 0 || uz * vx - ux * vz != 0 || ux * vy - uy * vx != 0)
            ++usable;
    }
    return usable;
}

// A setting's value as an error message quotes it: long values (G-code, lists) are cut short.
std::string quoted_value(const std::string &value)
{
    constexpr size_t MAX_SHOWN = 60;
    return "\"" + (value.size() <= MAX_SHOWN ? value : value.substr(0, MAX_SHOWN) + "...") + "\"";
}

// A setting as a message names it: Orca's label and the key, e.g. "Wall loops" (wall_loops).
std::string setting_name(const std::string &key)
{
    const ConfigOptionDef *def   = print_config_def.get(key);
    const std::string      label = def == nullptr ? std::string() : !def->full_label.empty() ? def->full_label : def->label;
    return label.empty() ? "\"" + key + "\"" : "\"" + label + "\" (" + key + ")";
}

// Orca's text as a sentence of our message: trimmed, capitalised, ending in a full stop.
std::string as_sentence(std::string text)
{
    const size_t first = text.find_first_not_of(" \t\r\n");
    const size_t last  = text.find_last_not_of(" \t\r\n");
    text               = first == std::string::npos ? std::string() : text.substr(first, last - first + 1);
    if (!text.empty()) {
        text[0] = char(std::toupper(static_cast<unsigned char>(text[0])));
        if (text.back() != '.' && text.back() != '!' && text.back() != '?')
            text += '.';
    }
    return text;
}

// A limit as Orca's source wrote it (the float 0.1f is "0.1", 1000 is not "1e+03"), with "%" for a
// percentage.
std::string limit_text(float limit, const ConfigOptionDef &def)
{
    char text[64] = "";
    for (int decimals = 0; decimals <= 9; ++decimals) {
        std::snprintf(text, sizeof text, "%.*f", decimals, double(limit));
        if (std::strtof(text, nullptr) == limit)
            break;
    }
    return std::string(text) + (def.sidetext == "%" ? "%" : "");
}

// "It must be between 0 and 1000." from the option's limits (Orca's "no limit" is ±FLT_MAX).
std::string limits_text(const ConfigOptionDef &def)
{
    const bool has_min = def.min > -FLT_MAX, has_max = def.max < FLT_MAX;
    if (has_min && has_max)
        return "It must be between " + limit_text(def.min, def) + " and " + limit_text(def.max, def) + ".";
    if (has_min)
        return "It must be at least " + limit_text(def.min, def) + ".";
    if (has_max)
        return "It must be at most " + limit_text(def.max, def) + ".";
    return {};
}

// validate()'s range check of one option ("Out of range validation of numeric values").
bool within_limits(const ConfigOption &option, const ConfigOptionDef &def)
{
    const auto valid = [&def](double value) { return def.is_value_valid(value); };
    switch (option.type()) {
    case coFloat:
    case coPercent:
    case coFloatOrPercent: return valid(static_cast<const ConfigOptionFloat &>(option).value);
    case coInt: return valid(static_cast<const ConfigOptionInt &>(option).value);
    case coFloats:
    case coPercents: {
        const std::vector<double> &values = static_cast<const ConfigOptionVector<double> &>(option).values;
        return std::all_of(values.begin(), values.end(), valid);
    }
    case coInts: {
        const std::vector<int> &values = static_cast<const ConfigOptionVector<int> &>(option).values;
        return std::all_of(values.begin(), values.end(), valid);
    }
    default: return true;
    }
}

// The option's number when it holds a single one.
std::optional<double> single_number(const ConfigOption &option)
{
    switch (option.type()) {
    case coFloat:
    case coPercent:
    case coFloatOrPercent: return static_cast<const ConfigOptionFloat &>(option).value;
    case coInt: return static_cast<const ConfigOptionInt &>(option).value;
    default: return std::nullopt;
    }
}

// The object's own settings into `config`, the way Orca's 3MF loader applies an object's metadata
// from Metadata/model_settings.config (bbs_3mf.cpp:2170, ModelConfig::set_deserialize), with two
// differences so that a setting the user can see never quietly does something else: a key this
// Orca does not define fails the job (set_deserialize would drop it: handle_legacy clears unknown
// keys), and so does a value Orca would replace with the option's default (an enum value this
// build does not know; the loader's ForwardCompatibilitySubstitutionRule::Enable allows that).
// `config` is the ModelObject's (Print::apply then merges it over the plate's,
// object_config_from_model_object / region_config_from_model_volume, as for a 3MF project), or a
// DynamicPrintConfig for check_object_config.
template<class Config> void deserialize_object_config(Config &config, const MeshInput &object, const std::string &label)
{
    ConfigSubstitutionContext substitutions(ForwardCompatibilitySubstitutionRule::Disable);
    for (const auto &[key, value] : object.config) {
        if (print_config_def.get(key) == nullptr)
            throw JobFailure(CLI_CONFIG_FILE_ERROR, label + " has an unknown setting \"" + key + "\".", {object.name});
        try {
            config.set_deserialize(key, value, substitutions);
        } catch (const std::bad_alloc &) {
            throw;
        } catch (const std::exception &) {
            // BadOptionValueException: "Invalid value provided for parameter <key>: <value>".
            throw JobFailure(CLI_CONFIG_FILE_ERROR,
                             label + " has an invalid value for the setting " + setting_name(key) + ": " + quoted_value(value) + ".", {object.name});
        }
    }
}

// True when the wasm heap has grown to within an eighth of its maximum, i.e. an allocation Orca
// swallowed most likely failed for lack of memory. Natively always false.
bool heap_nearly_full()
{
#ifdef __EMSCRIPTEN__
    const size_t max = emscripten_get_heap_max();
    return emscripten_get_heap_size() >= max - max / 8;
#else
    return false;
#endif
}

} // namespace

void write_binary_stl(const std::string &path, const std::vector<float> &positions)
{
    std::unique_ptr<std::FILE, FileCloser> file(boost::nowide::fopen(path.c_str(), "wb"));
    if (!file)
        throw JobFailure(ENGINE_INTERNAL_ERROR, "Could not create " + path + " in the engine's virtual file system.");

    // The header text a web app writes for Orca's CLI. admesh tells binary from ASCII by
    // sniffing the bytes after the header, so matching those bytes also matches how the
    // CLI decides that.
    unsigned char header[84] = {};
    static const char text[] = "Binary STL written by Muon3D Web Slicer";
    std::memcpy(header, text, sizeof text - 1);
    const size_t count = positions.size() / 9;
    put_u32(header + 80, uint32_t(count));
    bool ok = std::fwrite(header, sizeof header, 1, file.get()) == 1;

    constexpr size_t FACET_BYTES = 50, FACETS_PER_CHUNK = 4096;
    std::vector<unsigned char> chunk(FACET_BYTES * FACETS_PER_CHUNK);
    for (size_t first = 0; ok && first < count; first += FACETS_PER_CHUNK) {
        const size_t n = std::min(FACETS_PER_CHUNK, count - first);
        std::memset(chunk.data(), 0, n * FACET_BYTES); // attribute byte count stays 0
        for (size_t t = 0; t < n; ++t) {
            const float   *p   = positions.data() + (first + t) * 9;
            unsigned char *out = chunk.data() + t * FACET_BYTES;
            // Unit face normal, computed in double like the app's STL writer (the value does not
            // matter: admesh recomputes normals on import).
            const double ux = double(p[3]) - p[0], uy = double(p[4]) - p[1], uz = double(p[5]) - p[2];
            const double vx = double(p[6]) - p[0], vy = double(p[7]) - p[1], vz = double(p[8]) - p[2];
            double       nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const double length = std::hypot(nx, ny, nz);
            if (length > 0 && std::isfinite(length)) {
                nx /= length;
                ny /= length;
                nz /= length;
            } else {
                nx = ny = nz = 0;
            }
            put_f32(out, float(nx));
            put_f32(out + 4, float(ny));
            put_f32(out + 8, float(nz));
            for (int k = 0; k < 9; ++k)
                put_f32(out + 12 + 4 * k, p[k]);
        }
        ok = std::fwrite(chunk.data(), FACET_BYTES, n, file.get()) == n;
    }
    if (!ok || std::fflush(file.get()) != 0)
        throw JobFailure(ENGINE_INTERNAL_ERROR, "Could not write " + path + " to the engine's virtual file system.");
}

ModelObject *load_object(Model &model, const MeshInput &object, const std::string &stl_path)
{
    const std::string label = "The object \"" + object.name + "\"";
    if (object.positions.size() % 9 != 0)
        throw JobFailure(CLI_DATA_FILE_ERROR, label + " is not a triangle list (9 values per triangle).", {object.name});
    if (const size_t triangles = object.positions.size() / 9; triangles > 0 && count_usable_triangles(object.positions) == 0)
        throw JobFailure(CLI_DATA_FILE_ERROR,
                         label + " has no usable triangles: all " + std::to_string(triangles) +
                             " have a zero area or coordinates that are not finite numbers.",
                         {object.name});
    write_binary_stl(stl_path, object.positions);

    const size_t count_before = model.objects.size();
    bool         loaded       = false;
    try {
        // Named explicitly: load_stl would otherwise name the object after the MEMFS file.
        loaded = load_stl(stl_path.c_str(), &model, object.name.c_str());
    } catch (const std::bad_alloc &) {
        throw; // code 2, not a bad model
    } catch (const std::length_error &) {
        // admesh was left with no facets (std::vector's "vector").
        throw JobFailure(CLI_DATA_FILE_ERROR, label + " has no usable triangles.", {object.name});
    } catch (const std::exception &ex) {
        throw JobFailure(CLI_DATA_FILE_ERROR, label + " could not be read: " + ex.what(), {object.name});
    }
    if (!loaded || model.objects.size() != count_before + 1)
        throw JobFailure(CLI_DATA_FILE_ERROR, label + " has no usable triangles.", {object.name});

    ModelObject *model_object = model.objects.back();
    deserialize_object_config(model_object->config, object, label);
    // Orca computes each volume's convex hull while loading and turns any qhull failure into an
    // empty hull (its_convex_hull in TriangleMesh.cpp catches everything); the object then counts
    // as outside the bed and the plate fails with -50 "nothing to slice". Flat meshes end that way
    // in the CLI too, and still do; on a nearly full heap it is qhull running out of memory.
    for (const ModelVolume *volume : model_object->volumes)
        if (!volume->mesh().empty() && volume->get_convex_hull().empty() && heap_nearly_full())
            throw std::bad_alloc();
    // What Model::read_from_file records: the path given on the CLI's command line, which for
    // a CLI run from the job folder is the bare STL file name, i.e. the object name.
    model_object->input_file = object.name;
    model.add_default_instances(); // LoadStrategy::AddDefaultInstances
    model_object->ensure_on_bed(); // OS:1987
    return model_object;
}

void check_object_config(const MeshInput &object, const DynamicPrintConfig &plate_config)
{
    if (object.config.empty())
        return;
    const std::string  label = "The object \"" + object.name + "\"";
    DynamicPrintConfig own;
    deserialize_object_config(own, object, label);

    DynamicPrintConfig combined = plate_config;
    combined.apply(own);
    // Not under_cli: the spiral vase checks are about the plate's settings, which passed them.
    const std::map<std::string, std::string> problems = combined.validate(false);
    if (problems.empty())
        return;
    // The plate's config passed these checks, so each problem comes from the object's settings;
    // name one the object sets where there is one.
    auto problem = std::find_if(problems.begin(), problems.end(), [&own](const auto &entry) { return own.has(entry.first); });
    if (problem == problems.end())
        problem = problems.begin();
    const std::string &key    = problem->first;
    const std::string &reason = problem->second;

    const auto given = std::find_if(object.config.begin(), object.config.end(), [&key](const auto &entry) { return entry.first == key; });
    const std::string value = given != object.config.end() ? given->second : combined.opt_serialize(key);
    std::string message = label + " has an invalid value for the setting " + setting_name(key) + ": " + quoted_value(value) + ".";
    const ConfigOptionDef       *def    = print_config_def.get(key);
    const ConfigOption          *option = combined.option(key);
    const std::optional<double>  number = option != nullptr ? single_number(*option) : std::nullopt;
    // The single numbers validate() wants above 0 ("<= 0" is an "invalid value"); their limits
    // (def.min 0) would say "at least 0".
    static const std::set<std::string> ABOVE_ZERO{"layer_height", "initial_layer_print_height", "bridge_flow", "internal_bridge_flow",
                                                  "extruder_clearance_radius", "extruder_clearance_height_to_rod",
                                                  "extruder_clearance_height_to_lid", "nozzle_height"};
    if (ABOVE_ZERO.count(key) != 0 && number && *number <= 0) {
        message += " It must be more than 0.";
    } else if (def != nullptr && option != nullptr && !within_limits(*option, *def)) {
        if (const std::string limits = limits_text(*def); !limits.empty())
            message += " " + limits;
    } else if (reason.compare(0, 13, "invalid value") != 0) {
        // Orca's own words, e.g. "Bridge line width must not exceed nozzle diameter: 0.600000".
        if (const std::string text = as_sentence(reason); !text.empty())
            message += " " + text;
    }
    throw JobFailure(CLI_CONFIG_FILE_ERROR, message, {object.name});
}

BuildVolume plate_build_volume(const DynamicPrintConfig &config)
{
    const Pointfs shape = make_counter_clockwise(config.opt<ConfigOptionPoints>("printable_area")->values);
    const double  print_height = config.opt_float("printable_height");
    std::vector<Pointfs> extruder_areas;
    std::vector<double>  extruder_heights;
    if (const auto *areas = config.opt<ConfigOptionPointsGroups>("extruder_printable_area"))
        extruder_areas = areas->values;
    if (const auto *heights = config.opt<ConfigOptionFloatsNullable>("extruder_printable_height"))
        extruder_heights = heights->values;
    return BuildVolume(shape, print_height, extruder_areas, extruder_heights);
}

bool is_bbl_printer(const DynamicPrintConfig &config, const std::string &printer_name)
{
    const auto *model = config.option<ConfigOptionString>("printer_model");
    const std::string &name = (model != nullptr && !model->value.empty()) ? model->value : printer_name;
    return name.compare(0, 9, "Bambu Lab") == 0;
}

std::string object_name(const ObjectBase *object)
{
    if (object == nullptr)
        return {};
    if (const auto *print_object = dynamic_cast<const PrintObject *>(object))
        return print_object->model_object() ? print_object->model_object()->name : std::string();
    if (const auto *instance = dynamic_cast<const ModelInstance *>(object))
        return instance->get_object() ? instance->get_object()->name : std::string();
    if (const auto *model_object = dynamic_cast<const ModelObject *>(object))
        return model_object->name;
    return {};
}

std::string print_object_name(const Print &print, size_t object_id)
{
    for (const PrintObject *print_object : print.objects())
        if (print_object->id().id == object_id && print_object->model_object() != nullptr)
            return print_object->model_object()->name;
    return {};
}

} // namespace muon
