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

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <map>
#include <stdexcept>
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

// The search's filament density (SupportSpotsGenerator::Params::filament_density), g/mm^3.
constexpr double FILAMENT_DENSITY = 1.25e-3;
constexpr double STANDARD_GRAVITY = 9.80665; // m/s^2

// ---- Gravity: the per-printer table (docs/print-checks.md, "Gravity") ----------------------------------------
//
// In the slicer's frame layers stack along +Z. On an upright printer gravity points against that (down, onto the
// bed); on one that prints hanging from the bed, as the Muon3D M1 does, it points along it. The printer preset's
// "gravity" picks the row; the thresholds that depend on it are the row's.
struct GravityRow {
    Gravity gravity;
    float   overhang_deg; // steepest overhang printed without supports, from vertical
    float   bridge_mm;    // longest bridge (the search's bridge_distance)
    float   curl_factor;  // the estimated curl times this: gravity's share of an edge lifting towards the nozzle
    float   curl_layers;  // a curl is reported from this many layer heights
    float   roof_fuse_mm; // a one-layer roof over a gap under this fuses with the part beneath
    bool    calibrated;   // false: provisional, "to calibrate on M1 prints"
};
const GravityRow GRAVITY_ROWS[] = {
    // Upright: the usual defaults (PrusaSlicer/Orca's 45 degrees and 16 mm, the search's curl rule, the common
    // print-in-place clearance). Their sources are in docs/print-checks.md.
    {Gravity::AgainstBuild, 45.f, 16.f, 1.0f, 1.0f, 0.2f, true},
    // Hanging (M1): provisional, to calibrate on M1 prints. Sag goes towards the nozzle, so tighter.
    {Gravity::AlongBuild, 35.f, 10.f, 1.5f, 0.5f, 0.1f, false},
};
const GravityRow &row_of(Gravity gravity) { return gravity == Gravity::AlongBuild ? GRAVITY_ROWS[1] : GRAVITY_ROWS[0]; }
bool along(const GravityRow &row) { return row.gravity == Gravity::AlongBuild; }
// The note a provisional threshold's message carries.
std::string provisional(const GravityRow &row) { return row.calibrated ? std::string() : std::string(" (M1 threshold, to calibrate)"); }

// Hanging parts (gravity along the build direction), provisional, to calibrate on M1 prints: the sideways load a
// hanging part takes from the moves (fraction of its weight), the stress at which a warm section or the bed
// interface is at risk (MPa), and the weight per area of first layer that doubles the warp score (MPa).
constexpr double HANG_SWAY      = 0.1;
constexpr double HANG_REF_MPA   = 0.1;
constexpr double PEEL_REF_MPA   = 0.01;

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

// The part's mass over each layer: Orca's islands times the layer height, at the search's density (g).
double layer_mass(const Layer &layer)
{
    double area = 0;
    for (const ExPolygon &island : layer.lslices)
        area += unscaled(unscaled(island.area()));
    return area * layer.height * FILAMENT_DENSITY;
}

// ---- Orca's stability and support-issue search (SupportSpotsGenerator) ---------------------------------------

struct CauseInfo {
    const char *kind;
    const char *fix;
    std::string message;
};

CauseInfo cause_info(SSG::SupportPointCause cause, const GravityRow &row)
{
    switch (cause) {
    case SSG::SupportPointCause::LongBridge:
        return {"long-bridge", "supports",
                "Bridge longer than " + fixed(row.bridge_mm, 0) + " mm may sag" + (along(row) ? " towards the nozzle" : "") + provisional(row)};
    case SSG::SupportPointCause::FloatingBridgeAnchor: return {"floating-extrusion", "supports", "Bridge anchored in mid-air"};
    case SSG::SupportPointCause::FloatingExtrusion: return {"floating-extrusion", "supports", "Extrusion printed in mid-air"};
    case SSG::SupportPointCause::SeparationFromBed: return {"unstable-part", "contact-area", "Part may come loose from the bed"};
    case SSG::SupportPointCause::UnstableFloatingPart: return {"unstable-part", "supports", "Part may tip over or break off"};
    case SSG::SupportPointCause::WeakObjectPart: return {"weak-connection", "orientation", "Weak connection may snap"};
    }
    return {"unstable-part", "supports", "Unstable part"};
}

