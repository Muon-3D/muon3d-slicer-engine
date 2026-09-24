#include "model_input.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/ClipperUtils.hpp>
#include <libslic3r/Format/STL.hpp>
#include <libslic3r/Utils.hpp>

#include <boost/filesystem.hpp>
#include <boost/nowide/cstdio.hpp>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>

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

} // namespace

void write_binary_stl(const std::string &path, const std::vector<float> &positions)
{
    std::unique_ptr<std::FILE, FileCloser> file(boost::nowide::fopen(path.c_str(), "wb"));
    if (!file)
        throw JobFailure(ENGINE_INTERNAL_ERROR, "Could not create " + path + " in the engine's virtual file system.");

    // Same header text as server/meshio.ts writeBinaryStl. admesh tells binary from ASCII by
    // sniffing the bytes after the header, so matching the server's bytes also matches how the
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
            // Unit face normal, computed in double like the server (the value itself does not
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
    write_binary_stl(stl_path, object.positions);

    const size_t count_before = model.objects.size();
    bool         loaded       = false;
    try {
        // Named explicitly: load_stl would otherwise name the object after the MEMFS file.
        loaded = load_stl(stl_path.c_str(), &model, object.name.c_str());
    } catch (const std::exception &ex) {
        throw JobFailure(CLI_DATA_FILE_ERROR, label + " could not be read: " + ex.what(), {object.name});
    }
    if (!loaded || model.objects.size() != count_before + 1)
        throw JobFailure(CLI_DATA_FILE_ERROR, label + " has no usable triangles.", {object.name});

    ModelObject *model_object = model.objects.back();
    // What Model::read_from_file records: the path given on the CLI's command line, which on the
    // server is the bare STL file name, i.e. the object name.
    model_object->input_file = object.name;
    model.add_default_instances(); // LoadStrategy::AddDefaultInstances
    model_object->ensure_on_bed(); // OS:1987
    return model_object;
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
