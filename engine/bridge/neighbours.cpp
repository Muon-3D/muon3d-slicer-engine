#include "neighbours.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/BoundingBox.hpp>
#include <libslic3r/ClipperUtils.hpp>
#include <libslic3r/ExPolygon.hpp>
#include <libslic3r/Geometry.hpp>
#include <libslic3r/Layer.hpp>
#include <libslic3r/GCode/ConflictChecker.hpp>
#include <libslic3r/Polyline.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <optional>
#include <utility>
#include <set>

using namespace Slic3r;

namespace muon {
namespace {

constexpr double PI = 3.14159265358979323846;

double tan_degrees(double degrees) { return std::tan(std::clamp(degrees, 0., 89.9) * PI / 180.); }

double option_float(const DynamicPrintConfig &config, const char *key, double fallback = 0.)
{
    const ConfigOption *option = config.option(key);
    if (option == nullptr)
        return fallback;
    switch (option->type()) {
    case coFloat:
    case coPercent:
    case coFloatOrPercent: return option->getFloat();
    case coInt: return option->getInt();
    default: return fallback;
    }
}

// The base of an organic tree (TreeSupportSettings::bp_radius): support_tree_bp_diameter, which
// TreeSupportMeshGroupSettings never sets from the config (TreeSupportCommon.hpp).
constexpr double TREE_BASE_DIAMETER = 7.5;
// Added to the reach for what the estimate leaves out (organic smoothing, rounding).
constexpr double REACH_MARGIN = 5.;
// Added to the clearance (rounding), and the widest gap between two neighbouring copies of a dilated blocker.
constexpr double CLEARANCE_MARGIN  = 0.2;
constexpr double MAX_CLEARANCE_GAP = 1.;

// One printed instance of a ModelObject, as add_neighbour_blockers sees the plate.
struct Placed {
    ModelObject  *object   = nullptr;
    size_t        instance = 0;
    BoundingBoxf3 box; // bed coordinates, model parts only
};

bool overlaps_xy(const BoundingBoxf3 &a, double inflate, const BoundingBoxf3 &b)
{
    return a.min.x() - inflate <= b.max.x() && b.min.x() <= a.max.x() + inflate && a.min.y() - inflate <= b.max.y() &&
           b.min.y() <= a.max.y() + inflate;
}

double mm2(double scaled_area) { return scaled_area * SCALING_FACTOR * SCALING_FACTOR; }

ExPolygons translated(ExPolygons polygons, const Point &shift)
{
    for (ExPolygon &polygon : polygons)
        polygon.translate(shift);
    return polygons;
}

std::string mm_text(double value)
{
    char text[32];
    std::snprintf(text, sizeof text, "%.2f", value);
    return text;
}

} // namespace

double organic_support_reach(const DynamicPrintConfig &config, double object_height)
{
    const double height   = std::max(object_height, 0.);
    const double lean     = height * tan_degrees(option_float(config, "tree_support_branch_angle_organic", 40.));
    const double widening = height * tan_degrees(option_float(config, "tree_support_branch_diameter_angle", 5.));
    const double branch   = std::max(option_float(config, "tree_support_branch_diameter_organic", 2.), TREE_BASE_DIAMETER);
    const double xy       = std::max(option_float(config, "support_object_xy_distance", 0.35), 0.);
    const double brim     = std::max(option_float(config, "tree_support_brim_width", 0.), 0.);
    const double raft     = option_float(config, "raft_layers", 0.) > 0 ? std::max(option_float(config, "raft_first_layer_expansion", 0.), 0.) : 0.;
    return lean + widening + branch + xy + brim + raft + REACH_MARGIN;
}

double organic_support_clearance(const DynamicPrintConfig &config)
{
    const double xy        = std::max(option_float(config, "support_object_xy_distance", 0.35), 0.);
    const bool   raft      = option_float(config, "raft_layers", 0.) > 0;
    const double expansion = std::max(option_float(config, "raft_first_layer_expansion", 0.), 0.) +
                             (raft ? std::max(option_float(config, "raft_expansion", 0.), 0.) : 0.);
    return xy + expansion + CLEARANCE_MARGIN;
}

bool has_organic_supports(const DynamicPrintConfig &config, const ModelObject &object)
{
    const auto *type  = config.option<ConfigOptionEnum<SupportType>>("support_type");
    const auto *style = config.option<ConfigOptionEnum<SupportMaterialStyle>>("support_style");
    if (type == nullptr || !is_tree(type->value))
        return false;
    // SupportParameters: tree supports with style default, grid or snug are organic.
    if (style != nullptr && (style->value == smsTreeSlim || style->value == smsTreeStrong || style->value == smsTreeHybrid))
        return false;
    const auto *enable  = config.option<ConfigOptionBool>("enable_support");
    const auto *enforce = config.option<ConfigOptionInt>("enforce_support_layers");
    if ((enable != nullptr && enable->value) || (enforce != nullptr && enforce->value > 0))
        return true;
    return std::any_of(object.volumes.begin(), object.volumes.end(),
                       [](const ModelVolume *volume) { return volume->is_model_part() && !volume->supported_facets.empty(); });
}

std::vector<BlockedObject> add_neighbour_blockers(Model &model, const DynamicPrintConfig &plate_config)
{
    std::vector<BlockedObject> out;
    if (model.objects.size() < 2 && (model.objects.empty() || model.objects.front()->instances.size() < 2))
        return out;

    // The plate as it is before any blocker is added: every printed instance and each object's model parts.
    std::vector<Placed>                                    placed;
    std::map<const ModelObject *, std::vector<ModelVolume *>> parts;
    for (ModelObject *object : model.objects) {
        for (ModelVolume *volume : object->volumes)
            if (volume->is_model_part())
                parts[object].push_back(volume);
        for (size_t i = 0; i < object->instances.size(); ++i)
            if (object->instances[i]->print_volume_state == ModelInstancePVS_Inside)
                placed.push_back({object, i, object->instance_bounding_box(i, false)});
    }

    for (ModelObject *object : model.objects) {
        DynamicPrintConfig config = plate_config;
        config.apply(object->config.get(), true);
        if (!has_organic_supports(config, *object))
            continue;
        double height = 0;
        for (const Placed &p : placed)
            if (p.object == object)
                height = std::max(height, p.box.max.z() - std::max(p.box.min.z(), 0.));
        const double reach = organic_support_reach(config, height);
        // The neighbour, and copies of it moved by the clearance in evenly spread directions on the bed.
        std::vector<Vec2d> shifts{Vec2d::Zero()};
        if (const double clearance = organic_support_clearance(config); clearance > 0) {
            const int directions = std::clamp(int(std::ceil(2 * PI * clearance / MAX_CLEARANCE_GAP)), 8, 24);
            for (int k = 0; k < directions; ++k)
                shifts.emplace_back(clearance * std::cos(2 * PI * k / directions), clearance * std::sin(2 * PI * k / directions));
        }

        BlockedObject blocked{object->id().id, object->name, {}, {}};
        std::set<std::pair<const ModelObject *, size_t>> added; // (neighbour, its instance) per instance of this object
        for (const Placed &self : placed) {
            if (self.object != object)
                continue;
            const Transform3d to_object = object->instances[self.instance]->get_matrix().inverse();
            for (const Placed &other : placed) {
                if (other.object == object && other.instance == self.instance)
                    continue;
                if (!overlaps_xy(self.box, reach, other.box))
                    continue;
                const Transform3d placement = other.object->instances[other.instance]->get_matrix();
                for (const Vec2d &shift : shifts)
                    for (ModelVolume *part : parts[other.object]) {
                        ModelVolume *blocker = object->add_volume_with_shared_mesh(*part, ModelVolumeType::SUPPORT_BLOCKER);
                        blocker->set_transformation(to_object * Geometry::translation_transform(Vec3d(shift.x(), shift.y(), 0.)) * placement *
                                                    part->get_matrix());
                        blocker->name = "Muon3D neighbour " + other.object->name;
                    }
                if (added.emplace(other.object, other.instance).second &&
                    std::find(blocked.neighbour_ids.begin(), blocked.neighbour_ids.end(), other.object->id().id) == blocked.neighbour_ids.end()) {
                    blocked.neighbour_ids.push_back(other.object->id().id);
                    blocked.neighbour_names.push_back(other.object->name);
                }
            }
        }
        if (!blocked.neighbour_ids.empty())
            out.push_back(std::move(blocked));
    }
    return out;
}

// Two signs of branches Orca dropped, both only near a neighbour (over its footprint, the convex hull of its
// model parts on the bed, grown by the clearance and 2 mm), and only on objects that got neighbours:
//
//  * an overhang with no support under it. An overhang is the part of a layer's islands (lslices) farther out
//    than the lower layer's islands grown by height / tan(support_threshold_angle) (30 degrees when it is 0),
//    less the painted support blockers, opened by 0.2 mm; it is unsupported where nothing of the object's
//    support layers from top_z_distance + 3 layers below it up to its bottom comes within 1.5 mm (the
//    support's islands and extrusions), after an opening by 1 mm;
//  * support that starts in mid-air: the part of a support layer's islands that neither the support layer
//    below, nor the object's layers from the bottom gap below it up to its bottom, nor (for the roof, wider
//    than the branches under it) the object's layers from it up to top_z_distance + the interface layers + 2
//    layers above it hold up (all grown by 0.5 mm), after an opening by 0.3 mm. TreeSupport3D drops the lower
//    part of a branch it cannot route
//    (its "Potentially lost branch!" and "Influence area could not be increased!" are only printed and
//    logged) and keeps the part above, so a dropped branch shows as support that ends in mid-air.
//
// One warning per object, when at least 4 mm2 of overhang are unsupported or 1 mm2 of support starts in
// mid-air. Overhangs Orca would not have supported anyway (with no neighbour there) count too, and dropped
// branches away from every neighbour are not looked for.
std::vector<EngineWarning> find_dropped_supports(const Print &print, const std::vector<BlockedObject> &blocked)
{
    std::vector<EngineWarning> out;
    if (blocked.empty())
        return out;

    struct Footprint {
        const PrintObject   *object;
        const PrintInstance *instance;
        std::string          name;
        Polygon              hull; // bed coordinates, scaled
    };
    std::vector<Footprint> footprints;
    for (const PrintObject *object : print.objects())
        for (const PrintInstance &instance : object->instances())
            footprints.push_back({object, &instance, object->model_object()->name,
                                  object->model_object()->convex_hull_2d(instance.model_instance->get_matrix())});

    for (const PrintObject *object : print.objects()) {
        const auto it = std::find_if(blocked.begin(), blocked.end(),
                                     [object](const BlockedObject &b) { return b.object_id == object->model_object()->id().id; });
        if (it == blocked.end())
            continue;
        const PrintObjectConfig &config = object->config();
        if (!config.enable_support.value || config.support_type.value != stTreeAuto || object->layer_count() < 2)
            continue;

        // The neighbours' footprints, grown, in this object's coordinates, for each of its instances.
        DynamicPrintConfig full = print.full_print_config();
        full.apply(config, true);
        const float grown = float(scale_(organic_support_clearance(full) + 2.));
        std::vector<std::pair<std::string, Polygons>> neighbours;
        Polygons                                      near_any;
        for (const PrintInstance &self : object->instances())
            for (const Footprint &f : footprints) {
                if (f.instance == &self ||
                    std::find(it->neighbour_ids.begin(), it->neighbour_ids.end(), f.object->model_object()->id().id) == it->neighbour_ids.end())
                    continue;
                Polygon hull = f.hull;
                hull.translate(Point(-self.shift.x(), -self.shift.y()));
                neighbours.emplace_back(f.name, offset(hull, grown));
                append(near_any, neighbours.back().second);
            }
        if (neighbours.empty())
            continue;

        double                first_z     = -1;
        double                unsupported = 0, floating = 0; // mm2
        std::set<std::string> near;
        const auto            note = [&](const ExPolygons &found, double z, double &total) {
            for (const auto &[name, area_near] : neighbours) {
                const double found_mm2 = mm2(area(intersection_ex(found, area_near)));
                if (found_mm2 < 1e-6)
                    continue;
                total += found_mm2;
                near.insert(name);
                first_z = first_z < 0 ? z : std::min(first_z, z);
            }
        };

        // Overhangs with no support under them.
        std::vector<Polygons> painted;
        object->project_and_append_custom_facets(false, EnforcerBlockerType::BLOCKER, painted);
        const double threshold = config.support_threshold_angle.value > 0 ? double(config.support_threshold_angle.value) : 30.;
        const double top_gap   = config.support_top_z_distance.value;
        for (size_t l = 1; l < object->layer_count(); ++l) {
            const Layer *layer    = object->get_layer(int(l));
            const Layer *lower    = object->get_layer(int(l - 1));
            ExPolygons   overhang = diff_ex(layer->lslices, offset(lower->lslices, float(scale_(layer->height / tan_degrees(threshold)))));
            if (overhang.empty())
                continue;
            if (l < painted.size() && !painted[l].empty())
                overhang = diff_ex(overhang, offset(painted[l], float(scale_(0.5))));
            overhang = intersection_ex(opening_ex(overhang, float(scale_(0.2))), near_any);
            if (mm2(area(overhang)) < 1.)
                continue;
            Polygons     coverage;
            const double from = layer->bottom_z() - top_gap - 3 * layer->height - EPSILON;
            for (const SupportLayer *support : object->support_layers()) {
                if (support->print_z < from || support->print_z > layer->bottom_z() + EPSILON)
                    continue;
                append(coverage, offset(support->support_fills.as_polylines(), float(scale_(1.5))));
                append(coverage, offset(support->support_islands, float(scale_(1.5))));
            }
            note(opening_ex(diff_ex(overhang, union_(coverage)), float(scale_(1.))), layer->print_z, unsupported);
        }

        // Support that starts in mid-air.
        const double        bottom_gap = config.support_bottom_z_distance.value;
        const SupportLayer *below      = nullptr;
        for (const SupportLayer *support : object->support_layers()) {
            const SupportLayer *previous = std::exchange(below, support);
            if (previous == nullptr || support->support_islands.empty())
                continue;
            Polygons held = to_polygons(previous->support_islands);
            for (const Layer *layer : object->layers())
                if (layer->print_z <= support->bottom_z() + EPSILON && layer->print_z >= support->bottom_z() - bottom_gap - layer->height - EPSILON)
                    append(held, to_polygons(layer->lslices));
            // Right under the object the support is its roof (the interface and the tips), wider than the
            // branches below it: held up by them, as far as this check can tell.
            const double roof_top = support->print_z + top_gap + (config.support_interface_top_layers.value + 2) * support->height + EPSILON;
            for (const Layer *layer : object->layers())
                if (layer->bottom_z() >= support->print_z - EPSILON && layer->bottom_z() <= roof_top)
                    append(held, to_polygons(layer->lslices));
            held = offset(held, float(scale_(0.5)));
            ExPolygons unheld = opening_ex(diff_ex(support->support_islands, held), float(scale_(0.3)));
            note(unheld, support->bottom_z(), floating);
        }

        if (unsupported < 4. && floating < 1.)
            continue;
        std::string              names;
        std::vector<std::string> objects{it->name};
        for (const std::string &name : near) {
            names += (names.empty() ? "" : ", ") + ("\"" + name + "\"");
            if (name != it->name)
                objects.push_back(name);
        }
        const auto  amount = [](double mm2_total) { return "about " + std::to_string(std::max(1L, long(std::lround(mm2_total)))) + " mm2"; };
        std::string what;
        if (unsupported >= 4.)
            what = amount(unsupported) + " of overhang have no support";
        if (floating >= 1.)
            what += (what.empty() ? "" : ", and ") + amount(floating) + " of support start in mid-air";
        out.push_back({"support_dropped",
                       "Some of the tree support of \"" + it->name + "\" found no way down past " + names + ": from Z = " + mm_text(first_z) +
                           " mm, " + what + ". Move the objects apart, or change the support settings.",
                       objects});
    }
    return out;
}

ConflictResult lowest_conflict(Print &print, const ConflictResult &found)
{
    if (found._obj1 == nullptr || found._obj2 == nullptr)
        return found; // the prime tower

    // The same buckets as ConflictChecker::find_inter_of_lines_in_diff_objs, without the prime tower's.
    LinesBucketQueue queue;
    for (PrintObject *object : print.objects_mutable()) {
        ObjectExtrusions layers = getAllLayersExtrusionPathsFromObject(object);
        const auto &instances = object->instances();
        for (size_t i = 0; i < instances.size(); ++i) {
            const PrintInstance &instance = instances[i];
            if (i + 1 == instances.size()) {
                queue.emplace_back_bucket(std::move(layers.perimeters), &instance, instance.shift);
                queue.emplace_back_bucket(std::move(layers.support), &instance, instance.shift);
            } else {
                queue.emplace_back_bucket(ExtrusionLayers(layers.perimeters), &instance, instance.shift);
                queue.emplace_back_bucket(ExtrusionLayers(layers.support), &instance, instance.shift);
            }
        }
    }
    // Layer by layer from the bed, up to Orca's: the first one with a conflict.
    while (queue.valid()) {
        const LineWithIDs lines  = queue.getCurLines();
        const float       bottom = queue.getCurrBottomZ();
        if (bottom > found._height + EPSILON)
            break;
        if (const ConflictComputeOpt hit = ConflictChecker::find_inter_of_lines(lines)) {
            const auto *first  = static_cast<const PrintInstance *>(hit->_obj1);
            const auto *second = static_cast<const PrintInstance *>(hit->_obj2);
            return ConflictResult(first->print_object->model_object()->name, second->print_object->model_object()->name, bottom, first, second);
        }
    }
    return found;
}

ConflictInfo describe_conflict(const Print &print, const ConflictResult &conflict, const std::vector<float> *layer_z)
{
    ConflictInfo info;
    info.objects[0] = conflict._objName1;
    info.objects[1] = conflict._objName2;
    const auto *first  = static_cast<const PrintInstance *>(conflict._obj1); // nullptr: the wipe tower
    const auto *second = static_cast<const PrintInstance *>(conflict._obj2);

    // The layer: the one whose bottom is the conflict's height, on either object (or any object).
    const double bottom = conflict._height;
    double       z      = -1;
    const auto   find_top = [&](const PrintObject *object) {
        if (object == nullptr || z >= 0)
            return;
        for (const Layer *layer : object->layers())
            if (std::abs(layer->bottom_z() - bottom) < 1e-3) {
                z = layer->print_z;
                return;
            }
        for (const SupportLayer *layer : object->support_layers())
            if (std::abs(layer->bottom_z() - bottom) < 1e-3) {
                z = layer->print_z;
                return;
            }
    };
    find_top(first != nullptr ? first->print_object : nullptr);
    find_top(second != nullptr ? second->print_object : nullptr);
    for (const PrintObject *object : print.objects())
        find_top(object);
    if (z < 0)
        z = bottom;
    info.z = z;

    // Its index among the plate's layers: in the toolpaths' layers when there are any, else in the print's.
    std::vector<double> zs;
    if (layer_z != nullptr && !layer_z->empty()) {
        zs.assign(layer_z->begin(), layer_z->end());
    } else {
        for (const PrintObject *object : print.objects()) {
            for (const Layer *layer : object->layers())
                zs.push_back(layer->print_z);
            for (const SupportLayer *layer : object->support_layers())
                zs.push_back(layer->print_z);
        }
        std::sort(zs.begin(), zs.end());
        zs.erase(std::unique(zs.begin(), zs.end(), [](double a, double b) { return std::abs(a - b) < EPSILON; }), zs.end());
    }
    info.layer = int(std::lower_bound(zs.begin(), zs.end(), z - 2e-3) - zs.begin());
    if (info.layer >= int(zs.size()) && !zs.empty())
        info.layer = int(zs.size()) - 1;

    // Whose support hit the other: the length of each one's support extrusions on that layer inside the
    // other's outline (both in bed coordinates).
    const auto hit = [z, bottom](const PrintInstance *support, const PrintInstance *other) -> double {
        if (support == nullptr || other == nullptr)
            return 0;
        Polylines lines;
        for (const SupportLayer *layer : support->print_object->support_layers())
            if (layer->print_z > bottom + EPSILON && layer->bottom_z() < z - EPSILON) {
                Polylines polylines = layer->support_fills.as_polylines();
                for (Polyline &polyline : polylines)
                    polyline.translate(support->shift);
                append(lines, std::move(polylines));
            }
        ExPolygons outline;
        for (const Layer *layer : other->print_object->layers())
            if (layer->print_z > bottom + EPSILON && layer->bottom_z() < z - EPSILON)
                append(outline, translated(layer->lslices, other->shift));
        if (lines.empty() || outline.empty())
            return 0;
        double length = 0;
        for (const Polyline &inside : intersection_pl(lines, outline))
            length += inside.length();
        return unscale<double>(length);
    };
    const double first_hits  = hit(first, second);
    const double second_hits = hit(second, first);
    constexpr double MIN_HIT = 0.01; // mm, Orca's own threshold for a crossing (ConflictChecker::line_intersect)
    if (first_hits > MIN_HIT || second_hits > MIN_HIT)
        info.support_of = first_hits >= second_hits ? info.objects[0] : info.objects[1];
    return info;
}

} // namespace muon