// The causes supports fix: PrusaSlicer only reports them while supports are off.
bool support_fixable(SSG::SupportPointCause cause)
{
    return cause == SSG::SupportPointCause::LongBridge || cause == SSG::SupportPointCause::FloatingBridgeAnchor ||
           cause == SSG::SupportPointCause::FloatingExtrusion || cause == SSG::SupportPointCause::UnstableFloatingPart;
}

// The printer's gravity for the search (engine patch 2), for as long as it runs on this thread.
struct GravityScope {
    explicit GravityScope(const GravityRow &row) { SSG::set_engine_gravity({along(row), row.bridge_mm}); }
    ~GravityScope() { SSG::set_engine_gravity({}); }
    GravityScope(const GravityScope &)            = delete;
    GravityScope &operator=(const GravityScope &) = delete;
};

// With gravity along the build direction supports hold an overhang in tension, by what sticks at the interface,
// not by pushing it up. A gap between them, no interface layers or a sparse interface leave little to stick:
// one issue per object, at the lowest point the supports hold (provisional rule, to calibrate on M1 prints).
void support_interface_check(const PrintObject &object, const Vec3f &lowest, size_t held, std::vector<PrintCheck> &out)
{
    const PrintObjectConfig &c       = object.config();
    const double             gap     = c.support_top_z_distance.value;
    const double             layer_h = c.layer_height.value;
    const double             line    = object.layers().empty() || object.layers().front()->regions().empty() ?
                                           0.45 :
                                           object.layers().front()->regions().front()->flow(frExternalPerimeter).width();
    const char *severity = nullptr;
    std::string why;
    if (gap >= 0.5 * layer_h) {
        severity = gap >= layer_h ? "critical" : "warning";
        why      = "across a " + fixed(gap, 2) + " mm gap";
    } else if (c.support_interface_top_layers.value <= 0) {
        severity = "warning";
        why      = "with no interface layers";
    } else if (c.support_interface_spacing.value > line) {
        severity = "warning";
        why      = "on a sparse interface";
    }
    if (severity == nullptr)
        return;
    out.push_back(make_check(object, "weak-support-interface", severity, "support-interface", lowest.head<2>().cast<double>(),
                             print_z_at(object, lowest.z()), "Supports hold this overhang by sticking only, " + why + " (to calibrate)",
                             double(held)));
}

void stability_checks(PrintObject &object, const GravityRow &row, std::vector<PrintCheck> &out)
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

    auto [points, partial_objects] = [&] {
        GravityScope gravity(row);
        return SSG::full_search(&object, [&object] { if (object.print()->canceled()) throw Slic3r::CanceledException(); }, params);
    }();
    const bool supported = object.config().enable_support.value;
    // Which causes are worth telling, and which are critical (PrusaSlicer's alert rules).
    std::map<SSG::SupportPointCause, bool> reported;
    for (const auto &[cause, critical] : SSG::gather_issues(points, partial_objects))
        reported[cause] = reported[cause] || critical;

    // With supports on, what they fix is not reported (as in PrusaSlicer); hanging, what holds it is checked.
    size_t held = 0;
    Vec3f  lowest(0.f, 0.f, std::numeric_limits<float>::max());
    for (const SSG::SupportPoint &point : points) {
        if (supported && support_fixable(point.cause)) {
            ++held;
            if (point.position.z() < lowest.z())
                lowest = point.position;
            continue;
        }
        const CauseInfo info     = cause_info(point.cause, row);
        const auto      it       = reported.find(point.cause);
        const char     *severity = it == reported.end() ? "info" : it->second ? "critical" : "warning";
        // The force is the destabilising force in g*mm/s^2 (global points only); shown in grams-force.
        const double gf = point.is_global_object_support() ? point.force / params.gravity_constant : std::numeric_limits<double>::quiet_NaN();
        add_merged(out, make_check(object, info.kind, severity, info.fix, point.position.head<2>().cast<double>(),
                                   print_z_at(object, point.position.z()), info.message, gf));
    }
    for (const SSG::PartialObject &part : partial_objects)
        if (!part.connected_to_bed && !supported)
            add_merged(out, make_check(object, "unstable-part", "critical", "supports", part.centroid.head<2>().cast<double>(),
                                       print_z_at(object, part.centroid.z()), "Part has nothing under it", part.volume));
    if (supported && held > 0 && along(row))
        support_interface_check(object, lowest, held, out);
}

