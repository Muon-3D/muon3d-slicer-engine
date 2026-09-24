// Placement check (engine/research/headless-entry.md §4). It reproduces, without slicing:
//  * `inside`: ModelInstance::calc_print_volume_state against the plate's build volume - what the
//    CLI uses for "nothing inside" (-50) and "partly outside" (-52). For objects resting on the bed
//    it equals the volume test in the GUI's PartPlate::check_outside; the exclusion regions that
//    the GUI folds into the same flag are reported separately in `exclusion_hits`.
//  * `exclusion_hits`: ModelInstance::intersects_bed_exclude_region for the regions that
//    Print::validate checks (colliding_bed_exclusion, Print.cpp:92-150): the shared legacy
//    keep-out area once, and the collision volumes of the nozzle(s) that print the object. The
//    clipped surface pieces are what the GUI draws red (PartPlate.cpp:1380-1460).
#include "placement.hpp"

#include "model_input.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/ClipperUtils.hpp>
#include <libslic3r/Polygon.hpp>
#include <libslic3r/Utils.hpp>

#include <algorithm>
#include <cmath>
#include <optional>
#include <set>

using namespace Slic3r;

namespace muon {

struct PlacementChecker::Settings {
    std::string                                key; // the preset JSON the settings were built from
    PreparedConfig                             prepared;
    std::unique_ptr<BuildVolume>               build_volume;
    std::vector<std::vector<BedExcludeRegion>> regions_by_extruder;
    BedExcludeVolumeMode                       mode = BedExcludeVolumeMode::Shared;
    bool                                       bbl  = false;
    // The plate's filament map as the slice job sets it (OS:6738-6744).
    std::vector<int> filament_map;
};

struct PlacementChecker::CachedObject {
    std::string            name;
    std::vector<float>     positions; // the triangles the model was loaded from
    std::unique_ptr<Model> model;
    Vec3d                  loaded_offset = Vec3d::Zero(); // instance offset right after loading
    bool                   used          = false;
};

namespace {

// Largest per-coordinate deviation (mm) still accepted as "the same mesh, moved". Float32 bed
// coordinates of a translated mesh carry rounding errors of a few 1e-5 mm.
constexpr double TRANSLATION_TOLERANCE = 1e-3;

// If `moved` is `original` shifted by one constant vector, that vector.
std::optional<Vec3d> translation_between(const std::vector<float> &original, const std::vector<float> &moved)
{
    if (original.size() != moved.size() || original.size() < 3)
        return std::nullopt;
    const Vec3d shift(double(moved[0]) - original[0], double(moved[1]) - original[1], double(moved[2]) - original[2]);
    for (size_t i = 0; i < original.size(); ++i)
        if (std::abs(double(moved[i]) - (double(original[i]) + shift[int(i % 3)])) > TRANSLATION_TOLERANCE)
            return std::nullopt;
    return shift;
}

std::vector<float> triangle_soup(const indexed_triangle_set &its)
{
    std::vector<float> soup;
    soup.reserve(its.indices.size() * 9);
    for (const stl_triangle_vertex_indices &face : its.indices)
        for (int corner = 0; corner < 3; ++corner) {
            const Vec3f &v = its.vertices[size_t(face[corner])];
            soup.insert(soup.end(), {v.x(), v.y(), v.z()});
        }
    return soup;
}

} // namespace

PlacementChecker::PlacementChecker()  = default;
PlacementChecker::~PlacementChecker() = default;

void PlacementChecker::clear()
{
    m_settings.reset();
    m_objects.clear();
}

const PlacementChecker::Settings &PlacementChecker::settings_for(const CheckRequest &request, const std::string &work_dir)
{
    // JSON text never contains a raw NUL, so this key is unambiguous.
    std::string key = request.machine_json + '\0' + request.process_json;
    for (const std::string &filament : request.filament_jsons)
        key += '\0' + filament;
    if (m_settings && m_settings->key == key)
        return *m_settings;

    m_settings.reset();
    auto settings = std::make_unique<Settings>();
    try {
        settings->prepared = prepare_config(request.machine_json, request.process_json, request.filament_jsons, work_dir);
    } catch (const JobFailure &) {
        throw;
    } catch (const std::bad_alloc &) {
        throw;
    } catch (const std::exception &ex) {
        throw JobFailure(CLI_CONFIG_FILE_ERROR, std::string("The presets could not be combined: ") + ex.what());
    }
    const DynamicPrintConfig &config = settings->prepared.print_config;
    settings->build_volume           = std::make_unique<BuildVolume>(plate_build_volume(config));
    // The plate origin is (0,0), so the regions need no translation (Print.cpp:70-90).
    settings->regions_by_extruder = get_bed_excluded_regions_by_extruder(config);
    settings->mode                = active_bed_exclude_volume_mode(config);
    settings->bbl                 = is_bbl_printer(config, settings->prepared.printer_name);

    if (const auto *filament_map = config.option<ConfigOptionInts>("filament_map"))
        settings->filament_map = filament_map->values;
    if (int(settings->filament_map.size()) < settings->prepared.filament_count)
        settings->filament_map.resize(size_t(settings->prepared.filament_count), 1);
    if (settings->prepared.extruder_count == 1)
        std::fill(settings->filament_map.begin(), settings->filament_map.end(), 1);

    settings->key = std::move(key);
    m_settings    = std::move(settings);
    return *m_settings;
}

ModelObject *PlacementChecker::object_for(MeshInput &input, const std::string &stl_path)
{
    for (const std::unique_ptr<CachedObject> &cached : m_objects) {
        if (cached->used || cached->name != input.name)
            continue;
        if (const std::optional<Vec3d> shift = translation_between(cached->positions, input.positions)) {
            ModelObject *object = cached->model->objects.front();
            // X/Y follow the move; Z stays where ensure_on_bed put it, as a fresh load would.
            object->instances.front()->set_offset(cached->loaded_offset + Vec3d(shift->x(), shift->y(), 0.));
            cached->used = true;
            return object;
        }
    }

    auto cached           = std::make_unique<CachedObject>();
    cached->name          = input.name;
    cached->model         = std::make_unique<Model>();
    ModelObject *object   = load_object(*cached->model, input, stl_path);
    cached->loaded_offset = object->instances.front()->get_offset();
    cached->positions     = std::move(input.positions); // kept to recognise the next move
    cached->used          = true;
    m_objects.push_back(std::move(cached));
    return object;
}

CheckedObject PlacementChecker::check_object(const std::string &name, ModelObject &object) const
{
    const Settings &settings = *m_settings;
    ModelInstance  &instance = *object.instances.front();

    CheckedObject result;
    result.name   = name;
    result.inside = instance.calc_print_volume_state(*settings.build_volume) == ModelInstancePVS_Inside;

    const std::vector<std::vector<BedExcludeRegion>> &groups = settings.regions_by_extruder;
    if (groups.empty())
        return result;

    const Polygon       hull = instance.convex_hull_2d();
    const BoundingBoxf3 bbox = object.instance_convex_hull_bounding_box(size_t(0));

    auto test_region = [&](size_t extruder, size_t region_index, const BedExcludeRegion &region) {
        // Cheap rejections first, as PartPlate::check_outside does (PP:3485-3489).
        Polygon footprint = region.polygon;
        footprint.make_counter_clockwise();
        if (intersection(Polygons{footprint}, Polygons{hull}).empty())
            return;
        if (bbox.max.z() < std::min(region.z_min, region.z_max) || bbox.min.z() > std::max(region.z_min, region.z_max))
            return;
        indexed_triangle_set surface;
        if (!instance.intersects_bed_exclude_region(region, &surface))
            return;
        result.exclusion_hits.push_back({int(extruder), int(region_index), triangle_soup(surface)});
    };

    // The legacy keep-out area is bed-fixed and shared by every nozzle: check it once.
    for (size_t r = 0; r < groups.front().size(); ++r)
        if (!groups.front()[r].is_collision_volume())
            test_region(0, r, groups.front()[r]);

    // Collision volumes: every group holds the same list in Shared mode. Otherwise they belong to
    // the nozzle that prints each of the object's filaments; with Bambu's automatic grouping that
    // nozzle is only known after slicing, so all of them are shown.
    std::set<size_t> extruders;
    if (groups.size() == 1 || settings.mode == BedExcludeVolumeMode::Shared) {
        extruders.insert(0);
    } else if (settings.bbl) {
        for (size_t e = 0; e < groups.size(); ++e)
            extruders.insert(e);
    } else {
        for (const ModelVolume *volume : object.volumes) {
            if (!volume->is_model_part())
                continue;
            for (int filament : volume->get_extruders()) {
                if (filament < 1)
                    continue;
                // The slice job pins the plate to automatic mapping (fmmAutoForFlush).
                const int e = bed_exclusion_extruder_for_filament(size_t(filament - 1), settings.filament_map, fmmAutoForFlush, false, true,
                                                                  groups.size());
                if (e >= 0)
                    extruders.insert(size_t(e));
            }
        }
        if (extruders.empty())
            extruders.insert(0);
    }
    for (size_t e : extruders)
        for (size_t r = 0; r < groups[e].size(); ++r)
            if (groups[e][r].is_collision_volume())
                test_region(e, r, groups[e][r]);

    return result;
}

std::vector<CheckedObject> PlacementChecker::check(CheckRequest request)
{
    JobDirGuard job_dir(make_job_dir("check"));
    settings_for(request, job_dir.path());

    for (const std::unique_ptr<CachedObject> &cached : m_objects)
        cached->used = false;

    std::vector<CheckedObject> results;
    results.reserve(request.objects.size());
    for (size_t i = 0; i < request.objects.size(); ++i) {
        MeshInput   &input  = request.objects[i];
        ModelObject *object = object_for(input, job_dir.path() + "/" + std::to_string(i + 1) + ".stl");
        results.push_back(check_object(input.name, *object));
    }

    // Keep only what this plate uses, so memory follows the plate.
    m_objects.erase(std::remove_if(m_objects.begin(), m_objects.end(), [](const std::unique_ptr<CachedObject> &cached) { return !cached->used; }),
                    m_objects.end());
    return results;
}

} // namespace muon
