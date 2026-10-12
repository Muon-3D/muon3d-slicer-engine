// "Before you print" checks (KAN-528); see print_checks.hpp and docs/print-checks.md.

// The patched copy of Orca's header, with the stability search turned on (engine/cmake/OrcaSourcePatches.cmake).
// It comes first: the original is reached through GCode.hpp (GCode/ExtrusionProcessor.hpp) with the same
// include guard, and would hide full_search and gather_issues.
#include "Support/SupportSpotsGenerator.hpp"

#include "print_checks.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/BoundingBox.hpp>
#include <libslic3r/ClipperUtils.hpp>
#include <libslic3r/ExPolygon.hpp>
#include <libslic3r/Flow.hpp>
#include <libslic3r/GCode/GCodeProcessor.hpp>
#include <libslic3r/Layer.hpp>
#include <libslic3r/Print.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <map>
#include <string>
#include <utility>

namespace muon {

using namespace Slic3r;
namespace SSG = Slic3r::SupportSpotsGenerator;

namespace {

// Issues of one kind on one object: nearby ones are merged and at most this many are kept.
constexpr size_t MAX_PER_KIND        = 12;
constexpr float  MERGE_DISTANCE_MM   = 10.f;
constexpr float  MERGE_HEIGHT_MM     = 5.f;
constexpr size_t MAX_RUNS_PER_OBJECT = 6;

// Material data for the heuristics (docs/print-checks.md, "Material table"): linear shrinkage after cooling (%),
// the temperature where the polymer stops flowing and starts to hold stress (glass transition; for the
// semi-crystalline PP and PA a softening point instead) in degrees C, and Young's modulus of a printed part in MPa.
struct Material {
    const char *type;
    float       shrink_pct;
    float       stress_free_c;
    float       modulus_mpa;
};
const Material MATERIALS[] = {
    {"PLA", 0.3f, 60.f, 3500.f},  {"PETG", 0.4f, 80.f, 2100.f}, {"PET", 0.4f, 80.f, 2100.f},  {"PCTG", 0.4f, 85.f, 1900.f},
    {"ABS", 0.7f, 105.f, 2200.f}, {"ASA", 0.6f, 100.f, 2000.f}, {"HIPS", 0.6f, 100.f, 1900.f}, {"PC", 0.7f, 147.f, 2300.f},
    {"PA", 1.2f, 70.f, 1500.f},   {"PP", 1.5f, 100.f, 1300.f},  {"TPU", 0.5f, 60.f, 30.f},     {"PVA", 0.5f, 75.f, 2000.f},
};

// The table entry for an Orca filament_type ("PLA", "PLA-CF", "PA6-GF", "ABS+"...): the longest name it starts with.
const Material &material_of(const std::string &filament_type)
{
    const Material *best = &MATERIALS[0];
    size_t          best_len = 0;
    for (const Material &m : MATERIALS) {
        const size_t len = std::char_traits<char>::length(m.type);
        if (len > best_len && filament_type.compare(0, len, m.type) == 0) {
            best     = &m;
            best_len = len;
        }
    }
    return *best;
}

std::string filament_type_of(const Print &print)
{
    const auto &types = print.config().filament_type.values;
    return types.empty() || types.front().empty() ? std::string("PLA") : types.front();
}

std::string fixed(double value, int decimals)
{
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.*f", decimals, value);
    return buf;
}

// Object coordinates (Orca's layers) -> bed coordinates, through the object's first instance.
Vec2d to_bed(const PrintObject &object, const Vec2d &local_mm)
{
    const Point shift = object.instances().empty() ? Point(0, 0) : object.instances().front().shift;
    return local_mm + unscaled(shift);
}

PrintCheck make_check(const PrintObject &object, const char *kind, const char *severity, const char *fix, const Vec2d &local_mm,
                      double z, std::string message, double value = std::numeric_limits<double>::quiet_NaN())
{
    PrintCheck check;
    check.kind     = kind;
    check.severity = severity;
    check.fix      = fix;
    check.object   = object.model_object() ? object.model_object()->name : std::string();
    const Vec2d bed = to_bed(object, local_mm);
    check.x         = float(bed.x());
    check.y         = float(bed.y());
    check.z         = float(z);
    check.message   = std::move(message);
    check.value     = float(value);
    return check;
}

// Issues about a whole part (it comes loose, it cracks): the search finds them again on the layers above while the
// part grows, so they merge at any height.
bool whole_part(const std::string &kind) { return kind == "unstable-part" || kind == "weak-connection"; }

// Adds `check` unless one of its kind on its object is within MERGE_DISTANCE_MM / MERGE_HEIGHT_MM (the kept one
// is the lower; the support search walks up, so it is the first) or MAX_PER_KIND of them are already kept.
void add_merged(std::vector<PrintCheck> &out, PrintCheck check)
{
    size_t same = 0;
    for (const PrintCheck &c : out) {
        if (c.kind != check.kind || c.object != check.object)
            continue;
        ++same;
        if (std::hypot(c.x - check.x, c.y - check.y) < MERGE_DISTANCE_MM && (whole_part(c.kind) || std::abs(c.z - check.z) < MERGE_HEIGHT_MM))
            return;
    }
    if (same < MAX_PER_KIND)
        out.push_back(std::move(check));
}

// The layer whose bottom is at `bottom_z` (the support search's point height): its print_z.
double print_z_at(const PrintObject &object, float bottom_z)
{
    double best = bottom_z, best_d = std::numeric_limits<double>::max();
    for (const Layer *layer : object.layers()) {
        const double d = std::abs(layer->bottom_z() - bottom_z);
        if (d < best_d) {
            best_d = d;
            best   = layer->print_z;
        }
    }
    return best;
}

// ---- Orca's stability and support-issue search (SupportSpotsGenerator) ---------------------------------------

struct CauseInfo {
    const char *kind;
    const char *fix;
    const char *message;
};

CauseInfo cause_info(SSG::SupportPointCause cause)
{
    switch (cause) {
    case SSG::SupportPointCause::LongBridge: return {"long-bridge", "supports", "Bridge longer than 16 mm may sag"};
    case SSG::SupportPointCause::FloatingBridgeAnchor: return {"floating-extrusion", "supports", "Bridge anchored in mid-air"};
    case SSG::SupportPointCause::FloatingExtrusion: return {"floating-extrusion", "supports", "Extrusion printed in mid-air"};
    case SSG::SupportPointCause::SeparationFromBed: return {"unstable-part", "contact-area", "Part may come loose from the bed"};
    case SSG::SupportPointCause::UnstableFloatingPart: return {"unstable-part", "supports", "Part may tip over or break off"};
    case SSG::SupportPointCause::WeakObjectPart: return {"weak-connection", "orientation", "Weak connection may snap"};
    }
    return {"unstable-part", "supports", "Unstable part"};
}

void stability_checks(PrintObject &object, std::vector<PrintCheck> &out)
{
    if (object.layers().empty())
        return;
    // Orca's own parameters, as PrintObject::estimate_curled_extrusions() builds them. Their defaults are the
    // nozzle forces: standard_extruder_conflict_force 10 gf, malformations_additive_conflict_extruder_force
    // 65 gf over curled areas, and a 16 mm bridge_distance.
    const SSG::Params params{object.print()->config().filament_type.values, object.config().raft_layers.getInt(),
                             object.config().brim_type.value, float(object.config().brim_width.getFloat())};
    // The curled areas (Layer::curled_lines) the search reads. Orca only estimates them when a region slows
    // down for overhangs; run after the export, so the G-code is the same either way.
    SSG::estimate_malformations(object.layers(), params);

    auto [points, partial_objects] = SSG::full_search(&object, [&object] { if (object.print()->canceled()) throw Slic3r::CanceledException(); }, params);
    // Which causes are worth telling, and which are critical (PrusaSlicer's alert rules).
    std::map<SSG::SupportPointCause, bool> reported;
    for (const auto &[cause, critical] : SSG::gather_issues(points, partial_objects))
        reported[cause] = reported[cause] || critical;

    for (const SSG::SupportPoint &point : points) {
        const CauseInfo info     = cause_info(point.cause);
        const auto      it       = reported.find(point.cause);
        const char     *severity = it == reported.end() ? "info" : it->second ? "critical" : "warning";
        // The force is the destabilising force in g*mm/s^2 (global points only); shown in grams-force.
        const double gf = point.is_global_object_support() ? point.force / params.gravity_constant : std::numeric_limits<double>::quiet_NaN();
        add_merged(out, make_check(object, info.kind, severity, info.fix, point.position.head<2>().cast<double>(),
                                   print_z_at(object, point.position.z()), info.message, gf));
    }
    for (const SSG::PartialObject &part : partial_objects)
        if (!part.connected_to_bed)
            add_merged(out, make_check(object, "unstable-part", "critical", "supports", part.centroid.head<2>().cast<double>(),
                                       print_z_at(object, part.centroid.z()), "Part has nothing under it", part.volume));
}

// ---- Curled overhangs (SupportSpotsGenerator::estimate_malformations) -----------------------------------------

void curl_checks(const PrintObject &object, std::vector<PrintCheck> &out)
{
    // Runs of layers whose perimeters curl up by more than a layer: one issue each, at the highest curl.
    struct Run {
        double height = 0, z = 0;
        Vec2d  at     = Vec2d::Zero();
    };
    std::vector<Run> runs;
    bool             open = false;
    for (const Layer *layer : object.layers()) {
        float      max_h = 0.f;
        const Line *line = nullptr;
        for (const CurledLine &l : layer->curled_lines)
            if (l.curled_height > max_h) {
                max_h = l.curled_height;
                line  = &l;
            }
        if (line == nullptr || max_h < layer->height) {
            open = false;
            continue;
        }
        if (!open) {
            runs.emplace_back();
            open = true;
        }
        Run &run = runs.back();
        if (max_h > run.height) {
            run.height = max_h;
            run.z      = layer->print_z;
            run.at     = unscaled(line->midpoint());
        }
    }
    std::sort(runs.begin(), runs.end(), [](const Run &a, const Run &b) { return a.height > b.height; });
    if (runs.size() > MAX_RUNS_PER_OBJECT)
        runs.resize(MAX_RUNS_PER_OBJECT);
    const double layer_height = object.config().layer_height.value;
    for (const Run &run : runs)
        out.push_back(make_check(object, "curled-overhang", run.height >= 3 * layer_height ? "warning" : "info", "slower-outer-walls", run.at,
                                 run.z, "Overhang may curl up " + fixed(run.height, 1) + " mm", run.height));
}

// ---- Warp risk per first-layer island ------------------------------------------------------------------------

// The sharpest convex corner of the outline: its turning angle (0 straight on, pi a knife edge). Facets of a
// round outline turn by a few degrees each and are skipped; the outline is simplified first for the same reason.
double sharpest_corner(const Polygon &contour)
{
    Polygon simple = contour;
    simple.douglas_peucker(scaled<double>(0.2));
    const Points &p = simple.points;
    const size_t  n = p.size();
    double        sharpest = 0.;
    if (n < 3)
        return sharpest;
    const bool ccw = simple.is_counter_clockwise();
    for (size_t i = 0; i < n; ++i) {
        const Vec2d a = (p[i] - p[(i + n - 1) % n]).cast<double>(), b = (p[(i + 1) % n] - p[i]).cast<double>();
        if (a.squaredNorm() == 0. || b.squaredNorm() == 0.)
            continue;
        const double cross = a.x() * b.y() - a.y() * b.x();
        if ((cross > 0) != ccw)
            continue; // a concave corner
        const double turn = std::atan2(std::abs(cross), a.dot(b));
        if (turn > M_PI / 6)
            sharpest = std::max(sharpest, turn);
    }
    return sharpest;
}

void warp_checks(const PrintObject &object, std::vector<PrintCheck> &out)
{
    if (object.layers().empty())
        return;
    const Print    &print    = *object.print();
    const Material &material = material_of(filament_type_of(print));
    // Orca's own shrinkage (Filament > Shrinkage XY, "94 %" for parts 6 % small) wins over the table when set.
    const double orca_shrink = print.config().filament_shrink.values.empty() ? 100. : print.config().filament_shrink.get_at(0);
    const double shrink_pct  = orca_shrink < 100. ? 100. - orca_shrink : material.shrink_pct;
    const double chamber_c   = std::max(25., print.config().chamber_temperature.values.empty() ? 0. : double(print.config().chamber_temperature.get_at(0)));
    // The stress a cooling part holds builds up from where the polymer stops flowing down to the chamber.
    const double chamber_factor = std::clamp((material.stress_free_c - chamber_c) / (material.stress_free_c - 25.), 0.1, 1.);
    const double brim_mm  = object.config().brim_type.value == btNoBrim ? 0. :
                            object.config().brim_type.value == btAutoBrim ? 0. : object.config().brim_width.getFloat();
    const double brim_factor = 1. / (1. + brim_mm / 5.);
    const double raft_factor = object.config().raft_layers.getInt() > 0 ? 0.5 : 1.;
    const Layer *first = object.layers().front();
    for (const ExPolygon &island : first->lslices) {
        const BoundingBox bb     = get_extents(island.contour);
        const double      length = unscaled(bb.size()).norm();
        const double      corner = 1. + sharpest_corner(island.contour) / M_PI;
        const double      score  = length * shrink_pct * corner * chamber_factor * brim_factor * raft_factor / 60.;
        if (score < 1.)
            continue;
        const Point c = island.contour.centroid();
        out.push_back(make_check(object, "warp-risk", score >= 2.5 ? "critical" : "warning", "brim", unscaled(c), first->print_z,
                                 "Corners may lift (warp risk " + fixed(score, 1) + ")", score));
    }
}

// ---- Slenderness against the nozzle force ---------------------------------------------------------------------

struct SectionProps {
    double area = 0, i_min = 0;
    Vec2d  centroid = Vec2d::Zero();
};

// Area, centroid and the smaller principal second moment of area (mm^4) of an island, holes included.
SectionProps section_props(const ExPolygon &island)
{
    double a = 0, sx = 0, sy = 0, ixx = 0, iyy = 0, ixy = 0;
    auto add = [&](const Polygon &poly) {
        const Points &p = poly.points;
        for (size_t i = 0, n = p.size(); i < n; ++i) {
            const Vec2d  p0 = unscaled(p[i]), p1 = unscaled(p[(i + 1) % n]);
            const double c  = p0.x() * p1.y() - p1.x() * p0.y();
            a += c;
            sx += (p0.x() + p1.x()) * c;
            sy += (p0.y() + p1.y()) * c;
            ixx += (p0.y() * p0.y() + p0.y() * p1.y() + p1.y() * p1.y()) * c;
            iyy += (p0.x() * p0.x() + p0.x() * p1.x() + p1.x() * p1.x()) * c;
            ixy += (p0.x() * p1.y() + 2 * p0.x() * p0.y() + 2 * p1.x() * p1.y() + p1.x() * p0.y()) * c;
        }
    };
    add(island.contour); // counter-clockwise: positive
    for (const Polygon &hole : island.holes)
        add(hole);       // clockwise: subtracted
    SectionProps out;
    a /= 2.;
    if (a <= 0.)
        return out;
    out.area     = a;
    out.centroid = Vec2d(sx / (6. * a), sy / (6. * a));
    ixx = ixx / 12. - a * out.centroid.y() * out.centroid.y();
    iyy = iyy / 12. - a * out.centroid.x() * out.centroid.x();
    ixy = ixy / 24. - a * out.centroid.x() * out.centroid.y();
    out.i_min = std::max(0., (ixx + iyy) / 2. - std::sqrt((ixx - iyy) * (ixx - iyy) / 4. + ixy * ixy));
    return out;
}

void slenderness_checks(const PrintObject &object, double nozzle_force_n, std::vector<PrintCheck> &out)
{
    const Material &material = material_of(filament_type_of(*object.print()));
    // Per layer: the main island's section (the largest), at the layer's mid-height.
    struct Slice {
        double z_mid, top, height, i_min;
        Vec2d  centroid;
    };
    std::vector<Slice> slices;
    for (const Layer *layer : object.layers()) {
        const ExPolygon *main = nullptr;
        double           best = 0;
        for (const ExPolygon &island : layer->lslices)
            if (double area = island.area(); area > best) {
                best = area;
                main = &island;
            }
        if (main == nullptr)
            continue;
        const SectionProps props = section_props(*main);
        if (props.i_min <= 0.)
            continue;
        slices.push_back({layer->print_z - layer->height / 2., layer->print_z, layer->height, props.i_min, props.centroid});
    }
    // A cantilever fixed to the bed, pushed sideways at the layer being printed: its deflection there is
    // the integral of F (h - z)^2 / (E I(z)) dz over the part below.
    double worst = 0;
    size_t worst_i = 0;
    for (size_t i = 0; i < slices.size(); ++i) {
        const double h = slices[i].top;
        double       d = 0;
        for (size_t j = 0; j <= i; ++j)
            d += (h - slices[j].z_mid) * (h - slices[j].z_mid) * slices[j].height / slices[j].i_min;
        d *= nozzle_force_n / material.modulus_mpa;
        if (d > worst) {
            worst   = d;
            worst_i = i;
        }
    }
    if (worst < 0.1)
        return;
    const Slice &s = slices[worst_i];
    out.push_back(make_check(object, "slender", worst >= 0.4 ? "critical" : "warning", "orientation", s.centroid, s.top,
                             "Tall thin part may bend " + fixed(worst, 2) + " mm under the nozzle", worst));
}

// ---- Thin features under two lines ----------------------------------------------------------------------------

void thin_checks(const PrintObject &object, std::vector<PrintCheck> &out)
{
    struct Run {
        bool   under_one = false;
        double z = 0, area = 0;
        size_t layers = 0;
        Vec2d  at = Vec2d::Zero();
    };
    std::vector<Run> runs;
    bool             open = false;
    for (const Layer *layer : object.layers()) {
        if (layer->regions().empty() || layer->lslices.empty()) {
            open = false;
            continue;
        }
        const double w = layer->regions().front()->flow(frExternalPerimeter).width();
        // Parts narrower than 2 lines are what an opening by one line width removes; the corners it rounds off
        // are small slivers, which the area limit leaves out.
        const double     min_area = 3. * w * w;
        const ExPolygons two      = diff_ex(layer->lslices, opening_ex(layer->lslices, float(scaled(0.98 * w))));
        const ExPolygon *largest  = nullptr;
        double           area     = 0;
        for (const ExPolygon &piece : two)
            if (double a = unscaled(unscaled(piece.area())); a >= min_area && a > area) {
                area    = a;
                largest = &piece;
            }
        if (largest == nullptr) {
            open = false;
            continue;
        }
        bool under_one = false;
        for (const ExPolygon &piece : diff_ex(layer->lslices, opening_ex(layer->lslices, float(scaled(0.49 * w)))))
            under_one = under_one || unscaled(unscaled(piece.area())) >= min_area / 2.;
        if (!open) {
            runs.push_back({under_one, layer->print_z, area, 0, unscaled(largest->contour.centroid())});
            open = true;
        }
        Run &run = runs.back();
        ++run.layers;
        run.under_one = run.under_one || under_one;
    }
    std::sort(runs.begin(), runs.end(), [](const Run &a, const Run &b) { return a.layers > b.layers; });
    if (runs.size() > MAX_RUNS_PER_OBJECT)
        runs.resize(MAX_RUNS_PER_OBJECT);
    for (const Run &run : runs)
        out.push_back(make_check(object, "thin-feature", run.under_one ? "warning" : "info", "orientation", run.at, run.z,
                                 run.under_one ? "Feature thinner than one line may not print" : "Feature thinner than two lines",
                                 double(run.layers)));
}

// ---- Layer-time bond index ------------------------------------------------------------------------------------

struct GcodeLayer {
    double time = 0, z = std::numeric_limits<double>::quiet_NaN();
    Vec2d  min = Vec2d::Constant(std::numeric_limits<double>::max()), max = Vec2d::Constant(std::numeric_limits<double>::lowest());
    bool   printed() const { return !std::isnan(z); }
};

// The G-code's layers as the preview numbers them (toolpaths.cpp): time, height and extent of each.
std::vector<GcodeLayer> gcode_layers(const GCodeProcessorResult &gcode)
{
    const auto &moves = gcode.moves;
    uint32_t    count = 0;
    for (const auto &move : moves)
        count = std::max(count, move.layer_id + 1);
    std::vector<GcodeLayer> layers(count);
    uint32_t current = 0;
    for (size_t i = 0; i < moves.size(); ++i) {
        const auto    &move  = moves[i];
        const uint32_t layer = count == 0 ? 0 : std::max(current, std::min(move.layer_id, count - 1));
        current              = layer;
        GcodeLayer &l        = layers[layer];
        l.time += move.time[0];
        if (move.type == EMoveType::Extrude && i > 0 && move.position != moves[i - 1].position && move.extrusion_role != erCustom) {
            l.z   = std::isnan(l.z) ? move.position.z() : std::max(l.z, double(move.position.z()));
            l.min = l.min.cwiseMin(move.position.head<2>().cast<double>());
            l.max = l.max.cwiseMax(move.position.head<2>().cast<double>());
        }
    }
    return layers;
}

void layer_time_checks(const Print &print, const std::vector<GcodeLayer> &layers, std::vector<PrintCheck> &out)
{
    const auto &mins = print.config().slow_down_layer_time.values;
    const double t_min = mins.empty() ? 0. : mins.front();
    if (t_min <= 0. || print.objects().empty())
        return;
    const Material &material = material_of(filament_type_of(print));
    // Long layer times weaken the bond only where it matters: materials printed hot and warm (ABS, ASA, PC, PA...).
    const bool cools_badly = material.stress_free_c >= 100.f || std::string(material.type) == "PA";
    const PrintObject &object = *print.objects().front();
    struct Run {
        bool   fast;
        size_t first, count = 0;
        double index;
    };
    std::vector<Run> runs;
    for (size_t i = 0; i < layers.size(); ++i) {
        const GcodeLayer &l = layers[i];
        if (!l.printed() || l.time <= 0.) {
            continue;
        }
        const double index = l.time / t_min;
        const bool   fast = index < 1., slow = cools_badly && index > 30.;
        if (!fast && !slow)
            continue;
        if (runs.empty() || runs.back().fast != fast || runs.back().first + runs.back().count != i)
            runs.push_back({fast, i, 0, index});
        Run &run = runs.back();
        ++run.count;
        run.index = fast ? std::min(run.index, index) : std::max(run.index, index);
    }
    std::sort(runs.begin(), runs.end(), [](const Run &a, const Run &b) { return a.count > b.count; });
    if (runs.size() > MAX_RUNS_PER_OBJECT)
        runs.resize(MAX_RUNS_PER_OBJECT);
    for (const Run &run : runs) {
        const GcodeLayer &l      = layers[run.first];
        const Vec2d       centre = (l.min + l.max) / 2.;
        PrintCheck        check  = make_check(object, "layer-time", run.fast ? (run.index < 0.5 ? "warning" : "info") : "info", "slower-outer-walls",
                                              Vec2d::Zero(), l.z,
                                              run.fast ? "Layers too quick to cool (" + fixed(run.index * t_min, 1) + " s, needs " + fixed(t_min, 0) + " s)" :
                                                         "Long layers cool before the next: weaker bond",
                                              run.index);
        // Already in bed coordinates (the G-code's).
        check.x      = float(centre.x());
        check.y      = float(centre.y());
        check.object = print.objects().size() == 1 ? check.object : std::string();
        check.layer  = int(run.first);
        out.push_back(std::move(check));
    }
}

int severity_rank(const std::string &severity) { return severity == "critical" ? 0 : severity == "warning" ? 1 : 2; }

} // namespace

std::vector<PrintCheck> run_print_checks(Print &print, const GCodeProcessorResult &gcode)
{
    std::vector<PrintCheck> out;
    for (PrintObject *object : print.objects_mutable()) {
        if (print.canceled()) throw Slic3r::CanceledException();
        stability_checks(*object, out);
        curl_checks(*object, out);
        warp_checks(*object, out);
        // The nozzle force of the stability search (10 gf): g*mm/s^2 -> N.
        const SSG::Params params{print.config().filament_type.values, 0, btNoBrim, 0.f};
        slenderness_checks(*object, params.standard_extruder_conflict_force * 1e-6, out);
        thin_checks(*object, out);
    }

    const std::vector<GcodeLayer> layers = gcode_layers(gcode);
    layer_time_checks(print, layers, out);

    // Each issue's layer: the printed G-code layer at its height.
    std::vector<std::pair<double, int>> zs;
    for (size_t i = 0; i < layers.size(); ++i)
        if (layers[i].printed())
            zs.emplace_back(layers[i].z, int(i));
    std::sort(zs.begin(), zs.end());
    for (PrintCheck &check : out) {
        if (check.layer >= 0 || zs.empty())
            continue;
        auto it = std::lower_bound(zs.begin(), zs.end(), std::make_pair(double(check.z) - 1e-3, std::numeric_limits<int>::min()));
        if (it == zs.end())
            --it;
        else if (it != zs.begin() && std::abs(std::prev(it)->first - check.z) < std::abs(it->first - check.z))
            --it;
        check.layer = it->second;
    }
    std::stable_sort(out.begin(), out.end(), [](const PrintCheck &a, const PrintCheck &b) {
        const int ra = severity_rank(a.severity), rb = severity_rank(b.severity);
        return ra != rb ? ra < rb : a.layer < b.layer;
    });
    return out;
}

} // namespace muon