// ---- Curled overhangs (SupportSpotsGenerator::estimate_malformations) -----------------------------------------

void curl_checks(const PrintObject &object, const GravityRow &row, std::vector<PrintCheck> &out)
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
            if (l.curled_height * row.curl_factor > max_h) {
                max_h = l.curled_height * row.curl_factor;
                line  = &l;
            }
        if (line == nullptr || max_h < row.curl_layers * layer->height) {
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
    // Orca's "Slow down for curled perimeters" already slows these lines (the same estimate drives it): what is
    // left is worth knowing, not fixing. The estimate is geometric, so slowing down does not change it.
    bool slowed = false;
    if (!object.layers().empty() && !object.layers().front()->regions().empty()) {
        const auto &opt = object.layers().front()->regions().front()->region().config().slowdown_for_curled_perimeters;
        slowed          = !opt.values.empty() && opt.values.front() == 1;
    }
    const std::string towards = along(row) ? " towards the nozzle" : "";
    for (const Run &run : runs)
        out.push_back(make_check(object, "curled-overhang", !slowed && run.height >= 3 * layer_height ? "warning" : "info", "slower-outer-walls",
                                 run.at, run.z,
                                 "Overhang may curl up " + fixed(run.height, 1) + " mm" + towards + (slowed ? ", slowed down there" : "") +
                                     provisional(row),
                                 run.height));
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

void warp_checks(const PrintObject &object, const GravityRow &row, std::vector<PrintCheck> &out)
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
    // Hanging, the part's weight peels the first layer off as well: each island carries its share by area.
    double mass = 0, first_area = 0;
    if (along(row)) {
        for (const Layer *layer : object.layers())
            mass += layer_mass(*layer);
        for (const ExPolygon &island : first->lslices)
            first_area += unscaled(unscaled(island.area()));
    }
    for (const ExPolygon &island : first->lslices) {
        const BoundingBox bb     = get_extents(island.contour);
        const double      length = unscaled(bb.size()).norm();
        const double      corner = 1. + sharpest_corner(island.contour) / M_PI;
        // The weight on the island per area (MPa: N/mm^2); the same for every island of a part.
        const double      peel   = first_area > 0. ? 1. + mass * 1e-3 * STANDARD_GRAVITY / first_area / PEEL_REF_MPA : 1.;
        const double      score  = length * shrink_pct * corner * chamber_factor * brim_factor * raft_factor * peel / 60.;
        if (score < 1.)
            continue;
        const Point c = island.contour.centroid();
        out.push_back(make_check(object, "warp-risk", score >= 2.5 ? "critical" : "warning", "brim", unscaled(c), first->print_z,
                                 "Corners may lift (warp risk " + fixed(score, 1) + (along(row) ? ", weight peeling" : "") + ")", score));
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

// ---- Overhangs steeper than the printer's angle ---------------------------------------------------------------

// Each layer against the one about 1 mm below, grown by that height times tan(angle): what sticks out further is
// steeper than the angle (from vertical). A run of layers is one issue, at its largest area; with supports on,
// they hold it (and hanging, support_interface_check looks at how).
void overhang_checks(const PrintObject &object, const GravityRow &row, std::vector<PrintCheck> &out)
{
    if (object.config().enable_support.value)
        return;
    const auto layers = object.layers();
    const double     tan_a  = std::tan(row.overhang_deg * M_PI / 180.);
    struct Run {
        double area = 0, z = 0;
        Vec2d  at   = Vec2d::Zero();
    };
    std::vector<Run> runs;
    bool             open = false;
    for (size_t i = 1; i < layers.size(); ++i) {
        const Layer *layer = layers[i];
        if (layer->regions().empty() || layer->lslices.empty()) {
            open = false;
            continue;
        }
        size_t j = i;
        while (j > 0 && layer->print_z - layers[j - 1]->print_z < 1.0 - EPSILON)
            --j;
        j = j > 0 ? j - 1 : 0;
        const double     w     = layer->regions().front()->flow(frExternalPerimeter).width();
        const double     reach = (layer->print_z - layers[j]->print_z) * tan_a;
        const ExPolygons steep = opening_ex(diff_ex(layer->lslices, offset_ex(layers[j]->lslices, float(scaled(reach)))), float(scaled(0.5 * w)));
        double           area  = 0;
        const ExPolygon *largest = nullptr;
        for (const ExPolygon &piece : steep)
            if (double a = unscaled(unscaled(piece.area())); a > area) {
                area    = a;
                largest = &piece;
            }
        if (largest == nullptr || area < 2. * w * w) {
            open = false;
            continue;
        }
        if (!open) {
            runs.emplace_back();
            open = true;
        }
        Run &run = runs.back();
        if (area > run.area) {
            run.area = area;
            run.z    = layer->print_z;
            run.at   = unscaled(largest->contour.centroid());
        }
    }
    std::sort(runs.begin(), runs.end(), [](const Run &a, const Run &b) { return a.area > b.area; });
    if (runs.size() > MAX_RUNS_PER_OBJECT)
        runs.resize(MAX_RUNS_PER_OBJECT);
    for (const Run &run : runs)
        out.push_back(make_check(object, "overhang", "warning", "supports", run.at, run.z,
                                 "Overhang steeper than " + fixed(row.overhang_deg, 0) + "\u00b0" + (along(row) ? " sags towards the nozzle" : "") +
                                     provisional(row),
                                 run.area));
}

// ---- Roofs over print-in-place gaps ---------------------------------------------------------------------------

// A layer's area that is not over the layer below (a roof's first layer), and under it, within 1 mm, the part
// again: a gap that a one-layer roof closes. Upright, the roof sags into a gap under the printer's limit and
// fuses with the part beneath; hanging, it sags away from it, so the rule is the M1 row's (to calibrate).
void roof_gap_checks(const PrintObject &object, const GravityRow &row, std::vector<PrintCheck> &out)
{
    const auto layers = object.layers();
    for (size_t i = 2; i < layers.size(); ++i) {
        const Layer *layer = layers[i];
        if (layer->regions().empty() || layer->lslices.empty())
            continue;
        const double     w    = layer->regions().front()->flow(frExternalPerimeter).width();
        const ExPolygons roof = opening_ex(diff_ex(layer->lslices, layers[i - 1]->lslices), float(scaled(0.5 * w)));
        if (roof.empty())
            continue;
        for (size_t j = i - 1; j-- > 0;) {
            const double gap = layer->bottom_z() - layers[j]->print_z;
            if (gap > 1.0 + EPSILON)
                break;
            const ExPolygons under = intersection_ex(roof, layers[j]->lslices);
            double           area  = 0;
            const ExPolygon *largest = nullptr;
            for (const ExPolygon &piece : under)
                if (double a = unscaled(unscaled(piece.area())); a > area) {
                    area    = a;
                    largest = &piece;
                }
            if (largest == nullptr || area < 2. * w * w)
                continue;
            if (gap < row.roof_fuse_mm - EPSILON)
                add_merged(out, make_check(object, "roof-gap", "warning", "orientation", unscaled(largest->contour.centroid()), layer->print_z,
                                           "Roof over a " + fixed(gap, 2) + " mm gap may fuse with the part below" + provisional(row), gap));
            break;
        }
    }
}

// ---- Hanging mass behind a thin neck (gravity along the build direction) ---------------------------------------

// Hanging from the bed, each section carries everything printed after it, while still warm. Its stress is the
// weight over the section, plus the bending of that weight's offset and of a sideways sway (HANG_SWAY of the
// weight, at the hanging mass's height) on a round section of the same area:
//   sigma = W / A * (1 + 4 (e + k L) / r)
// The worst section over HANG_REF_MPA is the issue (provisional, to calibrate on M1 prints). Turning the part so
// the heavy end is printed first (near the bed) is the fix.
void hanging_mass_checks(const PrintObject &object, std::vector<PrintCheck> &out)
{
    const auto layers = object.layers();
    if (layers.size() < 2)
        return;
    double m = 0, mz = 0, worst = 0, worst_mass = 0, worst_area = 0;
    Vec2d  mxy = Vec2d::Zero(), worst_at = Vec2d::Zero();
    double worst_z = 0;
    for (size_t i = layers.size(); i-- > 1;) {
        const Layer *above = layers[i];
        double       area  = 0;
        Vec2d        first_moment = Vec2d::Zero();
        for (const ExPolygon &island : above->lslices) {
            const SectionProps p = section_props(island);
            area += p.area;
            first_moment += p.area * p.centroid;
        }
        const double dm = area * above->height * FILAMENT_DENSITY;
        m += dm;
        mz += dm * (above->print_z - above->height / 2.);
        mxy += above->height * FILAMENT_DENSITY * first_moment;
        const Layer *section = layers[i - 1];
        double       a       = 0;
        Vec2d        c       = Vec2d::Zero();
        for (const ExPolygon &island : section->lslices) {
            const SectionProps p = section_props(island);
            a += p.area;
            c += p.area * p.centroid;
        }
        if (a <= 0. || m <= 0.)
            continue;
        c /= a;
        const double weight_n = m * 1e-3 * STANDARD_GRAVITY;
        const double r        = std::sqrt(a / M_PI);
        const double lever    = std::max(0., mz / m - section->print_z);
        const double e        = (mxy / m - c).norm();
        const double stress   = weight_n / a * (1. + 4. * (e + HANG_SWAY * lever) / r);
        const double index    = stress / HANG_REF_MPA;
        if (index > worst) {
            worst      = index;
            worst_mass = m;
            worst_area = a;
            worst_at   = c;
            worst_z    = section->print_z;
        }
    }
    if (worst < 0.3)
        return;
    out.push_back(make_check(object, "hanging-mass", worst >= 1. ? "critical" : "warning", "orientation", worst_at, worst_z,
                             "Heavy part hangs from a thin neck: " + fixed(worst_mass, 0) + " g on " + fixed(worst_area, 0) + " mm\u00b2 (to calibrate)",
                             worst));
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

const char *gravity_name(Gravity gravity) { return gravity == Gravity::AlongBuild ? "along_build" : "against_build"; }

Gravity gravity_of_machine_json(const std::string &machine_json)
{
    // Text that does not parse is prepare_config's to report.
    const nlohmann::json root = nlohmann::json::parse(machine_json, nullptr, /* allow_exceptions */ false);
    if (root.is_discarded() || !root.is_object() || !root.contains("gravity"))
        return Gravity::AgainstBuild;
    const nlohmann::json &value = root["gravity"];
    if (value.is_string() && value.get<std::string>() == "along_build")
        return Gravity::AlongBuild;
    if (value.is_string() && value.get<std::string>() == "against_build")
        return Gravity::AgainstBuild;
    throw std::invalid_argument("The printer preset's \"gravity\" must be \"along_build\" or \"against_build\".");
}

std::vector<PrintCheck> run_print_checks(Print &print, const GCodeProcessorResult &gcode, Gravity gravity)
{
    const GravityRow       &row = row_of(gravity);
    std::vector<PrintCheck> out;
    for (PrintObject *object : print.objects_mutable()) {
        if (print.canceled()) throw Slic3r::CanceledException();
        stability_checks(*object, row, out);
        curl_checks(*object, row, out);
        warp_checks(*object, row, out);
        overhang_checks(*object, row, out);
        roof_gap_checks(*object, row, out);
        if (along(row))
            hanging_mass_checks(*object, out);
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
